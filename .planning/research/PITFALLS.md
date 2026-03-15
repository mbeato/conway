# Domain Pitfalls

**Domain:** API billing, user accounts, and API key auth for existing pay-per-call API platform
**Researched:** 2026-03-15
**Context:** Adding Stripe billing, user accounts, API key auth, and pre-paid credits to APIMesh (Bun/Hono/SQLite, 21 APIs, currently x402-only)

---

## Critical Pitfalls

Mistakes that cause data loss, security breaches, or require rewrites.

### Pitfall 1: Credit Balance Race Conditions (Concurrent API Calls)

**What goes wrong:** Two API calls arrive simultaneously for the same user. Both read `balance_cents >= cost`, both pass the check, both deduct. User ends up with a negative balance or gets a free API call.

**Why it happens:** The design doc specifies `BEGIN TRANSACTION` for check-and-deduct, but SQLite WAL mode allows concurrent reads. If the balance check (`SELECT balance_cents`) and deduction (`UPDATE balance_cents`) are not in a single `IMMEDIATE` transaction, two readers can both see sufficient balance before either writes. SQLite's default transaction mode is `DEFERRED`, which only acquires a write lock when the first write statement executes -- by then both transactions have already read the stale balance.

**Consequences:** Negative balances, revenue leakage, user trust erosion. At scale, automated agents hitting APIs in burst could systematically exploit this.

**Prevention:**
- Use `BEGIN IMMEDIATE` (not `BEGIN` or `BEGIN DEFERRED`) for all credit deduction transactions. This acquires the write lock immediately, serializing concurrent deductions.
- Perform the balance check and deduction in a single SQL statement: `UPDATE credit_balances SET balance_cents = balance_cents - ? WHERE user_id = ? AND balance_cents >= ?` and check `changes()` to confirm exactly 1 row was updated.
- Never separate the SELECT (check) from the UPDATE (deduct) into two statements, even inside a transaction -- the single-statement approach eliminates the TOCTOU window entirely.
- Add a CHECK constraint: `CHECK (balance_cents >= 0)` on the `credit_balances` table as a database-level backstop.

**Detection:** Periodic reconciliation query: `SELECT user_id FROM credit_balances WHERE balance_cents < 0`. Also compare `SUM(amount_cents)` from `credit_transactions` against `balance_cents` for each user -- mismatches indicate a race condition occurred.

**Phase:** Must be addressed in the credit deduction middleware implementation (Phase: API Key Auth + Credit Deduction). This is the single most dangerous pitfall in the entire milestone.

**Confidence:** HIGH -- SQLite WAL concurrency behavior is well-documented; the CONCERNS.md already flags this pattern.

---

### Pitfall 2: Stripe Webhook Double-Granting Credits

**What goes wrong:** Stripe sends the same `checkout.session.completed` webhook multiple times (network timeout, retry, or race with redirect). Each delivery grants credits, resulting in the user receiving 2x or 3x the purchased amount.

**Why it happens:** Stripe explicitly retries webhooks that don't receive a 200 response within a few seconds. If your handler is slow (e.g., waiting on a SQLite write lock), Stripe retries before the first attempt completes. The design doc mentions idempotency via `stripe_payment_intent` column, but a subtle failure mode exists: if the first handler starts the transaction but hasn't committed yet when the retry arrives, the idempotency check (`SELECT ... WHERE stripe_payment_intent = ?`) returns no rows because the first insert is uncommitted.

**Consequences:** Users receive free credits. Revenue loss proportional to purchase volume.

**Prevention:**
- Add a `UNIQUE` constraint on `credit_transactions.stripe_payment_intent` (for non-null values). The second INSERT will fail at the database level regardless of application logic.
- Return 200 to Stripe immediately, then process asynchronously -- or accept the write serialization and let the UNIQUE constraint catch retries.
- Log all webhook deliveries (including duplicates) to `auth_events` for audit.
- Do NOT rely solely on application-level checks (`SELECT WHERE payment_intent = ?`) -- these are vulnerable to the transaction timing gap described above.

**Detection:** Query for duplicate `stripe_payment_intent` values in `credit_transactions`. Alert if any webhook event_id appears more than once in auth_events within 60 seconds.

**Phase:** Stripe webhook handler implementation. Add the UNIQUE constraint in the migration phase.

**Confidence:** HIGH -- Stripe's own documentation explicitly warns about this; the design doc's idempotency approach is necessary but insufficient without the UNIQUE constraint.

---

### Pitfall 3: Email Enumeration via Timing Side-Channel

**What goes wrong:** Despite the design doc specifying "constant-time dummy hash" for non-existent emails on login, subtle timing differences still leak whether an account exists:
1. **Signup:** The design says "same response shape + timing" but creating a user row + sending an email takes measurably longer than the dummy path.
2. **Password reset:** Sending an email vs. not sending one creates a timing difference visible to an attacker making many requests.
3. **Verification code resend:** Same issue -- email send adds 100-300ms that's detectable statistically.

**Why it happens:** Developers focus on the login path (Argon2id dummy verify) but forget that every auth endpoint leaks email existence through whether it performs expensive side effects (DB writes, email sends).

**Consequences:** Attacker builds a list of valid email addresses, enabling targeted credential stuffing, phishing, or social engineering.

**Prevention:**
- For login: the dummy Argon2id verify in the design doc is correct. Ensure it uses the same Argon2id parameters (not a faster hash).
- For signup with existing email: still send an email (e.g., "Someone tried to create an account with your email. If this was you, try logging in."). This makes both paths take the same time.
- For password reset with non-existent email: introduce a small random delay (100-400ms) to blur the timing difference. The response must be identical regardless.
- For resend-code: same approach -- always return 200, add a random delay on the no-user path.
- Rate limit all auth endpoints aggressively (already in design doc -- good).

**Detection:** Automated timing analysis tests in the security test suite. Send 100 requests for known-existing and known-nonexistent emails, compare response time distributions. The p50 should be statistically indistinguishable.

**Phase:** Auth implementation phase. Must be baked into every auth endpoint handler, not bolted on later.

**Confidence:** HIGH -- This is a well-known OWASP concern. The PolarLearn Argon2 timing advisory (GHSA-wcr9-mvr9-4qh5) demonstrates real-world exploitation.

---

### Pitfall 4: API Key Leakage in Logs, Error Messages, and Headers

**What goes wrong:** The full API key (`sk_live_...`) appears in server logs, error responses, or is echoed back in HTTP headers. Once in logs, it persists in log aggregation systems, crash dumps, and backups.

**Why it happens:** The existing `shared/logger.ts` logs `client_ip` and `payer_wallet` for every request. When API key auth is added, a natural pattern is to log the key for debugging. Even logging the `Authorization` header (common in error debugging) exposes the key.

**Consequences:** Anyone with log access (or a log leak) gets valid API keys. The $82K Gemini API key theft incident (2026) demonstrated the financial impact.

**Prevention:**
- NEVER log the raw API key. Log only the `key_prefix` (first 10 chars) and the `api_key_id` (the database row ID).
- Strip the `Authorization` header from any error response bodies or debug output.
- Add the `key_prefix` and `api_key_id` columns to the `requests` table (alongside the proposed `user_id` and `api_key_id` columns in the design doc) so request logs reference keys without exposing them.
- In the API key middleware, immediately hash the key and discard the plaintext from memory. Work only with the hash and the looked-up `api_key_id` from that point forward.

**Detection:** Grep server logs and error response templates for `sk_live_` patterns. Add a test that makes an API call with an invalid key and verifies the key does not appear in the response body.

**Phase:** API key middleware implementation. Also audit `shared/logger.ts` modifications.

**Confidence:** HIGH -- Standard API key security practice; Google's own best practices documentation emphasizes this.

---

### Pitfall 5: Middleware Ordering Bug Breaks x402 Flow

**What goes wrong:** The new `ApiKeyOrX402` middleware incorrectly intercepts requests that should fall through to x402. Common failure modes:
1. Middleware checks for `Authorization` header but some x402 clients also send `Authorization` headers (the x402 payment header). The middleware treats the x402 payment proof as an invalid API key and returns 401.
2. Middleware returns 402 ("insufficient credits") when no API key is present, instead of falling through to x402 which handles its own 402 responses.
3. Error responses from the API key path don't match x402 error format, breaking x402 client retry logic.

**Why it happens:** The design doc shows the middleware branching on "Has Bearer sk_live_?" but the x402 protocol uses `X-Payment` or `X-Payment-Response` headers (not Bearer). If the implementation checks for ANY `Authorization` header rather than specifically `Bearer sk_live_*`, it will collide with other auth mechanisms.

**Consequences:** Zero breaking changes is a stated constraint. Breaking x402 flow means existing users (wallets, MCP integrations) stop working. Since there are currently zero paying credit-card users but existing x402 infrastructure, this regression has 100% downside.

**Prevention:**
- Match ONLY `Authorization: Bearer sk_live_` prefix. Any other `Authorization` header value must fall through untouched.
- Write integration tests that send requests with: (a) valid API key, (b) no auth header (should hit x402), (c) x402 payment headers (should hit x402), (d) invalid Bearer token (should return 401, not hit x402).
- Deploy the middleware change behind a feature flag initially. Run existing x402 test suite before and after.

**Detection:** Existing x402 payment flow stops working in staging/production. Monitor x402 payment success rate before and after deployment.

**Phase:** API key middleware implementation. Test BEFORE deploying to production.

**Confidence:** HIGH -- The dual-auth-path design is the riskiest integration point. The x402 protocol uses non-standard headers, making collision unlikely IF the implementation is precise, but easy to get wrong.

---

## Moderate Pitfalls

### Pitfall 6: Session Cleanup Not Automated (SQLite Table Bloat)

**What goes wrong:** The `sessions` table accumulates expired rows indefinitely. With 30-day expiry and sliding window, sessions that are abandoned (user never returns) persist as dead rows. The `verification_codes` table accumulates expired codes. Over months, these tables grow to millions of rows, slowing index lookups.

**Prevention:**
- Run a cleanup job on a `setInterval` (similar to the existing rate-limit cleanup pattern): `DELETE FROM sessions WHERE expires_at < datetime('now')` every 5 minutes.
- Same for `verification_codes`: `DELETE FROM verification_codes WHERE expires_at < datetime('now')`.
- Add an index on `sessions.expires_at` (already in design doc -- good) and `verification_codes.expires_at`.
- Consider PRAGMA auto_vacuum=INCREMENTAL to reclaim space from deleted rows.

**Phase:** Session management implementation. Add cleanup timers alongside the session middleware.

**Confidence:** HIGH -- Direct observation from existing codebase: the rate-limit module already has a setInterval cleanup pattern that should be replicated.

---

### Pitfall 7: Argon2id Cost Parameters Too Low or Too High

**What goes wrong:** Bun's `Bun.password.hash()` uses default Argon2id parameters. If defaults are too low, passwords are crackable. If too high, login/signup takes 2+ seconds, causing timeouts under load (especially since SQLite write locks are held during registration).

**Prevention:**
- Explicitly set Argon2id parameters rather than relying on Bun defaults: `memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1` (OWASP 2024 minimum recommendation).
- Benchmark on the production server: `Bun.password.hash()` should complete in 200-500ms. Under 100ms means parameters are too weak. Over 1000ms means login will feel sluggish.
- Do NOT hold a database transaction open while hashing. Hash first, then open the transaction to insert the user row.

**Phase:** Auth implementation. Benchmark during development.

**Confidence:** MEDIUM -- Bun's default Argon2id parameters are reasonable but not documented as stable across versions.

---

### Pitfall 8: Verification Code Brute-Force via Multiple Code Generation

**What goes wrong:** The design doc limits each code to 3 attempts. But an attacker can call `/auth/resend-code` to generate a new code, then get 3 more attempts on the new code. With rate limiting of 1 per 60s per email and 5 per IP per hour, an attacker gets 5 codes * 3 attempts = 15 guesses per hour per IP. A 6-digit code has 1,000,000 combinations, so this is still safe for a single IP. But distributed across many IPs (botnet), the rate adds up.

**Prevention:**
- The current rate limits (5/hr per IP) are adequate for casual attacks.
- Track total verification attempts per user across ALL codes (not just per-code). Lock the account temporarily after 10 total failed verification attempts in 1 hour.
- Consider 8-digit codes instead of 6-digit for a 100x improvement in brute-force resistance with minimal UX impact.
- Delete ALL existing codes when generating a new one (design doc already specifies this -- good, prevents parallel code attacks).

**Phase:** Email verification implementation.

**Confidence:** MEDIUM -- The design doc's rate limits make this impractical for single-attacker scenarios, but worth hardening for distributed attacks.

---

### Pitfall 9: Credit Balance Desynchronization from Ledger

**What goes wrong:** The `credit_balances.balance_cents` (denormalized) drifts from `SUM(credit_transactions.amount_cents)` (source of truth). This happens when: a transaction insert succeeds but the balance update fails (partial transaction commit), or a manual admin adjustment is made to one but not the other, or a bug in the deduction path updates balance without inserting a transaction.

**Prevention:**
- ALWAYS update both `credit_transactions` and `credit_balances` in the same SQLite transaction. Never update one without the other.
- Add a reconciliation check that runs daily (or on every balance read for safety): `SELECT user_id, balance_cents, (SELECT COALESCE(SUM(amount_cents), 0) FROM credit_transactions WHERE user_id = cb.user_id) as computed FROM credit_balances cb WHERE balance_cents != computed`. Alert on any mismatch.
- If a mismatch is found, the ledger (`credit_transactions`) is authoritative. Auto-correct `credit_balances` from the ledger sum.
- Add a `/admin/reconcile` endpoint that runs this check on demand.

**Phase:** Credit system implementation. Reconciliation check should be built alongside the credit deduction logic, not as an afterthought.

**Confidence:** HIGH -- Denormalized balance + append-only ledger is the correct pattern, but drift is inevitable without automated reconciliation.

---

### Pitfall 10: SQLite Migration Failures Swallowed Silently

**What goes wrong:** The existing codebase uses `try { db.exec("ALTER TABLE...") } catch {}` for migrations. The design doc adds 7 new tables and indexes. If a migration fails (disk full, corrupted schema, typo in SQL), the empty catch swallows the error. The application starts with a partial schema, causing cryptic failures later (e.g., "no such table: sessions" on first login attempt).

**Prevention:**
- Build a proper migration runner (`shared/migrate.ts` is in the design doc's file list -- good). Each migration should:
  1. Have a version number
  2. Track applied migrations in a `schema_migrations` table
  3. Run inside a transaction (SQLite supports transactional DDL)
  4. Fail loudly with `process.exit(1)` if a migration fails -- better to not start than to start with broken schema
- For the existing `ALTER TABLE` migrations, check `PRAGMA table_info(requests)` for column existence before attempting ALTER.
- Test migrations against a fresh database AND against the existing production schema.

**Detection:** Application crashes on first auth-related request with "no such table" errors.

**Phase:** First phase (database migration). This is prerequisite infrastructure for everything else.

**Confidence:** HIGH -- The CONCERNS.md already flags this exact issue (`try/catch {}` pattern in `shared/db.ts`).

---

### Pitfall 11: Cookie-Based Auth Doesn't Work for MCP/CLI Clients

**What goes wrong:** The account dashboard uses session cookies (`httpOnly; Secure; SameSite=Strict`). But MCP server integration and CLI-based API consumption use `Authorization: Bearer sk_live_...` headers. If any account management endpoint (e.g., checking balance, listing keys) requires session cookies, MCP/CLI users cannot access their account programmatically.

**Prevention:**
- Keep a clear separation: API endpoints (subdomains) accept Bearer API keys. Account management endpoints (/auth/*, /account/*, /billing/*) require session cookies for browser-based access.
- Add a `/auth/me` endpoint that accepts EITHER session cookie OR API key, returning the user profile and balance. This lets MCP clients check their remaining credits.
- Do NOT require session cookies for billing balance checks -- API key holders need to know their balance programmatically.

**Phase:** Account endpoints implementation. Design the auth middleware to accept both cookie and Bearer token for read-only account info endpoints.

**Confidence:** MEDIUM -- The design doc mentions MCP key auth for API calls but doesn't address programmatic account access.

---

## Minor Pitfalls

### Pitfall 12: zxcvbn Bundle Size Impact

**What goes wrong:** The `zxcvbn` library is ~800KB minified (includes dictionaries for password strength estimation). It's the only new dependency, but it's loaded server-side for password validation during signup and password change -- two infrequent operations. If imported at the top level of a shared module, it's loaded into memory for every API request.

**Prevention:**
- Dynamic import: `const { default: zxcvbn } = await import("zxcvbn")` only in the signup and password-change handlers.
- Or accept the memory cost (~2MB resident) since it's a single Bun process serving everything.

**Phase:** Auth implementation. Minor optimization.

**Confidence:** HIGH -- zxcvbn's size is well-documented.

---

### Pitfall 13: Sliding Window Session Expiry Causes Write Amplification

**What goes wrong:** The design doc specifies "sliding window: refresh on each request" for session expiry. This means every authenticated request (including API calls with session cookie) triggers an `UPDATE sessions SET expires_at = ? WHERE id = ?`. With 21 APIs and active users, this adds a write per request to the already write-contended SQLite database.

**Prevention:**
- Only refresh the session expiry if it's within 20% of its remaining lifetime (e.g., if 30-day session has < 6 days remaining, refresh). This reduces writes by ~80% while maintaining the UX benefit.
- Session expiry updates are non-critical -- if one fails, the session still works for the remaining time.

**Phase:** Session middleware implementation.

**Confidence:** MEDIUM -- Depends on traffic volume. Low risk at current scale, but good practice.

---

### Pitfall 14: Stripe Webhook Endpoint Not Excluded from CSP/CORS

**What goes wrong:** The webhook endpoint (`POST /billing/webhook`) receives requests from Stripe's servers, not from browsers. If Caddy or Hono middleware applies CORS headers or CSP restrictions, the webhook requests may be rejected or the raw body may be modified (e.g., by body parsing middleware), breaking signature verification.

**Prevention:**
- The design doc mentions "Webhook gets own handler (no CSP, allows larger body)" -- good.
- Ensure the webhook route is registered BEFORE any body-parsing middleware. Stripe signature verification requires the raw request body. If Hono's `json()` middleware parses the body first, the raw bytes are consumed and unavailable for HMAC verification.
- Exclude `/billing/webhook` from session auth middleware, CORS middleware, and rate limiting (Stripe handles its own rate limiting).

**Phase:** Stripe integration phase. Easy to get right if addressed during route registration.

**Confidence:** HIGH -- This is one of the most common Stripe integration mistakes.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Database migrations | Silent migration failures (#10) | Build proper migration runner first; fail loudly |
| User auth (signup/login) | Email enumeration timing (#3) | Constant-time all paths; send emails on both branches |
| Email verification | Brute-force via code regeneration (#8) | Track total attempts per user, not just per code |
| Session management | Table bloat from expired sessions (#6) | Automated cleanup on interval |
| Session middleware | Write amplification from sliding window (#13) | Only refresh when expiry is close |
| API key middleware | x402 flow breakage (#5) | Match only `Bearer sk_live_` prefix; integration test both paths |
| API key middleware | Key leakage in logs (#4) | Log only prefix + ID; strip from error responses |
| Credit deduction | Race condition on balance (#1) | `BEGIN IMMEDIATE` + single-statement UPDATE with WHERE clause |
| Stripe webhook | Double credit grant (#2) | UNIQUE constraint on payment_intent column |
| Stripe webhook | Body parsing breaks signature (#14) | Register webhook route before body-parsing middleware |
| Credit system | Balance-ledger desync (#9) | Automated reconciliation; ledger is source of truth |
| Account endpoints | No programmatic access for MCP users (#11) | Allow API key auth on balance/profile endpoints |

---

## Sources

- [SQLite Concurrent Writes and Locking](https://sqlite.org/lockingv3.html) -- Official SQLite documentation on write serialization and WAL mode
- [SQLite Concurrent Writes and "database is locked" errors](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/) -- Detailed analysis of SQLite write contention
- [Stripe Webhook Handling: Idempotency, Retries, Validation](https://medium.com/@sohail_saifii/handling-payment-webhooks-reliably-idempotency-retries-validation-69b762720bf5) -- Webhook idempotency patterns
- [Stripe Idempotent Requests API Reference](https://docs.stripe.com/api/idempotent_requests) -- Official Stripe idempotency documentation
- [Designing Robust APIs with Idempotency (Stripe Engineering)](https://stripe.com/blog/idempotency) -- Stripe's own guide to idempotent systems
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) -- Session security best practices
- [User Enumeration via Argon2 Timing Attack (GHSA-wcr9-mvr9-4qh5)](https://github.com/polarnl/PolarLearn/security/advisories/GHSA-wcr9-mvr9-4qh5) -- Real-world Argon2 timing attack advisory
- [Google API Keys Best Practices](https://docs.cloud.google.com/docs/authentication/api-keys-best-practices) -- API key security patterns
- [Dev stunned by $82K Gemini API key bill](https://www.theregister.com/2026/03/03/gemini_api_key_82314_dollar_charge/) -- Real-world API key theft consequences
- [How to Implement Credit-Based Billing for AI Companies](https://www.runonatlas.com/blog-posts/how-to-implement-credit-based-billing-for-ai-companies-a-complete-guide) -- Credit system design patterns
- [Modern Treasury: Designing Ledgers with Concurrency Control](https://www.moderntreasury.com/journal/designing-ledgers-with-optimistic-locking) -- Ledger reconciliation patterns
- [Pre-paid Credit-Based Billing with Stripe (Moesif)](https://www.moesif.com/blog/technical/api-development/Pre-paid-Credit-Based-Billing-With-Stripe/) -- Implementation guide for credit billing
- [Zapier: The Developer-Friendly Way to Change Your API Auth](https://zapier.com/engineering/api-auth-migration/) -- Auth migration for existing APIs
- APIMesh CONCERNS.md -- Existing codebase concerns audit (2026-03-15)
- APIMesh Design Doc -- `docs/plans/2026-03-15-stripe-billing-design.md`

---

*Pitfalls audit: 2026-03-15*

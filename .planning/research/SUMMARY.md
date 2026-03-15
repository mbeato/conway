# Project Research Summary

**Project:** APIMesh -- Auth, API Keys, Credits, Stripe Billing
**Domain:** Developer API platform billing and authentication
**Researched:** 2026-03-15
**Confidence:** HIGH

## Executive Summary

APIMesh is adding user accounts, API key authentication, pre-paid credit billing via Stripe, and an account dashboard to an existing 21-API pay-per-call platform currently using x402 crypto payments exclusively. The research confirms that this is an additive middleware insertion, not a rewrite. The existing x402 flow, API handlers, Caddy proxy, and free preview endpoints remain untouched. The new system grafts auth routes onto the dashboard server (port 3000) and inserts a branching middleware into the API router (port 3001) that routes requests to either the API key/credit path or the existing x402 path based on the presence of a `Bearer sk_live_` header.

The recommended approach is minimal-dependency: only one new production dependency (zxcvbn for password strength). Everything else uses Bun built-ins (Argon2id, SQLite, crypto), Hono built-ins (cookie helper, middleware), and direct fetch() calls to external APIs (Stripe, Resend, HIBP). This aligns with the existing codebase philosophy and keeps the attack surface small. The stack choices are well-validated -- Bun's Argon2id meets OWASP recommendations, Hono's cookie helper covers session management, and Stripe Checkout requires only two API interactions total.

The primary risks are: (1) credit balance race conditions from concurrent API calls -- mitigated by atomic single-statement UPDATE with WHERE clause in IMMEDIATE transactions, (2) Stripe webhook double-granting -- mitigated by a UNIQUE constraint on the payment_intent column, and (3) breaking the existing x402 flow with the new middleware -- mitigated by strict prefix matching on `Bearer sk_live_` and comprehensive integration testing of both payment paths. All five critical pitfalls have concrete, well-documented prevention strategies.

## Key Findings

### Recommended Stack

The stack is almost entirely zero-dependency. Bun and Hono provide password hashing (Argon2id), SQLite database, crypto primitives, and cookie management out of the box. External services (Stripe, Resend, HIBP) are accessed via raw fetch() -- no SDKs needed. See `.planning/research/STACK.md` for full details.

**Core technologies:**
- `Bun.password.hash()` (Argon2id): password hashing -- zero deps, OWASP-compliant defaults
- `hono/cookie`: session cookie management -- built into Hono, no extra package
- `bun:sqlite`: all new tables (users, sessions, api_keys, credits) -- already in use, WAL mode enabled
- Stripe REST API via fetch(): checkout sessions + webhook verification -- two API calls total, no SDK
- Resend via fetch(): transactional email -- 3,000/month free tier, single POST endpoint
- HIBP Passwords API via fetch(): breached password check -- free, no API key, k-anonymity model
- `zxcvbn ^4.4.2`: password strength estimation -- only new production dependency
- `crypto.subtle` / `crypto.randomBytes()`: token generation, API key hashing, webhook HMAC -- Bun built-ins

**Critical version requirement:** Pin Stripe API version via `Stripe-Version` header. Verify exact version string from Stripe Dashboard at implementation time.

### Expected Features

See `.planning/research/FEATURES.md` for full analysis with complexity ratings.

**Must have (table stakes):**
- Email+password signup with email verification (6-digit code)
- Login with server-side sessions (httpOnly cookies)
- Password reset with session invalidation
- Multiple API keys per account (create, label, revoke, show-once)
- Pre-paid credit balance with display
- Credit purchase via Stripe Checkout (tier-based with bonuses)
- Usage history / transaction log
- Bearer token auth on API calls with credit deduction
- Rate limiting + progressive account lockout
- Insufficient credits error with balance info (402)

**Should have (differentiators):**
- Unified credit pool for human + AI agent use (same key, same credits)
- Dual payment rails: credit card AND crypto (x402 untouched alongside Stripe)
- Free preview without any account (already built)
- MCP server with API key env var (one credential for 21 tools)
- Low-balance email alerts
- Per-key usage tracking in dashboard

**Defer to v2+:**
- OAuth/social login, 2FA/TOTP, subscriptions, CAPTCHA, admin impersonation, IP allowlisting, account deletion self-service, Stripe Customer Portal, auto-refill, email change self-service, webhook for credit events

### Architecture Approach

The architecture is an additive middleware insertion with clean component boundaries. Auth, credits, API keys, Stripe, and email are separate shared modules with strict dependency rules (auth never touches credits, credits never touches Stripe, no shared module imports from apis/). The new ApiKeyOrX402 branching middleware inspects the Authorization header and routes to either the API key credit-deduction path or the existing x402 chain. See `.planning/research/ARCHITECTURE.md` for data flow diagrams and code patterns.

**Major components:**
1. **Auth Module** (`shared/auth.ts`) -- password hashing, session lifecycle, auth middleware
2. **Credits Module** (`shared/credits.ts`) -- atomic balance deductions, ledger inserts, reconciliation
3. **API Key Module** (`shared/api-key.ts`) -- key generation, hash-based lookup, revocation
4. **Stripe Module** (`shared/stripe.ts`) -- checkout session creation, webhook HMAC verification
5. **Email Module** (`shared/email.ts`) -- verification codes, password reset via Resend
6. **ApiKeyOrX402 Middleware** -- branching middleware that routes to credit deduction or x402
7. **Route Groups** (auth-routes, account-routes, billing-routes) -- mounted on dashboard app

### Critical Pitfalls

See `.planning/research/PITFALLS.md` for all 14 pitfalls with detection strategies.

1. **Credit balance race conditions** -- Use single-statement `UPDATE ... WHERE balance_cents >= ?` in IMMEDIATE transactions. Add `CHECK (balance_cents >= 0)` constraint. Never separate SELECT from UPDATE.
2. **Stripe webhook double-granting** -- Add UNIQUE constraint on `credit_transactions.stripe_payment_intent`. Do not rely solely on application-level idempotency checks.
3. **Email enumeration timing** -- Constant-time all auth paths. Send emails on both existing/non-existing user branches. Add random delays on non-email paths.
4. **API key leakage in logs** -- Never log raw keys. Log only prefix + database ID. Strip Authorization header from error responses.
5. **x402 flow breakage from middleware** -- Match ONLY `Bearer sk_live_` prefix. Integration test all four auth scenarios (valid key, no header, x402 headers, invalid Bearer).

## Implications for Roadmap

### Phase 1: Database and Core Modules
**Rationale:** Everything depends on the database schema and shared modules. They are independently testable with no external dependencies. The migration runner must be built first to avoid silent schema failures (Pitfall #10).
**Delivers:** New tables (users, sessions, api_keys, credit_balances, credit_transactions, verification_codes, auth_events), migration runner, validation module, auth module (Argon2id hashing, session CRUD), credits module (atomic deduction), API key module (generate, hash-lookup, revoke), auth rate limiter.
**Addresses:** Foundation for all table-stakes features
**Avoids:** Silent migration failures (#10), credit race conditions (#1, by implementing atomic deduction correctly from the start), balance-ledger desync (#9, by building reconciliation alongside credits)

### Phase 2: Auth Flows and Email
**Rationale:** Depends on Phase 1 modules. Introduces the first external dependency (Resend). Produces a working auth system testable end-to-end. Auth must exist before billing or API keys can function.
**Delivers:** Signup, email verification, login, logout, password reset, session management with cleanup timer, auth HTML pages (signup.html, login.html)
**Uses:** Auth module, email module, validation module, zxcvbn, HIBP API, Resend API
**Avoids:** Email enumeration (#3), verification brute-force (#8), session table bloat (#6), Argon2id parameter misconfiguration (#7), sliding window write amplification (#13)

### Phase 3: Stripe Billing and Credits
**Rationale:** Depends on Phase 1 credits module. Independent from Phase 2 auth flows (could theoretically parallelize, but billing routes need session auth from Phase 2 to protect checkout). Second external dependency (Stripe).
**Delivers:** Stripe Checkout integration, webhook handler with idempotency, credit purchase flow (4 tiers), billing routes, billing HTML page
**Uses:** Credits module, Stripe module, Resend (for low-balance alerts later)
**Avoids:** Webhook double-granting (#2), webhook body parsing issues (#14)

### Phase 4: API Key Auth Integration
**Rationale:** This is the critical integration point where the new system meets the existing 21 APIs. Requires all Phase 1 modules working. Must be tested exhaustively against both payment paths. Highest regression risk.
**Delivers:** ApiKeyOrX402 branching middleware, API key creation/management routes, account dashboard pages, per-key usage display
**Uses:** API key module, credits module, existing x402 middleware chain
**Avoids:** x402 flow breakage (#5), API key leakage in logs (#4), cookie-only auth blocking MCP users (#11)

### Phase 5: MCP Integration and Polish
**Rationale:** Lowest risk. Consumes the API surface built in Phases 1-4. MCP server changes are minimal (read env var, pass header). Landing page and dashboard polish can iterate quickly.
**Delivers:** MCP server API key support (APIMESH_API_KEY env var), landing page signup CTA, low-balance email alerts, per-key usage breakdown, updated llms.txt and documentation
**Uses:** All modules from prior phases

### Phase Ordering Rationale

- **Strict dependency chain:** Phase 1 is prerequisite for all others. Phase 2 (auth) and Phase 3 (billing) both depend on Phase 1 but are largely independent of each other -- however, billing routes need session auth, so Phase 2 should complete first.
- **Risk-first ordering:** Phase 4 (middleware integration) is the highest-risk phase for regressions. Pushing it to Phase 4 means all supporting modules are battle-tested before the most dangerous integration.
- **Revenue unlock:** Phases 1-3 together unlock the full signup-to-purchase flow. Phase 4 unlocks API usage via credits. Prioritizing these four phases means revenue capability is the earliest possible deliverable.
- **x402 zero-impact guarantee:** By deferring middleware integration to Phase 4, the existing x402 system remains completely untouched through Phases 1-3. Only Phase 4 modifies the API request path.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Stripe):** Verify exact Stripe API version string. Confirm Checkout Session parameters for one-time payments with metadata. Test webhook delivery in Stripe test mode before building handler.
- **Phase 4 (Middleware Integration):** Needs careful analysis of all 21 API middleware chains to determine the cleanest insertion point. Review whether router-level or per-API insertion is cleaner.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Database + Modules):** Well-documented SQLite patterns, Bun built-in crypto. The design doc and ARCHITECTURE.md provide sufficient implementation detail.
- **Phase 2 (Auth Flows):** Standard email+password auth. OWASP cheat sheets cover all edge cases. The STACK.md provides exact code patterns.
- **Phase 5 (MCP + Polish):** Trivial integration. MCP server just reads an env var and passes a header.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies are Bun/Hono built-ins or well-documented APIs. Only one new dependency. Existing codebase validates patterns. |
| Features | HIGH | Feature landscape cross-referenced against OpenAI, Stripe, Resend, and Vercel patterns. Clear consensus on table stakes vs. deferrals. |
| Architecture | HIGH | Architecture analysis grounded in existing codebase structure. Design doc authored by project owner. Component boundaries are clean. |
| Pitfalls | HIGH | All critical pitfalls have documented real-world precedents. Prevention strategies are concrete and code-level. |

**Overall confidence:** HIGH

### Gaps to Address

- **Stripe API version:** The exact version string (`2025-02-24.acacia`) needs verification from the Stripe Dashboard at implementation time. Pin it in code once confirmed.
- **Argon2id benchmark:** Bun's default parameters meet OWASP minimums, but actual timing should be benchmarked on the production server during Phase 2 to ensure 200-500ms range.
- **Middleware insertion strategy:** Phase 4 needs to decide between router-level insertion (cleaner but changes shared code) vs. per-API insertion (more explicit but 21 touch points). The ARCHITECTURE.md recommends a shared factory function -- validate this against the actual router.ts structure during phase planning.
- **Programmatic account access:** The design doc does not address MCP/CLI users checking their balance or managing keys without a browser session. Phase 4 should add a `/auth/me` endpoint accepting either session cookie or API key.
- **zxcvbn loading strategy:** Minor -- decide whether to dynamic-import or accept the ~2MB memory cost. Low impact either way for a server process.

## Sources

### Primary (HIGH confidence)
- Bun password hashing docs -- Argon2id API, defaults, OWASP compliance
- Hono Cookie Helper docs -- setCookie/getCookie/deleteCookie API
- Stripe API reference -- Checkout Sessions, webhook signatures
- Stripe webhook idempotency guide -- retry behavior, signature verification
- OWASP Password Storage Cheat Sheet -- Argon2id parameter recommendations
- OWASP Session Management Cheat Sheet -- session security patterns
- SQLite locking documentation -- WAL mode, IMMEDIATE transactions
- Existing codebase: router.ts, db.ts, x402.ts, spend-cap.ts, logger.ts
- Design doc: docs/plans/2026-03-15-stripe-billing-design.md

### Secondary (MEDIUM confidence)
- Resend pricing page -- 3,000 emails/month free tier
- zxcvbn npm -- v4.4.2, stable but unmaintained
- @zxcvbn-ts/core -- v3.0.4 alternative (not recommended)
- Stripe API version string -- needs verification at implementation time
- Bun Argon2id default parameters -- stable in practice but not guaranteed across Bun versions

### Tertiary (LOW confidence)
- None -- all research areas had multiple corroborating sources

---
*Research completed: 2026-03-15*
*Ready for roadmap: yes*

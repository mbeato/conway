# Architecture Patterns

**Domain:** Auth + Billing + API Key integration into existing API gateway
**Researched:** 2026-03-15

## Recommended Architecture

### High-Level View

```
                                   Internet
                                      |
                                   [Caddy]
                                  TLS + routing
                                 /     |      \
                     apimesh.xyz  *.apimesh.xyz  mcp.apimesh.xyz
                         |              |              |
                   [Dashboard]    [API Router]    [MCP Server]
                   port 3000      port 3001       port 3002
                        |              |
                 +------+------+       |
                 |             |       |
           [Auth Routes]  [Account/   [ApiKeyOrX402 Middleware]
           /auth/*        Billing]          |
                          /account/*   +----+----+
                          /billing/*   |         |
                                   Has Bearer?  No Bearer
                                       |         |
                                  [API Key Auth] [x402 Flow]
                                  credit deduct  (unchanged)
                                       |         |
                                   [API Handler] [API Handler]
                                       |
                                   [SQLite]
                                   data/agent.db
```

### What Changes vs. What Stays

The core insight: this is an **additive middleware insertion**, not a rewrite. The existing system has a clean separation between routing (router.ts), payment (x402 middleware), and business logic (per-API handlers). The new auth+billing system plugs in at the middleware layer without touching any of those boundaries.

**Unchanged:**
- Caddy reverse proxy configuration (Authorization header already passes through)
- API Router subdomain dispatch logic
- Individual API handlers (no code changes)
- x402 payment flow (fallback path when no Bearer token)
- Free preview endpoints
- MCP server architecture (just adds optional header)

**New components grafted onto Dashboard (port 3000):**
- Auth routes (/auth/*)
- Account pages (/account/*)
- Billing routes (/billing/*)

**New middleware inserted into API Router (port 3001):**
- ApiKeyOrX402 branching middleware (replaces direct x402 chain)

## Component Boundaries

| Component | Responsibility | Communicates With | Owns |
|-----------|---------------|-------------------|------|
| **Auth Module** (`shared/auth.ts`) | Password hashing, session create/verify/revoke, auth middleware | SQLite (users, sessions, auth_events tables) | User identity, session lifecycle |
| **API Key Module** (`shared/api-key.ts`) | Key generation, hash-based lookup, revocation | SQLite (api_keys table), Auth Module (user verification) | Key lifecycle, key-to-user mapping |
| **Credits Module** (`shared/credits.ts`) | Balance reads, atomic deductions, ledger inserts, reconciliation | SQLite (credit_balances, credit_transactions tables) | Financial state, transaction integrity |
| **Stripe Module** (`shared/stripe.ts`) | Checkout session creation, webhook signature verification | Stripe API (outbound fetch), Credits Module (grant on webhook) | Payment intent lifecycle |
| **Email Module** (`shared/email.ts`) | Verification codes, password reset codes | Resend API (outbound fetch), SQLite (verification_codes table) | Email delivery, code lifecycle |
| **Validation Module** (`shared/validation.ts`) | Input sanitization, password strength, email format | HIBP API (outbound fetch for pwned check) | Input correctness |
| **Auth Rate Limiter** (`shared/auth-rate-limit.ts`) | Per-endpoint rate limiting for auth flows | In-process state (same pattern as existing rate-limit.ts) | Auth abuse prevention |
| **ApiKeyOrX402 Middleware** (in `apis/router.ts` or per-API) | Route requests to API key path or x402 path | API Key Module, Credits Module, existing x402 chain | Payment path selection |
| **Auth Routes** (`apis/dashboard/auth-routes.ts`) | HTTP endpoints for signup/login/verify/reset | Auth Module, Email Module, Validation Module | Auth API surface |
| **Account Routes** (`apis/dashboard/account-routes.ts`) | HTTP endpoints for key management, settings | Auth Module, API Key Module | Account management API surface |
| **Billing Routes** (`apis/dashboard/billing-routes.ts`) | HTTP endpoints for checkout, webhook, history | Stripe Module, Credits Module | Billing API surface |

### Boundary Rules

1. **Auth Module never touches credits.** It only knows about users and sessions. This keeps auth testable in isolation.
2. **Credits Module never touches Stripe.** It receives "grant N credits to user X" calls. The caller (Stripe webhook handler) is responsible for Stripe-specific logic.
3. **API Key Module never deducts credits.** It resolves "key hash -> user_id + validity". The ApiKeyOrX402 middleware orchestrates the lookup-then-deduct sequence.
4. **Stripe Module never writes to the database directly.** It returns parsed/verified data. The billing route handler calls Credits Module to actually grant credits.
5. **No shared module imports from `apis/`.** Data flows from shared modules upward to route handlers, never sideways.

## Data Flow

### Flow 1: API Request with API Key (new path)

```
1. Client: GET check.apimesh.xyz/check?name=foo
   Headers: Authorization: Bearer sk_live_abc123...

2. Caddy: TLS terminate, forward to localhost:3001
   (Authorization header passes through natively)

3. API Router: Extract subdomain "check", look up registry["check"]

4. Sub-app middleware chain begins:
   a. cors() -- unchanged
   b. rateLimit() -- unchanged, limits by IP
   c. ApiKeyOrX402 middleware:
      - Sees "Authorization: Bearer sk_live_..." header
      - SHA-256 hash the key value
      - Query api_keys WHERE key_hash = <hash> AND revoked = 0
      - Found? Load user: check email_verified = 1, locked_until = null
      - Query credit_balances WHERE user_id = <user_id>
      - Balance >= price_microdollars?
      - YES: BEGIN TRANSACTION
             UPDATE credit_balances SET balance_cents = balance_cents - <price>
             INSERT INTO credit_transactions (type='usage', amount=-<price>, api_key_id, api_name)
             UPDATE api_keys SET last_used_at = now()
             COMMIT
      - Set c.set("user_id", ...) and c.set("api_key_id", ...)
      - Call next()
   d. apiLogger() -- logs request (now enriched with user_id, api_key_id)
   e. Route handler executes business logic
   f. Response returned to client

5. On failure:
   - Invalid/revoked key -> 401 { error: "Invalid API key" }
   - Insufficient credits -> 402 { error: "Insufficient credits", balance: N, required: M }
   - Unverified email -> 403 { error: "Email not verified" }
```

### Flow 2: API Request with x402 (unchanged path)

```
1. Client: GET check.apimesh.xyz/check?name=foo
   Headers: X-PAYMENT: <x402 payment proof>

2. Same as today. ApiKeyOrX402 middleware sees no Bearer header,
   falls through to existing extractPayerWallet -> spendCap -> paymentMiddleware chain.

3. Completely unchanged. Zero impact on existing x402 users.
```

### Flow 3: Signup -> Purchase Credits -> Use API

```
Phase A: Account Creation
  POST /auth/signup { email, password }
    -> validation.ts: check email format, password strength, HIBP
    -> auth.ts: Argon2id hash, create user row
    -> email.ts: generate code, send via Resend
    -> Return 201

  POST /auth/verify { email, code }
    -> auth.ts: verify hashed code, set email_verified = 1
    -> auth.ts: create session, set cookie
    -> Return 200

Phase B: Credit Purchase
  POST /billing/checkout { tier: "builder" }  (session cookie)
    -> auth middleware: verify session cookie -> user
    -> stripe.ts: create Checkout Session via Stripe API
    -> Return { checkout_url }
    -> Browser redirects to Stripe hosted page

  [User completes payment on Stripe]

  POST /billing/webhook (from Stripe)
    -> stripe.ts: verify signature (HMAC, timestamp)
    -> Check idempotency (payment_intent not already processed)
    -> credits.ts: BEGIN TRANSACTION
       INSERT credit_transactions (type='purchase', +2200000)
       UPDATE credit_balances += 2200000
       COMMIT
    -> Return 200

Phase C: API Key Creation
  POST /auth/keys { label: "production" }  (session cookie)
    -> auth middleware: verify session
    -> api-key.ts: generate sk_live_<random>, SHA-256 hash, store hash
    -> Return { key: "sk_live_abc...", prefix: "sk_live_abc", label: "production" }
    -> Key shown once, never stored in plaintext

Phase D: API Usage
  (See Flow 1 above)
```

### Flow 4: Stripe Webhook (credit grant)

```
Stripe -> POST /billing/webhook
  |
  v
[Raw body read] -- MUST read raw body before any parsing for signature verification
  |
  v
[Verify HMAC signature] -- stripe.ts: constant-time compare, reject if timestamp > 5 min
  |
  v
[Parse event] -- Extract checkout.session.completed
  |
  v
[Idempotency check] -- SELECT FROM credit_transactions WHERE stripe_payment_intent = ?
  |
  v (not duplicate)
[Atomic credit grant] -- credits.ts: transaction { insert ledger row, update balance }
  |
  v
[Return 200] -- Stripe retries on non-200, idempotency prevents double-grant
```

## Patterns to Follow

### Pattern 1: Branching Middleware (ApiKeyOrX402)

**What:** A single middleware that inspects the request and routes to one of two authentication paths.

**When:** Always on paid API routes. This replaces the current direct-to-x402 chain.

**Why this over two separate middleware stacks:** Keeps the per-API code unchanged. Each API still just applies middleware and defines handlers. The branching happens once, at the shared middleware level.

```typescript
// shared/api-key-or-x402.ts
import type { MiddlewareHandler } from "hono";
import { verifyApiKey } from "./api-key";
import { deductCredits } from "./credits";

export function apiKeyOrX402(priceUsd: number): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader?.startsWith("Bearer sk_live_")) {
      // API key path
      const key = authHeader.slice(7);
      const result = verifyApiKey(key);
      if (!result.valid) return c.json({ error: result.error }, 401);

      const deducted = deductCredits(result.userId, priceUsd, {
        apiKeyId: result.keyId,
        apiName: c.get("apiName"),
      });
      if (!deducted.success) {
        return c.json({
          error: "Insufficient credits",
          balance: deducted.balance,
          required: deducted.required,
        }, 402);
      }

      c.set("userId", result.userId);
      c.set("apiKeyId", result.keyId);
      c.set("paymentMethod", "api_key");
      return next();
    }

    // No API key -> fall through to x402 (existing middleware handles it)
    return next();
  };
}
```

**Integration point:** This middleware inserts BEFORE the existing `spendCapMiddleware()` and `paymentMiddleware()` calls in each API. When it handles the request (API key path), it calls `next()` which skips the x402 chain. When it doesn't handle it (no Bearer), the existing x402 chain runs as before.

### Pattern 2: Atomic Credit Deduction

**What:** Check-and-deduct in a single SQLite transaction to prevent race conditions.

**When:** Every API key-authenticated request.

**Why:** SQLite serializes writes at the database level, but we need the check+deduct to be atomic. Without a transaction, two concurrent requests could both read "balance = 10", both deduct 5, leaving balance at 0 instead of the correct 5.

```typescript
// shared/credits.ts
import db from "./db";

const deductStmt = db.prepare(`
  UPDATE credit_balances
  SET balance_cents = balance_cents - ?, updated_at = datetime('now')
  WHERE user_id = ? AND balance_cents >= ?
`);

const insertTxStmt = db.prepare(`
  INSERT INTO credit_transactions (id, user_id, type, amount_cents, api_key_id, api_name, created_at)
  VALUES (?, ?, 'usage', ?, ?, ?, datetime('now'))
`);

const deductTransaction = db.transaction((userId: string, amountCents: number, apiKeyId: string, apiName: string) => {
  const result = deductStmt.run(amountCents, userId, amountCents);
  if (result.changes === 0) return false; // insufficient balance
  insertTxStmt.run(crypto.randomUUID(), userId, -amountCents, apiKeyId, apiName);
  return true;
});

export function deductCredits(userId: string, priceUsd: number, meta: { apiKeyId: string; apiName: string }) {
  const amountCents = Math.round(priceUsd * 1_000_000); // microdollars
  const success = deductTransaction(userId, amountCents, meta.apiKeyId, meta.apiName);
  // ...
}
```

**Key detail:** The `WHERE balance_cents >= ?` clause in the UPDATE makes the check atomic with the deduction. If balance is insufficient, `changes === 0` and no row is modified.

### Pattern 3: Session Middleware as Hono Middleware

**What:** Standard Hono middleware that reads session cookie, validates, and sets context.

**When:** All /account/* and /billing/* routes (except /billing/webhook which uses Stripe signature auth).

```typescript
// shared/auth.ts
export function requireSession(): MiddlewareHandler {
  return async (c, next) => {
    const sessionId = getCookie(c, "session_id");
    if (!sessionId) return c.json({ error: "Not authenticated" }, 401);

    const session = db.query("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')").get(sessionId);
    if (!session) return c.json({ error: "Session expired" }, 401);

    const user = db.query("SELECT * FROM users WHERE id = ? AND email_verified = 1").get(session.user_id);
    if (!user) return c.json({ error: "Not authenticated" }, 401);
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return c.json({ error: "Account locked" }, 403);
    }

    // Sliding window: refresh expiry
    db.run("UPDATE sessions SET expires_at = datetime('now', '+30 days') WHERE id = ?", [sessionId]);

    c.set("user", user);
    c.set("session", session);
    return next();
  };
}
```

### Pattern 4: Route Group Mounting

**What:** Auth, account, and billing routes defined in separate files, mounted onto the dashboard Hono app.

**When:** Dashboard initialization.

```typescript
// apis/dashboard/index.ts (additions)
import { authRoutes } from "./auth-routes";
import { accountRoutes } from "./account-routes";
import { billingRoutes } from "./billing-routes";

app.route("/auth", authRoutes);
app.route("/account", accountRoutes);
app.route("/billing", billingRoutes);
```

**Why:** Keeps the dashboard index.ts from ballooning. Each route group is independently testable.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Middleware in Every API File

**What:** Copying ApiKeyOrX402 middleware setup into each of the 21 API `index.ts` files.

**Why bad:** 21 copies to maintain. Miss one and that API silently doesn't support API keys. Any bug fix requires 21 edits.

**Instead:** Apply the branching middleware at the router level (in `apis/router.ts`) before delegating to sub-apps, or create a shared factory function that each API imports. The design doc's approach of modifying the middleware chain in each API is acceptable only if it's a single import. Given the current pattern where each API defines its own middleware stack, the cleanest approach is a shared wrapper that replaces the `spendCapMiddleware() + paymentMiddleware()` pair with a single `apiKeyOrX402(price) + spendCapMiddleware() + paymentMiddleware()` triplet, where apiKeyOrX402 short-circuits when a valid key is present.

### Anti-Pattern 2: Checking Balance Outside the Transaction

**What:** Reading balance first, then deducting in a separate statement.

**Why bad:** Classic TOCTOU race. Two concurrent requests read balance=10, both see "sufficient", both deduct 5, balance goes to 0 instead of one being rejected.

**Instead:** Use the `WHERE balance_cents >= ?` pattern inside the UPDATE (Pattern 2 above). The database enforces atomicity.

### Anti-Pattern 3: Storing API Keys in Plaintext

**What:** Saving the full `sk_live_...` key in the database for easy lookup.

**Why bad:** Database compromise = all keys compromised = all user accounts exploitable.

**Instead:** Store SHA-256 hash only. Hash the incoming key on each request and look up by hash. This is fast (SHA-256 is ~100ns) and means a DB leak doesn't leak keys.

### Anti-Pattern 4: Webhook Without Idempotency

**What:** Granting credits on every webhook call without checking for duplicates.

**Why bad:** Stripe retries webhooks on timeout/failure. Network issues can cause duplicate delivery. Without idempotency, users get free credits.

**Instead:** Store `stripe_payment_intent` in credit_transactions. Check for existence before granting. The unique constraint prevents double-insertion even under concurrent webhook delivery.

### Anti-Pattern 5: JWT for Sessions

**What:** Using JWTs instead of server-side sessions.

**Why bad for this use case:** Can't instantly revoke (password reset, account lock, key compromise). Need token refresh logic. Larger cookie size. All for what benefit? The app already uses SQLite -- session lookup is sub-millisecond.

**Instead:** Server-side sessions in SQLite. Instant revocation. Simple cookie. Already have the database.

## Component Dependency Graph (Build Order)

```
Layer 0 (no new dependencies):
  shared/validation.ts       -- pure functions, no DB
  shared/auth-rate-limit.ts  -- same pattern as existing rate-limit.ts

Layer 1 (database only):
  shared/migrate.ts          -- creates new tables, depends on shared/db.ts
  shared/auth.ts             -- depends on db (users, sessions, auth_events)
  shared/credits.ts          -- depends on db (credit_balances, credit_transactions)
  shared/api-key.ts          -- depends on db (api_keys)

Layer 2 (external APIs):
  shared/email.ts            -- depends on Resend API (outbound fetch)
  shared/stripe.ts           -- depends on Stripe API (outbound fetch)

Layer 3 (route handlers, compose Layer 0-2):
  apis/dashboard/auth-routes.ts     -- depends on auth, email, validation, rate-limit
  apis/dashboard/account-routes.ts  -- depends on auth, api-key
  apis/dashboard/billing-routes.ts  -- depends on auth, credits, stripe

Layer 4 (middleware integration):
  shared/api-key-or-x402.ts         -- depends on api-key, credits
  Modified: apis/router.ts or per-API index.ts -- adds new middleware

Layer 5 (MCP integration):
  Modified: mcp-server/server.ts    -- reads APIMESH_API_KEY env
  Modified: mcp-server/http.ts      -- passes Authorization header

Layer 6 (frontend):
  apis/dashboard/signup.html, login.html, etc.
  apis/dashboard/account.html, account.js
  Modified: apis/landing/landing.html
```

### Suggested Build Order (phases)

**Phase 1: Foundation (Layer 0 + Layer 1)**
Build: DB migrations, validation, auth module (Argon2id, sessions), credits module, API key module.
Why first: Everything else depends on these. They're independently testable with in-memory SQLite. No external API calls needed. This is pure backend work.

**Phase 2: Auth Flows + Email (Layer 2 + Layer 3 partial)**
Build: Email module (Resend), auth routes (signup, login, verify, reset, logout).
Why second: Builds on Phase 1 auth module. Introduces first external dependency (Resend). Produces a working auth system that can be tested end-to-end.

**Phase 3: Billing (Layer 2 + Layer 3 partial)**
Build: Stripe module, billing routes (checkout, webhook), credit purchase flow.
Why third: Depends on credits module from Phase 1. Second external dependency (Stripe). Can test with Stripe test mode. Users can now sign up AND buy credits.

**Phase 4: API Key Auth Integration (Layer 4)**
Build: ApiKeyOrX402 middleware, integrate into API router or per-API middleware chains.
Why fourth: This is the critical integration point. Requires auth + credits + api-key modules all working. Must be tested against all 21 APIs to verify zero regression on x402 flow.

**Phase 5: Account Dashboard + MCP (Layer 5 + Layer 6)**
Build: Account pages (HTML/JS), MCP server API key support, landing page update.
Why last: Frontend and MCP changes are the least risky. They consume the API surface built in Phases 1-4. Can be iterated quickly.

### Critical Dependencies

- Phase 2 REQUIRES Phase 1 (auth routes need auth module)
- Phase 3 REQUIRES Phase 1 (billing needs credits module)
- Phase 4 REQUIRES Phase 1 (middleware needs api-key + credits)
- Phase 2 and Phase 3 are PARALLELIZABLE (independent after Phase 1)
- Phase 5 REQUIRES Phases 2, 3, 4 (needs all backend working)

## Scalability Considerations

| Concern | Current (100 req/day) | At 10K req/day | At 1M req/day |
|---------|----------------------|----------------|---------------|
| Session lookups | SQLite sub-ms | SQLite sub-ms (indexed) | Consider Redis or in-process LRU cache |
| API key lookups | SQLite sub-ms | SQLite sub-ms (indexed by hash) | In-process LRU cache (keys don't change often) |
| Credit deductions | SQLite WAL handles fine | SQLite WAL serialization may bottleneck | Move to Postgres for row-level locking |
| Webhook processing | Synchronous, fine | Synchronous, fine | Queue (but Stripe rate limits you anyway) |
| Rate limiting | In-process maps | In-process maps | Need shared state if multi-process |

**Honest assessment:** SQLite handles the current and foreseeable scale (well into 10K req/day territory). The single-process Bun architecture means no shared state problems. If/when scale demands it, the migration path is: add in-process caching for hot reads (sessions, keys) -> move to Postgres for write contention -> add Redis for rate limiting if multi-process. But that's a problem for 100x current traffic.

## Sources

- Existing codebase analysis: `apis/router.ts`, `shared/db.ts`, `shared/x402.ts`, `shared/spend-cap.ts`, `apis/web-checker/index.ts`
- Design doc: `docs/plans/2026-03-15-stripe-billing-design.md` (HIGH confidence -- authored by project owner)
- Current architecture doc: `.planning/codebase/ARCHITECTURE.md` (HIGH confidence)
- Hono middleware patterns: standard Hono middleware composition (HIGH confidence -- matches existing codebase patterns)
- SQLite transaction semantics: Bun SQLite `db.transaction()` (HIGH confidence -- documented in bun:sqlite)
- Stripe Checkout + webhook patterns: standard Stripe integration (HIGH confidence -- well-documented, widely used)

---

*Architecture analysis: 2026-03-15*

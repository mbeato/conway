# Technology Stack: Stripe Billing & User Accounts

**Project:** APIMesh — Auth, API Keys, Credits, Stripe Billing
**Researched:** 2026-03-15
**Mode:** Ecosystem (stack dimension for auth + billing milestone)

---

## Recommended Stack

The design doc already makes strong, well-reasoned technology choices. This research validates those decisions and fills in specific versions, parameters, and gotchas.

### Password Hashing

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `Bun.password.hash()` / `Bun.password.verify()` | Bun built-in | Argon2id password hashing | Zero dependencies. OWASP-recommended algorithm. Bun wraps Zig's std.crypto.pwhash under the hood. Hash includes algorithm + params, so verify needs no config. | HIGH |

**Critical detail:** Bun's defaults are memoryCost=65536 (64 MiB), timeCost=2, parallelism=1. These meet OWASP minimum recommendations (19 MiB memory, 2 iterations, 1 parallelism). Use defaults -- do not lower them.

**Usage:**
```typescript
// Hash (async, returns PHC string with embedded params)
const hash = await Bun.password.hash(password, "argon2id");

// Verify (async, constant-time internally)
const valid = await Bun.password.verify(password, hash);
```

**Do NOT use:** `argon2` npm package (native addon, build complexity), `bcrypt`/`bcryptjs` (weaker than Argon2id, not memory-hard).

### Session Tokens & Crypto

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `crypto.randomBytes()` | Node.js built-in (Bun-compatible) | Session token generation | 32 bytes hex = 64 char tokens. Cryptographically secure. No dependency needed. | HIGH |
| `crypto.subtle.digest("SHA-256", ...)` | Web Crypto API (Bun-compatible) | API key hashing, verification code hashing | Web standard, zero deps. Already used in codebase (`apis/mock-jwt-generator/jwt.ts`). | HIGH |
| `crypto.timingSafeEqual()` | Node.js built-in (Bun-compatible) | Constant-time comparison for webhook signatures, codes | Prevents timing attacks. Essential for Stripe webhook verification and auth code comparison. | HIGH |

**Do NOT use:** `uuid` package for session IDs (random hex is simpler and equally secure), `jsonwebtoken` for sessions (JWT cannot be revoked without a blocklist, defeating the purpose).

### Cookie Management

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `hono/cookie` | Included with Hono 4.x | Set/get/delete session cookies | Built into Hono. Provides `setCookie`, `getCookie`, `deleteCookie` with full options (httpOnly, secure, sameSite, maxAge, path). No extra dependency. | HIGH |

**Usage:**
```typescript
import { setCookie, getCookie, deleteCookie } from "hono/cookie";

// Set session cookie
setCookie(c, "session_id", token, {
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  path: "/",
  maxAge: 60 * 60 * 24 * 30, // 30 days
});
```

**Do NOT use:** `@jcs224/hono-sessions` (adds encrypted cookie storage overhead -- we store sessions in SQLite, cookie is just a lookup key), `@hono/session` (JWT-based, wrong model for server-side sessions).

### Password Strength

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `zxcvbn` | ^4.4.2 | Password strength estimation | Server-side only, so the 800KB bundle size is irrelevant. The original Dropbox library is battle-tested and has the most comprehensive dictionary. Last published 8+ years ago but the algorithm is stable -- password estimation doesn't need updates. | MEDIUM |

**Alternative considered:** `@zxcvbn-ts/core` (v3.0.4) is the modern TypeScript rewrite with tree-shaking and language packs. However: it requires additional `@zxcvbn-ts/language-common` and `@zxcvbn-ts/language-en` packages, setup is more verbose (must configure options before use), and the original works fine server-side. The design doc specifies `zxcvbn ^4.4.2` -- stick with it.

**If you want TypeScript types:** Install `@types/zxcvbn` (v4.4.5) as a dev dependency.

**Do NOT use:** Client-side password strength checks alone (must validate server-side to prevent bypass).

### Transactional Email

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Resend (via `fetch()`) | REST API | Verification codes, password reset emails | Developer-friendly API, single `fetch()` call per email. Free tier: 3,000 emails/month (more than sufficient for early stage). No SDK needed -- one POST to `https://api.resend.com/emails`. | HIGH |

**Free tier:** 3,000 emails/month. Paid: $20/mo for 50K emails. No overage charges -- you get notified to upgrade.

**Usage:**
```typescript
await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    from: "APIMesh <noreply@apimesh.xyz>",
    to: email,
    subject: "Your verification code",
    html: `<p>Your code is: <strong>${code}</strong></p>`,
  }),
});
```

**Required setup:** Verify domain `apimesh.xyz` in Resend dashboard (add DNS records: SPF, DKIM, DMARC).

**Do NOT use:** AWS SES (requires IAM setup, more complex), SendGrid (heavier, unnecessary), nodemailer (needs SMTP server), Postmark (more expensive free tier).

### Stripe Billing

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Stripe REST API (via `fetch()`) | API version 2025-latest | Checkout Sessions, webhook verification | The design doc correctly avoids the `stripe` npm SDK (71 files, ~2MB). All needed operations are 2-3 REST calls: create checkout session, verify webhook signature. fetch() is cleaner for this scope. | HIGH |

**API calls needed (exhaustive list):**

1. **Create Checkout Session** -- `POST https://api.stripe.com/v1/checkout/sessions`
2. **Webhook signature verification** -- Manual HMAC-SHA256 (no API call)

That's it. Two interactions with Stripe total.

**Webhook verification pattern:**
```typescript
import { timingSafeEqual } from "crypto";

function verifyStripeWebhook(
  payload: string,
  signature: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  const parts = signature.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>);

  const timestamp = parts["t"];
  const expectedSig = parts["v1"];

  // Check timestamp tolerance (replay attack prevention)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > toleranceSeconds) return false;

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const hmac = crypto.createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  // Constant-time comparison
  return timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedSig));
}
```

**Headers required for all Stripe API calls:**
```typescript
{
  "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
  "Content-Type": "application/x-www-form-urlencoded", // Stripe uses form encoding, not JSON
  "Stripe-Version": "2025-02-24.acacia", // Pin API version
  "Idempotency-Key": idempotencyKey, // For POST requests
}
```

**Critical gotcha:** Stripe API uses `application/x-www-form-urlencoded`, NOT JSON. Request bodies must use `URLSearchParams`, not `JSON.stringify`.

**Do NOT use:** `stripe` npm package (72 files, unnecessary weight for 2 API calls), Payment Intents directly (Checkout Sessions handle the full flow), Stripe Elements (we redirect to hosted Checkout).

### Database

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `bun:sqlite` | Bun built-in | All new tables (users, sessions, api_keys, credits, etc.) | Already in use (`shared/db.ts`). WAL mode already enabled. Transactions are atomic -- critical for credit deductions. No additional dependency. | HIGH |

**Critical for credits:** Use `BEGIN IMMEDIATE` transactions for credit deductions to prevent TOCTOU race conditions. SQLite's default `BEGIN DEFERRED` can allow two concurrent reads before either writes.

```typescript
db.exec("BEGIN IMMEDIATE");
try {
  const balance = db.query("SELECT balance_cents FROM credit_balances WHERE user_id = ?").get(userId);
  if (balance.balance_cents < cost) { db.exec("ROLLBACK"); return null; }
  db.run("UPDATE credit_balances SET balance_cents = balance_cents - ? WHERE user_id = ?", [cost, userId]);
  db.run("INSERT INTO credit_transactions ...", [...]);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
```

### HIBP Password Check

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| HaveIBeenPwned Passwords API (via `fetch()`) | v3 | Check passwords against breach database | Free, no API key needed. Uses k-anonymity model (send first 5 chars of SHA-1 hash, get back matching suffixes). Zero privacy risk. | HIGH |

**Usage:**
```typescript
const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
const prefix = sha1.slice(0, 5);
const suffix = sha1.slice(5);
const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
const text = await res.text();
const found = text.split("\n").some(line => line.startsWith(suffix));
```

**Do NOT use:** Local breach databases (massive, stale), skip this check (it's one fetch call and meaningfully improves security).

### Rate Limiting

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Custom in-memory rate limiter | N/A | Auth endpoint rate limiting | The codebase already has rate limiting (`shared/` area). Auth rate limits need per-IP and per-email tracking with different windows. A simple Map with TTL cleanup is sufficient. No dependency needed. | HIGH |

**Do NOT use:** `hono-rate-limiter` (adds dependency for something trivially implementable), Redis-based limiters (single server, no need for distributed state).

### Frontend (Account Pages)

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Server-rendered HTML + vanilla JS | N/A | Signup, login, account dashboard, billing pages | Matches existing pattern (dashboard.html, landing.html). No React, no build step. Forms submit via fetch(), pages reload on navigation. Simple, fast, zero JS framework weight. | HIGH |

**Do NOT use:** React (overkill for forms + tables), htmx (adds a dependency for what vanilla fetch handles), Hono JSX (would change the rendering pattern from the existing codebase).

---

## Complete Dependency Summary

### New Production Dependencies

```bash
bun install zxcvbn
```

**That's it. One dependency.** Everything else is Bun built-ins, Hono built-ins, or external APIs via fetch().

### New Dev Dependencies

```bash
bun install -D @types/zxcvbn
```

### Unchanged Dependencies

All existing dependencies remain. No upgrades needed for this milestone.

---

## Environment Variables (New)

```bash
# Stripe
STRIPE_SECRET_KEY=sk_live_...          # From Stripe Dashboard
STRIPE_WEBHOOK_SECRET=whsec_...        # From Stripe Dashboard > Webhooks
STRIPE_PRICE_STARTER=price_...         # Created via Stripe Dashboard or API
STRIPE_PRICE_BUILDER=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_SCALE=price_...

# Resend
RESEND_API_KEY=re_...                  # From Resend Dashboard

# No new infra -- same server, same ports, same Caddy
```

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Password hashing | `Bun.password.hash()` (Argon2id) | `argon2` npm, `bcryptjs` | Native addon build issues / weaker algorithm |
| Sessions | SQLite + httpOnly cookie | JWT tokens | Can't revoke JWTs without a blocklist, defeating purpose |
| Session library | Manual (Hono cookie helper) | `@jcs224/hono-sessions` | Adds dependency; we only need cookie set/get + SQLite lookup |
| Password strength | `zxcvbn` (original) | `@zxcvbn-ts/core` | More packages to install, verbose setup, original works fine server-side |
| Email | Resend (fetch) | AWS SES, SendGrid, Postmark | More complex setup, heavier SDKs, Resend free tier is generous |
| Stripe | Direct fetch() | `stripe` npm SDK | 72 files for 2 API calls; form-encoded POST is trivial |
| Auth framework | Custom | Better Auth, Lucia | Both add significant abstraction over a simple email+password flow; custom is ~300 lines for full auth |
| Rate limiting | In-memory Map | `hono-rate-limiter`, Redis | Single server, trivial to implement, no distributed state needed |
| Frontend | Vanilla HTML + JS | React, htmx, Hono JSX | Matches existing codebase pattern, no build step needed |

---

## Version Pinning Notes

| Technology | Pin Strategy | Notes |
|------------|-------------|-------|
| Hono | `4.12.x` | Already pinned in package.json. Cookie helper is part of core. |
| zxcvbn | `^4.4.2` | Stable, unmaintained but complete. Won't get breaking changes. |
| @types/zxcvbn | `^4.4.5` | Dev only, latest available. |
| Stripe API | `2025-02-24.acacia` | Pin via `Stripe-Version` header. Test before upgrading. |
| Resend API | No versioning | Simple REST, unlikely to break. |
| HIBP API | `v3` (`/range/` endpoint) | Stable for years, no breaking changes expected. |

---

## Stripe API Version Note

Stripe's API versions use a date-based scheme. The `Stripe-Version` header should be set to a specific version string. Verify the latest stable version in the Stripe Dashboard at setup time. The version `2025-02-24.acacia` is based on training data -- confirm the exact current version string from your Stripe Dashboard > Developers > API version before hardcoding.

**Confidence: MEDIUM** -- exact version string should be verified at implementation time.

---

## Sources

- [Bun password hashing docs](https://bun.com/docs/guides/util/hash-a-password) -- Argon2id defaults and API (HIGH confidence)
- [Bun.password API reference](https://bun.com/reference/bun/password) -- Parameter details (HIGH confidence)
- [Hono Cookie Helper](https://hono.dev/docs/helpers/cookie) -- setCookie/getCookie/deleteCookie API (HIGH confidence)
- [Resend pricing](https://resend.com/pricing) -- 3,000 emails/month free tier (HIGH confidence)
- [Stripe API reference](https://docs.stripe.com/api/checkout/sessions/create) -- Checkout Session creation (HIGH confidence)
- [Stripe webhook signature docs](https://docs.stripe.com/webhooks/signature) -- HMAC-SHA256 verification (HIGH confidence)
- [zxcvbn npm](https://www.npmjs.com/package/zxcvbn) -- v4.4.2, 800KB bundle (MEDIUM confidence, unmaintained)
- [@zxcvbn-ts/core npm](https://www.npmjs.com/package/@zxcvbn-ts/core) -- v3.0.4 alternative (MEDIUM confidence)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) -- Argon2id recommendations (HIGH confidence)

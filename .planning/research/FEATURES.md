# Feature Landscape

**Domain:** Developer API platform -- auth, billing, and API key management
**Researched:** 2026-03-15

## Table Stakes

Features users expect. Missing = product feels incomplete or untrustworthy.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Email + password signup | Every API platform has this (Stripe, OpenAI, Resend, Vercel) | Medium | Argon2id already decided. 6-digit verification code is solid -- simpler than magic links, harder to phish |
| Email verification | Prevents spam accounts, required before issuing API keys | Low | Already designed with hashed codes, 10-min expiry, 3-attempt limit |
| Login with session | Developers expect to log in and see a dashboard | Medium | Server-side sessions with httpOnly cookies -- correct choice over JWT for this use case |
| Password reset | Developers lock themselves out constantly | Medium | Must invalidate all sessions on reset (designed correctly) |
| Multiple API keys per account | OpenAI, Stripe, Resend all support this. Developers use separate keys per project/environment | Low | 5-key limit is fine for v1. Resend shows key usage indicators (active vs unused) -- good UX pattern to follow |
| API key labels | Developers need to know which key is which | Low | Already planned. Show prefix + label + last-used |
| Key revocation | Immediate revocation when key is compromised | Low | Soft delete (revoked flag) is correct -- preserves audit trail |
| Show key once at creation | Stripe, OpenAI, Resend all do this. Key shown once, never retrievable again | Low | Already designed with SHA-256 hash storage |
| Pre-paid credit balance display | OpenAI, Anthropic, Google AI all show current balance prominently | Low | Must be visible on every account page, not buried |
| Credit purchase flow | One-click purchase via Stripe Checkout | Medium | Hosted Checkout is correct -- never touch card numbers. Tier-based with bonuses matches OpenAI pattern |
| Usage history / transaction log | OpenAI has detailed usage dashboard. Developers want to see where money went | Medium | credit_transactions table is the ledger. Need per-API-call breakdown (which API, when, cost) |
| Bearer token auth on API calls | Standard pattern: `Authorization: Bearer sk_...` | Low | Already designed. Falls through to x402 if no Bearer header -- elegant |
| Rate limiting on auth endpoints | Prevents brute force. Every platform does this | Medium | Already designed with progressive lockout. Constant-time responses prevent email enumeration |
| Insufficient credits error (402) | Clear error when balance is too low to make a call | Low | Must return remaining balance and cost in error response so developer knows how much to top up |
| Progressive account lockout | Standard security practice after failed login attempts | Low | Already designed: 5 -> 15min, 10 -> 1hr, 20 -> 24hr |

## Differentiators

Features that set APIMesh apart. Not expected, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Unified credit pool (human + AI agent) | Same API key, same credits work in browser dashboard AND MCP server. No split wallets. Developers buy credits once, use everywhere | Low | This is genuinely rare. Most platforms treat programmatic and interactive access separately. Strong selling point for the MCP/AI agent story |
| Dual payment: credit card OR crypto | Keep x402 alongside Stripe. Two payment rails, zero friction either way. Developer chooses | Low (already built) | x402 flow untouched. API key auth is additive. Few platforms offer both |
| Free preview without any account | No signup required to try every API. Free tier returns partial results | Already built | OpenAI requires account for any usage. APIMesh lets you try before signing up -- better funnel |
| MCP server with API key env var | `APIMESH_API_KEY` in MCP config and you're done. AI agents get authenticated access to 21 tools with one credential | Low | No other web analysis API suite offers this pattern. MCP + credits is a unique combo |
| Low-balance email alerts | Email notification when credits drop below a configurable threshold | Low | OpenAI and Anthropic both do this. Prevents surprise service interruption. Easy to implement with Resend already integrated |
| Per-key usage tracking | Track which API key consumed what. OpenAI added this and developers loved it | Medium | Already possible via credit_transactions.api_key_id. Surface it in dashboard |
| Webhook for credit events | Notify developers when credits are purchased, when balance is low, when credits are depleted | Medium | Defer to v2 but design the event system now. Would differentiate from most small API platforms |

## Anti-Features

Features to explicitly NOT build. Each has a clear reason.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| OAuth / social login | Adds complexity (redirect flows, provider outages, token refresh). Email+password is sufficient for an API platform where developers spend 2 minutes signing up | Stick with email+password. Add OAuth only if signup conversion data shows dropoff |
| Subscriptions / monthly plans | Pre-paid credits are simpler, match the pay-per-call model, and avoid failed payment / dunning complexity. OpenAI moved FROM post-pay TO pre-pay for good reasons (revenue predictability, no chargebacks) | Pre-paid credit tiers with volume bonuses. Revisit subscriptions only after 6+ months of usage data |
| 2FA / TOTP in v1 | Meaningful engineering lift (QR codes, backup codes, recovery flow). API keys are the primary auth for API calls anyway -- session compromise gives account access but doesn't bypass key-based billing | Ship without 2FA. Add in v2 once accounts hold meaningful balances. Document the plan |
| CAPTCHA | Rate limits + email verification + progressive lockout handle abuse. CAPTCHA degrades developer experience and is increasingly defeated by bots anyway | Monitor for abuse. Add CAPTCHA reactively only if automated signups become a problem |
| Admin impersonation | Solo operator. Not needed. Security risk if implemented poorly | Use direct DB queries when needed. Add if/when there are support staff |
| IP allowlisting per API key | Enterprise feature. Adds complexity to every API request (IP lookup, CIDR parsing). No demand signal yet | Defer entirely. Add when enterprise customers request it |
| Account deletion self-service | Complex (cascade deletes, data retention, GDPR). Handle manually for now | Add email to support queue. Build self-service when user count exceeds manual capacity |
| Stripe Customer Portal | Overkill for pre-paid credits. Customer Portal is designed for subscriptions with plan changes, cancellations, invoice history | Build a simple billing page that shows balance + purchase history + buy buttons. No subscription management needed |
| Auto-refill / auto-recharge | Risk of unexpected charges, customer complaints, chargeback risk. OpenAI auto-recharge has frustrated users | Manual credit purchases only. Developers are in control. Consider adding opt-in auto-refill later with clear guardrails |
| Email change self-service | Complex re-verification flow (verify new email, handle race conditions, update all references) | Handle manually via support for v1 |

## Feature Dependencies

```
Email verification -> API key creation (must verify before issuing keys)
API key creation -> API key auth middleware (keys must exist to authenticate)
Credit balance system -> Credit deduction middleware (balance must exist to deduct)
Stripe webhook -> Credit grants (credits only granted on confirmed payment)
Session auth -> Account dashboard (must be logged in to view account)
Session auth -> API key management (must be logged in to create/revoke keys)
Session auth -> Credit purchase (must be logged in to buy credits)
Auth event logging -> Security dashboard (events must be captured to display)
```

Dependency chain for first API call via credits:
```
Signup -> Verify email -> Login -> Buy credits (Stripe) -> Webhook grants credits -> Create API key -> Make API call with Bearer token -> Credits deducted
```

## MVP Recommendation

**Phase 1: Auth foundation** (must ship together, nothing works without it)
1. User accounts (signup, verify, login, sessions)
2. Password reset flow
3. Auth security (rate limits, lockout, constant-time, HIBP)

**Phase 2: Billing** (unlocks revenue)
4. Credit balance system + ledger
5. Stripe Checkout integration + webhook
6. Credit purchase tiers

**Phase 3: API access** (the actual product value)
7. API key management (create, list, revoke)
8. API key auth middleware (Bearer token -> credit deduction)
9. MCP server API key support

**Phase 4: Dashboard** (shows value, builds trust)
10. Account overview (balance, keys, usage)
11. Usage history / transaction log
12. Billing page with purchase buttons

**Phase 5: Polish**
13. Low-balance email alerts
14. Per-key usage breakdown
15. Landing page update with signup CTA

**Defer entirely:**
- OAuth, 2FA, subscriptions, CAPTCHA, admin impersonation, IP allowlisting, account deletion, auto-refill, email change

**Rationale:** Auth must come first because everything depends on sessions. Billing comes second because keys without credits are useless. API key auth is the actual product value -- this is what developers are paying for. Dashboard is important but can ship slightly after because developers can start making API calls before the dashboard is polished.

## Sources

- [OpenAI API Usage Dashboard](https://help.openai.com/en/articles/10478918-api-usage-dashboard) -- usage tracking patterns, per-key metrics
- [OpenAI Prepaid Billing](https://help.openai.com/en/articles/8264778-what-is-prepaid-billing) -- pre-pay model validation
- [Resend API Keys](https://resend.com/docs/dashboard/api-keys/introduction) -- key management UX, permission levels, usage indicators
- [Stripe API Keys Documentation](https://docs.stripe.com/keys) -- key format patterns, publishable vs secret
- [Stripe Credits Subscription Model](https://stripe.com/resources/more/what-is-a-credits-based-subscription-model-and-how-does-it-work) -- credits billing patterns
- [API Credits Billing for Startups](https://colorwhistle.com/api-credits-billing-tech-startups/) -- pre-paid vs subscription tradeoffs
- [Usage Based Billing for APIs](https://www.subscriptionflow.com/2025/07/usage-based-billing-for-api-products/) -- billing model comparison
- [Zoho API Usage Alerts](https://help.zoho.com/portal/en/kb/desk/developer-space/apidashboard/articles/working-with-api-usage-alerts) -- alert threshold patterns
- [Best API Management Platforms 2026](https://zuplo.com/learning-center/best-api-management-platforms-2026) -- table stakes features

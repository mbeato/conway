---
phase: 07-api-key-auth-middleware
plan: 01
subsystem: api
tags: [middleware, auth, api-key, x402, credits]

requires:
  - phase: 04-api-keys
    provides: "lookupByHash() for key validation"
  - phase: 05-stripe-billing
    provides: "deductAndRecord() and getBalance() for credit operations"
provides:
  - "apiKeyAuth() middleware function with pricing map for all 21 APIs"
  - "INTERNAL_AUTH_SECRET for x402 payment bypass"
  - "Wrapped paymentMiddleware that skips payment for internal-authed requests"
affects: [07-02, 07-03, 08-01]

tech-stack:
  added: []
  patterns: ["internal auth bypass via X-APIMesh-Internal header", "null-return fallthrough pattern for middleware chaining"]

key-files:
  created: ["shared/api-key-auth.ts"]
  modified: ["shared/x402.ts"]

key-decisions:
  - "INTERNAL_AUTH_SECRET generated in x402.ts (not api-key-auth.ts) to avoid circular imports"
  - "Null return from apiKeyAuth() signals x402 fallthrough (no breaking changes)"
  - "Non-sk_live_ Bearer tokens return null (fall through) to avoid breaking other auth flows"

patterns-established:
  - "Middleware branching: null = pass-through, Response = handled"
  - "Internal auth header pattern for cross-middleware bypass"

requirements-completed: [INT-01, INT-02, INT-05, INT-06]

duration: 3min
completed: 2026-03-18
---

# Plan 07-01: API Key Auth Middleware Summary

**apiKeyAuth() middleware with pricing map for 21 APIs, credit deduction, and x402 payment bypass via wrapped paymentMiddleware**

## Performance

- **Duration:** 3 min
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Created shared/api-key-auth.ts with apiKeyAuth() that validates Bearer sk_live_... tokens, deducts credits, returns X-Credits-Remaining
- API_PRICES map covers all 21 API subdomains with correct microdollar values
- Wrapped paymentMiddleware in x402.ts to skip payment when X-APIMesh-Internal header matches startup secret

## Task Commits

1. **Task 1 + Task 2: Auth middleware and x402 bypass** - `d439674` (feat)

## Files Created/Modified
- `shared/api-key-auth.ts` - API key auth middleware with pricing map, credit deduction, and response augmentation
- `shared/x402.ts` - Wrapped paymentMiddleware with internal auth bypass, INTERNAL_AUTH_SECRET generation

## Decisions Made
- INTERNAL_AUTH_SECRET lives in x402.ts to avoid circular dependency (api-key-auth imports from x402, not vice versa)
- Non-sk_live_ Bearer tokens return null to avoid breaking dashboard auth or other Bearer flows
- Both tasks committed together since x402.ts modification depends on the api-key-auth.ts design

## Deviations from Plan
None - plan executed as specified. The INTERNAL_AUTH_SECRET placement in x402.ts (not api-key-auth.ts) was already specified in the plan's revised approach.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- apiKeyAuth() ready for router integration (07-02)
- INTERNAL_AUTH_SECRET and wrapped paymentMiddleware ready for all 21 APIs

---
*Phase: 07-api-key-auth-middleware*
*Completed: 2026-03-18*

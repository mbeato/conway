---
phase: 01-foundation
plan: 02
subsystem: auth
tags: [argon2id, sessions, api-keys, credits, zxcvbn, validation, sqlite]

# Dependency graph
requires:
  - phase: 01-01
    provides: "13 database tables including users, sessions, api_keys, credit_balances, credit_transactions, auth_events"
provides:
  - "Argon2id password hashing with explicit params via Bun.password.hash/verify"
  - "256-bit crypto-random session management with 30-day sliding + 90-day absolute expiry"
  - "Auth event audit logging with nullable user_id for failed login attempts"
  - "Atomic deductAndRecord() wrapping balance + ledger + last_used_at in IMMEDIATE transaction"
  - "API key generation (sk_live_ + 64 hex), hash-only storage, lookup by hash WHERE revoked = 0"
  - "Email normalization and validation, zxcvbn password strength checking"
  - "initBalance() for signup flow, addCredits() with Stripe idempotency"
affects: [01-03, 02-auth, 03-api-keys, 05-billing]

# Tech tracking
tech-stack:
  added: [zxcvbn]
  patterns: ["All modules accept Database parameter for testability", "BEGIN IMMEDIATE for atomic credit operations", "Hash-only API key storage with partial index lookup"]

key-files:
  created: [shared/auth.ts, shared/validation.ts, shared/credits.ts, shared/api-key.ts, tests/auth.test.ts, tests/credits.test.ts, tests/api-key.test.ts, data/migrations/003_auth_events_nullable_user.sql]
  modified: [package.json]

key-decisions:
  - "Added migration 003 to make auth_events.user_id nullable for failed login attempts on unknown emails"
  - "Used crypto.getRandomValues for session ID generation (Web Crypto API, not Node crypto)"
  - "deductAndRecord uses .immediate() method on Bun's SQLite transaction API for BEGIN IMMEDIATE"
  - "API key max limit of 5 active keys per user enforced at application layer"

patterns-established:
  - "Shared module pattern: pure functions accepting db: Database param, no HTTP dependencies"
  - "TDD with in-memory SQLite: beforeEach creates :memory: db, runs migrate, inserts test fixtures"
  - "User agent capping: slice(0, 512) applied before any INSERT"
  - "Session refresh optimization: only update when within last 25% of sliding window"

requirements-completed: [SESS-01, SESS-07, BILL-06, KEY-02, KEY-04]

# Metrics
duration: 3min
completed: 2026-03-15
---

# Phase 1 Plan 2: Shared Modules Summary

**Argon2id auth, 256-bit sessions, atomic credit deduction, and SHA-256 hash-only API key storage with zxcvbn password validation**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-15T23:34:30Z
- **Completed:** 2026-03-15T23:37:51Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Four shared modules (auth, validation, credits, api-key) with zero HTTP dependencies
- 38 unit tests all passing against in-memory SQLite
- Atomic deductAndRecord with BEGIN IMMEDIATE ensures balance + ledger + last_used_at consistency
- API keys stored as SHA-256 hash only; plaintext never persisted

## Task Commits

Each task was committed atomically:

1. **Task 1: Auth module and validation module** - `f91e7bc` (feat)
2. **Task 2: Credits module and API key module** - `38f0d9c` (feat)

## Files Created/Modified
- `shared/auth.ts` - Password hashing (Argon2id), session CRUD, auth event logging
- `shared/validation.ts` - Email normalization/validation, zxcvbn password strength
- `shared/credits.ts` - Balance management, atomic deduction, transaction ledger
- `shared/api-key.ts` - Key generation (sk_live_), hash-only storage, lookup, revocation
- `tests/auth.test.ts` - 21 tests for auth and validation
- `tests/credits.test.ts` - 9 tests for credit operations
- `tests/api-key.test.ts` - 8 tests for API key operations
- `data/migrations/003_auth_events_nullable_user.sql` - Allow NULL user_id in auth_events
- `package.json` - Added zxcvbn dependency

## Decisions Made
- Added migration 003 to make auth_events.user_id nullable (original schema had NOT NULL but plan requires logging failed logins for unknown emails)
- Used Web Crypto API (crypto.getRandomValues, crypto.randomUUID) instead of Node.js crypto module
- Transaction.immediate() API for BEGIN IMMEDIATE semantics on Bun's SQLite bindings
- Max 5 active API keys per user, enforced in createApiKey before INSERT

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] auth_events.user_id NOT NULL constraint**
- **Found during:** Task 1 (auth module implementation)
- **Issue:** Migration 002 defined auth_events.user_id as TEXT NOT NULL, but logAuthEvent must accept null userId for failed login attempts on unknown emails
- **Fix:** Created migration 003 to recreate auth_events table with nullable user_id (SQLite requires table recreation for column constraint changes)
- **Files modified:** data/migrations/003_auth_events_nullable_user.sql
- **Verification:** logAuthEvent with null userId test passes
- **Committed in:** f91e7bc

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary for correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All four shared modules ready for auth routes (Plan 02-auth) and billing (Plan 05-billing)
- Pattern established: all modules accept Database param for testability
- normalizeEmail() exported separately for use in rate limiter keying
- initBalance() ready for signup flow integration

---
*Phase: 01-foundation*
*Completed: 2026-03-15*

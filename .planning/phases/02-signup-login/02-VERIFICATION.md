---
phase: 02-signup-login
verified: 2026-03-17T00:00:00Z
status: gaps_found
score: 10/12 must-haves verified
re_verification: false
gaps:
  - truth: "Session cookie is httpOnly, Secure, SameSite=Strict with 30-day expiry"
    status: failed
    reason: "The /auth/verify auto-login path creates a session cookie with SameSite=Lax and maxAge of 7 days (604800s) instead of the required SameSite=Strict and 30-day maxAge. Only the /auth/login path is correct."
    artifacts:
      - path: "apis/dashboard/index.ts"
        issue: "Line 470: sameSite: 'Lax' — should be 'Strict'. Line 472: maxAge: 7 * 24 * 60 * 60 — should be 30 * 24 * 60 * 60."
    missing:
      - "Change sameSite from 'Lax' to 'Strict' in the /auth/verify session cookie (line 470)"
      - "Change maxAge from 7 * 24 * 60 * 60 to 30 * 24 * 60 * 60 in the /auth/verify session cookie (line 472)"
  - truth: "Unverified user attempting login gets redirected to /verify"
    status: partial
    reason: "The backend correctly returns 200 with error='email_not_verified' and a redirect URL. However, the response is returned BEFORE the constant-time password verification completes for unverified users — password is verified but the result is not checked for the wrong-password case on unverified accounts, meaning a failed password attempt on an unverified account still redirects to /verify, leaking that the email exists and is unverified. This is a minor timing-safe violation: the plan specified that all branches should be indistinguishable."
    artifacts:
      - path: "apis/dashboard/index.ts"
        issue: "Lines 571-579: passwordValid is computed, but if !user.email_verified the result is ignored and redirect is returned regardless of whether the password was correct. This leaks account existence for unverified accounts via different response semantics."
    missing:
      - "For unverified users, return the /verify redirect only when passwordValid is true; return 401 generic error when password is wrong, to prevent email enumeration of unverified accounts"
human_verification:
  - test: "Visual inspection of all auth pages"
    expected: "signup.html renders dark theme with mesh canvas animation, Space Grotesk font, centered card, live strength bar; login.html renders same theme with error display; verify.html shows 6 separate digit boxes with auto-advance"
    why_human: "Visual appearance and animated canvas cannot be verified programmatically"
  - test: "Full end-to-end signup and login flow"
    expected: "User signs up, receives email with 6-digit code, enters code on /verify, auto-logs in and lands on /account. Then logs out and logs in normally via /login."
    why_human: "Requires real Resend email delivery, browser interaction, and cookie behavior verification"
  - test: "Password strength bar live feedback"
    expected: "Typing in the password field on /signup shows color-coded strength bar updating in real time using zxcvbn scores"
    why_human: "Requires browser interaction"
  - test: "6-digit code auto-advance and paste"
    expected: "Typing a digit in any code-input box advances focus to the next. Pasting 6 digits fills all boxes and auto-submits."
    why_human: "Requires browser interaction"
---

# Phase 2: Signup/Login Verification Report

**Phase Goal:** Complete signup/login auth flow with email verification, session management, and frontend pages
**Verified:** 2026-03-17
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can sign up with email and password, receives a 6-digit verification code via email | VERIFIED | POST /auth/signup at line 314: validates email, password (zxcvbn+HIBP), creates user, calls sendVerificationCode, returns redirect to /verify |
| 2 | User with zxcvbn < 3 or breached password is rejected at signup | VERIFIED | Lines 344-354: validatePassword (delegates to shared/validation.ts) + isPasswordBreached called before user creation |
| 3 | User can verify email by entering the 6-digit code (expires 10min, 3 attempts max) | VERIFIED | POST /auth/verify at line 402: atomic attempt increment with `attempts < 3` guard, expires_at > datetime('now') check, HMAC-SHA256 comparison |
| 4 | User can resend verification code (1/60s per email, 5/hr per IP) | VERIFIED | POST /auth/resend-code at line 481: dual checkAuthRateLimit for 'resend-code-email' and 'resend-code-ip' |
| 5 | Unverified user attempting login is redirected to /verify | PARTIAL | Backend returns redirect, but password validation result is ignored for unverified users — wrong password still redirects, leaking that the account exists unverified |
| 6 | User can log in with valid email and password and receives a session cookie | VERIFIED | POST /auth/login at line 534: constant-time with DUMMY_HASH_PROMISE, setCookie on success |
| 7 | Login with wrong password or unknown email returns identical generic error in constant time | VERIFIED | Unknown email: dummy hash run (line 566). Known email, wrong password: verifyPassword called on real hash (line 572). Both return "Invalid email or password." |
| 8 | Session cookie is httpOnly, Secure, SameSite=Strict with 30-day expiry | FAILED | Login path (line 590-596) is correct: Strict, 30 days. Verify auto-login path (line 467-473) uses Lax and 7 days — violates SESS-02 |
| 9 | Session sliding window refreshes on authenticated requests | VERIFIED | getAuthenticatedUser() at line 623-630 calls refreshSessionExpiry(db, sessionId) on every authenticated request |
| 10 | User can log out and session is destroyed (cookie cleared, DB row deleted) | VERIFIED | POST /auth/logout at line 604: getSession -> deleteSession -> logAuthEvent -> deleteCookie |
| 11 | Signup page at /signup has email + password form with live strength bar | VERIFIED | apis/landing/signup.html: form id="signup-form", strength-container with strength-fill and strength-label, zxcvbn.js loaded |
| 12 | Verify page at /verify shows 6 separate digit input boxes with auto-advance and auto-submit | VERIFIED | apis/landing/verify.html: 6x .code-input elements; auth.js initCodeInputs(): auto-advance on input, backspace nav, paste handling, checkAutoSubmit |

**Score:** 10/12 truths verified (2 failed/partial)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `shared/hibp.ts` | HIBP k-anonymity password breach check | VERIFIED | 61 lines, exports isPasswordBreached, SHA-1 prefix split, 5s timeout, fail-open |
| `tests/hibp.test.ts` | HIBP module unit tests | VERIFIED | 5 tests, all passing (confirmed via bun test run) |
| `apis/dashboard/index.ts` | POST /auth/signup, /verify, /resend-code, /auth/login, /auth/logout, GET /account, /signup, /login, /verify, /auth.js, /zxcvbn.js | VERIFIED | All routes present, placed before bearerAuth middleware at line 701 |
| `apis/landing/signup.html` | Signup page with email/password form and strength bar | VERIFIED | Full page with mesh canvas, Space Grotesk + JetBrains Mono, strength bar, confirm password field |
| `apis/landing/login.html` | Login page with email/password form | VERIFIED | Full page with mesh canvas, cross-links to signup, forgot-password link |
| `apis/landing/verify.html` | Verification page with 6-digit code input widget | VERIFIED | 6x .code-input elements, resend-btn, email-display span |
| `apis/landing/auth.js` | Shared JS: form handlers, code widget, strength bar | VERIFIED | initStrengthBar, initCodeInputs, initSignupForm, initLoginForm, initResend, initLogout, initMesh — all implemented |
| `apis/landing/account.html` | Placeholder account page for post-login redirect | VERIFIED | Welcome page with logout-btn, loads auth.js |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| apis/dashboard/index.ts | shared/hibp.ts | isPasswordBreached call in signup | WIRED | Line 14: import, line 351: called in signup |
| apis/dashboard/index.ts | shared/auth.ts | hashPassword, verifyPassword, createSession, getSession, deleteSession, refreshSessionExpiry, logAuthEvent | WIRED | Line 9: all imported, all called in respective handlers |
| apis/dashboard/index.ts | shared/email.ts | sendVerificationCode call | WIRED | Line 11: import, lines 394, 528: called |
| apis/dashboard/index.ts | shared/credits.ts | initBalance call on signup | WIRED | Line 12: import, line 377: called in signup |
| apis/dashboard/index.ts | hono/cookie | setCookie, getCookie, deleteCookie | WIRED | Line 4: import, lines 467, 590, 607, 617, 625: all called |
| apis/landing/auth.js | POST /auth/signup | fetch call on signup form submit | WIRED | Line 378: fetch('/auth/signup', ...) in initSignupForm |
| apis/landing/auth.js | POST /auth/login | fetch call on login form submit | WIRED | Line 427: fetch('/auth/login', ...) in initLoginForm |
| apis/landing/auth.js | POST /auth/verify | fetch call on code auto-submit | WIRED | Line 262: fetch('/auth/verify', ...) in submitVerification |
| apis/landing/signup.html | apis/landing/auth.js | script src="/auth.js" | WIRED | Line 252: `<script src="/auth.js" defer>` |
| apis/landing/verify.html | apis/landing/auth.js | script src="/auth.js" | WIRED | Line 248: `<script src="/auth.js" defer>` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| AUTH-01 | 02-01 | User can sign up with email and password (Argon2id, min 12 chars, zxcvbn >= 3) | SATISFIED | POST /auth/signup: validatePassword (zxcvbn) + hashPassword (Argon2id via shared/auth.ts) |
| AUTH-02 | 02-01 | Password checked against HaveIBeenPwned at signup (k-anonymity) | SATISFIED | isPasswordBreached called at line 351, using SHA-1 k-anonymity range API |
| AUTH-03 | 02-01 | User receives 6-digit verification code via email after signup | SATISFIED | generateVerificationCode() + sendVerificationCode() at lines 380-394 |
| AUTH-04 | 02-01 | User can verify email by 6-digit code (expires 10min, 3 attempts max) | SATISFIED | POST /auth/verify: expires_at > datetime('now'), atomic attempt guard at line 446-453 |
| AUTH-05 | 02-01 | User can resend verification code (1/60s/email, 5/hr/IP) | SATISFIED | POST /auth/resend-code: dual rate-limit zones 'resend-code-email' and 'resend-code-ip' |
| AUTH-06 | 02-02 | User can log in with email and password (constant-time, no email enumeration) | SATISFIED | POST /auth/login: DUMMY_HASH_PROMISE for unknown emails, same branch for wrong password |
| AUTH-08 | 02-02 | User can log out and have session destroyed | SATISFIED | POST /auth/logout: deleteSession + deleteCookie |
| SESS-02 | 02-02 | Session cookie is httpOnly, Secure, SameSite=Strict, 30-day expiry | PARTIAL | Login path correct; verify auto-login path uses Lax + 7 days — requirement NOT fully met |
| SESS-03 | 02-02 | Session expiry uses sliding window | SATISFIED | getAuthenticatedUser() calls refreshSessionExpiry on every authenticated request |
| FE-01 | 02-03 | Signup page at /signup with email + password form | SATISFIED | apis/landing/signup.html: form with email, password, confirm password, strength bar |
| FE-02 | 02-03 | Login page at /login with email + password form | SATISFIED | apis/landing/login.html: form with email and password inputs, cross-links |
| FE-08 | 02-03 | All account pages use server-rendered HTML + vanilla JS (no React) | SATISFIED | All 5 pages are plain HTML files with inline CSS and external vanilla JS only |
| FE-09 | 02-03 | Design matches existing landing page (Space Grotesk, JetBrains Mono, dark theme) | SATISFIED | All pages use identical CSS variables (--bg: #090909, --surface: #0f0f0f), same font imports |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| apis/dashboard/index.ts | 470-473 | Auto-login session cookie uses `sameSite: "Lax"` and `maxAge: 7 * 24 * 60 * 60` | Blocker | Violates SESS-02: cookie is weaker than required after email verification path |
| apis/dashboard/index.ts | 574-579 | Unverified user redirect returned without checking passwordValid | Warning | Minor enumeration risk: wrong password on unverified account reveals account exists |

### Human Verification Required

#### 1. Visual inspection of all auth pages

**Test:** Start server with `bun run apis/dashboard/index.ts` and visit /signup, /login, /verify in a browser.
**Expected:** Dark background (#090909), centered card with mesh canvas animation visible and animating, APIMesh wordmark, Space Grotesk font for headings, JetBrains Mono for inputs.
**Why human:** Animated canvas, font rendering, and visual layout cannot be verified programmatically.

#### 2. Full end-to-end signup and verification flow

**Test:** Sign up with a valid email, receive the code (requires Resend/SMTP configured), enter code on /verify, confirm auto-login to /account.
**Expected:** Email arrives within 30 seconds, code entry on /verify redirects to /account, /account shows the placeholder page.
**Why human:** Requires real email delivery, browser cookie handling, and session state.

#### 3. Password strength bar live feedback

**Test:** On /signup, type a weak password ("abc"), then a strong one ("correct-horse-battery-staple").
**Expected:** Bar appears, transitions from red (Weak) to green (Strong) with live color and label updates.
**Why human:** Requires browser interaction with DOM events.

#### 4. Six-digit code widget behavior

**Test:** On /verify, type digits one at a time, then try pasting a 6-digit number.
**Expected:** Focus auto-advances per digit. Paste fills all 6 boxes and triggers auto-submit.
**Why human:** Requires browser interaction for focus, input, and clipboard events.

### Gaps Summary

Two issues block full goal achievement:

**Gap 1 — Session cookie inconsistency (SESS-02 violation, blocker):** The `/auth/verify` endpoint creates an auto-login session cookie with `sameSite: "Lax"` and `maxAge: 7 days`. The plan and requirement SESS-02 mandate `SameSite=Strict` and 30-day expiry. The `/auth/login` endpoint is already correct. This is a two-line fix on lines 470 and 472 of `apis/dashboard/index.ts`.

**Gap 2 — Unverified user enumeration (partial, warning):** When a user with an unverified account submits a wrong password, the backend currently returns the `/verify` redirect regardless, revealing that an account exists at that email address but is unverified. The plan specifies that timing and responses should be indistinguishable across all cases. Fixing this requires checking `passwordValid` before returning the redirect for unverified users.

Gap 1 is a clean requirement violation. Gap 2 is a security property deviation from the plan specification. Both are isolated to `apis/dashboard/index.ts`.

---

*Verified: 2026-03-17*
*Verifier: Claude (gsd-verifier)*

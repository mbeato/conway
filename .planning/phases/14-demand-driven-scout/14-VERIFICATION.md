---
phase: 14-demand-driven-scout
verified: 2026-04-07T23:40:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 14: Demand-Driven Scout Verification Report

**Phase Goal:** Scout selects API build targets using real market demand data, producing a backlog where high-scoring items reflect actual developer search interest and competitive gaps
**Verified:** 2026-04-07T23:40:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                          | Status     | Evidence                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Scout queries external data sources (DataForSEO or Google Autocomplete fallback) for keyword search volume | ✓ VERIFIED | `dataforseo.ts` POSTs to `api.dataforseo.com/v3/dataforseo_labs/google/search_volume/live`; `autocomplete.ts` falls back to `suggestqueries.google.com`; `gatherDemandData()` in scout.ts wires both |
| 2   | Backlog items include real demand data (search volume, marketplace listings, competitor gaps)   | ✓ VERIFIED | `008_demand_columns.sql` adds 5 columns; `insertBacklogItem` extended with `demandData?` param; scout.ts calls it with `search_volume`, `measured_demand_score`, `demand_source`, `category` |
| 3   | Scoring model demonstrably weights measured demand signals (0.25) higher than LLM-estimated demand (0.10) | ✓ VERIFIED | `scoring.ts:25-26`: `demandWeight = hasMeasured ? 0.10 : 0.20`, `measuredWeight = hasMeasured ? 0.25 : 0`; weights sum to 1.0 in both branches |
| 4   | Brain supports themed expansion weeks where scout focuses on a configured category             | ✓ VERIFIED | `scout-config.ts` exports `loadScoutConfig()` and `isThemeWeekActive()`; scout.ts injects `THEME WEEK: Focus 3 of your 5 suggestions on '...'` into LLM prompt when active; `data/scout-config.json` has `theme_week` with `enabled: false` and required `end_date` |
| 5   | High-scoring backlog items (overall_score > 7.5) trigger gpt-4.1 model escalation for the build step | ✓ VERIFIED | `build.ts:9,11,934`: `ESCALATION_MODEL = "gpt-4.1"`, `ESCALATION_THRESHOLD = 7.5`, `model = item.overall_score > ESCALATION_THRESHOLD ? ESCALATION_MODEL : DEFAULT_MODEL`; `model` is passed to `generateApi()` which uses it at line 210 |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact                                         | Expected                                     | Status     | Details                                                       |
| ------------------------------------------------ | -------------------------------------------- | ---------- | ------------------------------------------------------------- |
| `scripts/brain/demand/dataforseo.ts`             | DataForSEO keyword volume client             | ✓ VERIFIED | Exports `getKeywordVolumes`, `KeywordVolume`; env-gated; `AbortSignal.timeout(15_000)` |
| `scripts/brain/demand/autocomplete.ts`           | Google Autocomplete fallback                 | ✓ VERIFIED | Exports `getAutocompleteSuggestions`; parses `[query, [suggestions]]` format |
| `scripts/brain/demand/rapidapi.ts`               | RapidAPI marketplace demand signals          | ✓ VERIFIED | Exports `getRapidApiDemand`, `MarketplaceDemand`; returns null on failure |
| `scripts/brain/demand/competitors.ts`            | Competitor gap analysis                      | ✓ VERIFIED | Exports `analyzeCompetitorGaps`; static registry with SecurityTrails, BuiltWith, Qualys, Screaming Frog, Snyk |
| `scripts/brain/demand/devto-feedback.ts`         | Dev.to engagement signal collector           | ✓ VERIFIED | Exports `getDevtoEngagement`, `getCategoryInterest`; env-gated on `DEVTO_API_KEY` |
| `scripts/brain/demand/scoring.ts`                | Weighted scoring formula                     | ✓ VERIFIED | Exports `computeOverallScore`, `normalizeDemandSignal`; weights documented |
| `scripts/brain/scout-config.ts`                  | Theme week config loader                     | ✓ VERIFIED | Exports `loadScoutConfig` (async Bun.file), `isThemeWeekActive`, `ScoutConfig`, `ThemeWeek` |
| `data/scout-config.json`                         | Theme week and demand source configuration   | ✓ VERIFIED | Contains `theme_week` and `demand_sources` keys; `enabled: false` safe default |
| `data/migrations/008_demand_columns.sql`         | Backlog schema extension                     | ✓ VERIFIED | 5 `ALTER TABLE backlog` statements for demand columns |
| `shared/db.ts`                                   | BacklogItem interface + insertBacklogItem extended | ✓ VERIFIED | `BacklogItem` has 5 new nullable fields; `insertBacklogItem` accepts optional `demandData?` |
| `scripts/brain/build.ts`                         | Model escalation for high-scoring items      | ✓ VERIFIED | `ESCALATION_MODEL`, `ESCALATION_THRESHOLD = 7.5`, daily cap query, `model` passed to `generateApi()` |

### Key Link Verification

| From                       | To                                       | Via                                       | Status     | Details                                                                 |
| -------------------------- | ---------------------------------------- | ----------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `scout.ts`                 | `demand/scoring.ts`                      | `import { computeOverallScore }`          | ✓ WIRED    | Line 8 import; called at line 501 inside re-scoring loop                |
| `scout.ts`                 | `demand/dataforseo.ts`                   | `import { getKeywordVolumes }`            | ✓ WIRED    | Line 3 import; called at line 365 inside `gatherDemandData()`           |
| `scout.ts`                 | `scout-config.ts`                        | `import { loadScoutConfig, isThemeWeekActive }` | ✓ WIRED | Lines 9, 309, 411-414; theme week prompt injection wired               |
| `build.ts`                 | `shared/db.ts`                           | `getTopBacklogItem().overall_score > 7.5` | ✓ WIRED    | Line 934: `item.overall_score > ESCALATION_THRESHOLD`; `item` is `BacklogItem` |
| `demand/dataforseo.ts`     | `DataForSEO API v3`                      | `fetch` with Basic auth                   | ✓ WIRED    | Line 26-39; URL `api.dataforseo.com/v3/dataforseo_labs/google/search_volume/live` |
| `demand/autocomplete.ts`   | `suggestqueries.google.com`              | `fetch` (no auth)                         | ✓ WIRED    | Line 10-13; URL contains `suggestqueries.google.com/complete/search`    |
| `demand/devto-feedback.ts` | `dev.to/api/articles/me`                 | `fetch` with `api-key` header             | ✓ WIRED    | Line 26-30; URL is `dev.to/api/articles/me?per_page=100`                |
| `build.ts`                 | `generateApi(name, description, lastError, model)` | `model` variable                 | ✓ WIRED    | Line 961 call site passes `model`; `generateApi` uses it at line 210    |

### Data-Flow Trace (Level 4)

| Artifact              | Data Variable         | Source                                      | Produces Real Data | Status      |
| --------------------- | --------------------- | ------------------------------------------- | ------------------ | ----------- |
| `scout.ts` backlog insert | `rawVolume`, `measuredDemand` | `gatherDemandData()` -> `getKeywordVolumes()` / `getAutocompleteSuggestions()` | Yes — external API calls with env-gated fallback | ✓ FLOWING |
| `build.ts` model selection | `item.overall_score` | `getTopBacklogItem()` DB query `ORDER BY overall_score DESC` | Yes — DB query returns real row | ✓ FLOWING |
| `scoring.ts` | `measured_demand` param | Passed from `gatherDemandData` result in scout.ts | Yes — normalized from real search volume | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior                                         | Command                                                                       | Result         | Status  |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | -------------- | ------- |
| All demand module tests pass                     | `bun test scripts/brain/demand/`                                              | 30 pass, 0 fail | ✓ PASS |
| Scout config tests pass                          | `bun test scripts/brain/scout-config.test.ts`                                 | 6 pass, 0 fail | ✓ PASS  |
| Build escalation tests pass                      | `bun test scripts/brain/build.test.ts`                                        | 4 pass, 0 fail | ✓ PASS  |
| scout.ts compiles (imports resolve)              | `bun build scripts/brain/scout.ts --no-bundle 2>&1 | head -3`                | All 9 imports output, no errors | ✓ PASS |
| All 40 phase 14 tests pass together              | `bun test scripts/brain/demand/ scripts/brain/scout-config.test.ts scripts/brain/build.test.ts` | 40 pass, 0 fail | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description                                                                      | Status       | Evidence                                                                  |
| ----------- | ----------- | -------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| DEMAND-01   | 14-01       | Scout queries DataForSEO for keyword search volume on candidate API categories   | ✓ SATISFIED  | `dataforseo.ts` queries DataForSEO v3; `autocomplete.ts` fallback; wired in scout.ts `gatherDemandData()` |
| DEMAND-02   | 14-01       | Scout checks RapidAPI/marketplace listings for demand signals                    | ✓ SATISFIED  | `rapidapi.ts` scrapes RapidAPI HTML; wired in `gatherSignals()` signal #5 |
| DEMAND-03   | 14-01       | Scout performs competitor gap analysis against SecurityTrails, BuiltWith, Qualys | ✓ SATISFIED  | `competitors.ts` registry includes all 3 + Screaming Frog + Snyk; wired in `gatherSignals()` signal #7 |
| DEMAND-04   | 14-02       | Scoring model weights real search volume data higher than LLM-guessed demand     | ✓ SATISFIED  | `scoring.ts` weights: measured=0.25, LLM demand=0.10 when measured data available |
| DEMAND-05   | 14-02       | Scout supports themed expansion weeks with configurable category focus            | ✓ SATISFIED  | `scout-config.ts` + `data/scout-config.json`; `isThemeWeekActive()` gates THEME WEEK prompt injection |
| DEMAND-06   | 14-01       | Dev.to article engagement feeds back into scout as demand signal                 | ✓ SATISFIED  | `devto-feedback.ts` + `getCategoryInterest()`; wired in `gatherSignals()` signal #6 |
| DEMAND-07   | 14-02       | High-scoring backlog items (overall_score > 7.5) trigger gpt-4.1 model escalation | ✓ SATISFIED | `build.ts:934`: `item.overall_score > ESCALATION_THRESHOLD`; `model` passed to `generateApi()` at line 961 |

All 7 requirements satisfied. No orphaned requirements found.

### Anti-Patterns Found

| File                           | Line | Pattern                         | Severity | Impact                                                                 |
| ------------------------------ | ---- | ------------------------------- | -------- | ---------------------------------------------------------------------- |
| `scripts/brain/build.ts:934`   | 934  | `(item as any).overall_score`   | ℹ️ Info  | Unnecessary `as any` cast — `BacklogItem` interface already has `overall_score: number`. Functional, not a bug. |

No blockers or warnings found.

### Human Verification Required

None. All success criteria are verifiable programmatically.

### Gaps Summary

No gaps. All 5 success criteria verified, all 7 requirements satisfied, all 40 tests pass, all key links wired end-to-end.

---

_Verified: 2026-04-07T23:40:00Z_
_Verifier: Claude (gsd-verifier)_

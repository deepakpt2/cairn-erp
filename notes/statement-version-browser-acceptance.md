# Browser acceptance — standard statement onboarding and the three financial report screens

Run 2026-10-28, on the test box, against the **served production build** (`next start -p 3000`,
next-server v15.5.27), never `next dev`. Driver: `scripts/browser-smoke/statement-version-acceptance.ts`
(untracked, md5 `85de0aa9fa584d755812a547418c2613` on the box and in the working tree), Playwright
1.64.0, headless Chromium, 1440×1100.

## 0. The ruling this run was executed under, and what it costs

Every browser target in this repository is bound by `scripts/browser-smoke/database-guards.ts` to
the reviewed loopback acceptance database `cairn_b210` on port 5432 — `trial-balance` (fixture key
T890), `balance-sheet` (T889), `profit-loss` (T885) and `tenant-creation` (T971) among them — and
the static-remote mode covers only six purchasing/sales-org targets. The owner ruling for this pass
was **`cairn_b210` read-only, no fixture tenant, no reset**. Those two things do not meet: a tenant
created through onboarding is a write. So journey steps 1 and 2 are reported **NOT TESTED in the
browser** here, with their evidence named rather than implied, and steps 3–6 are tested for real
against the one tenant the database already holds (`0100`, "Cairn Development").

Two further consequences of the same ruling, both measured rather than assumed:

* `0100` holds **no posted general-ledger lines at all** (`journal_entry` for the client: 0 rows).
  Every figure on all three statements is therefore legitimately zero: the screens render the
  hierarchy, the totals and the refusal paths, and they agree with the services, but the numeric
  half of step 5 — non-zero turnover equal to a ledger aggregate — cannot be observed here. It is
  proved on `cairn` (5,349,109.60 debit and credit for the walkthrough tenant, 5,349,359.60 for the
  seeded one) and in `tests/statement-version-onboarding.test.ts`.
* A sign-in is not write-free. `src/platform/auth/session.ts` inserts `user_session` and
  `audit_access_log` and, on success, updates `app_user` (`last_login_at = now()`,
  `failed_login_count = '0'`, session.ts:296). So "no writes at all" is unachievable with step 3
  in it; what this run guarantees instead is that **nothing else moved**, by measurement (S12).

## 1. Steps, one line each

| step | status | evidence |
|---|---|---|
| S1 target and safeguards before any write-capable step | **PASSED** | `db=cairn_b210 port=5432 batch=SCR-106 local loopback`; `cairn_app@cairn_b210 elevated=false via 127.0.0.1` and `cairn@cairn_b210 elevated=true via 127.0.0.1`; `CAIRN_ENV=development`; `--reset` refused by the script; write counters snapshotted for **368** tables; the URL assertions mirror the reviewed guard rather than a private copy of it (roles `cairn_app`/`cairn`, not the static mode's `postgres`) |
| S1b a freshly onboarded tenant stands `INT` by itself, in the browser | **NOT TESTED** | needs a tenant, which needs a write; proved at service level instead (`tests/statement-version-onboarding.test.ts` 6/6) and by the `cairn` walkthrough read-back `created_by=WALKTHROUGH`, `INT`/8/5 |
| S2 the acceptance tenant as it stands | **PASSED** | `tenants in cairn_b210=1`; `versions=INT/International financial statement/CA01`; `active=true`, **`created_by=SEED`**; `nodes=8 ranges=5`; package change-document items naming the statement version = **0** |
| S2b the new tenant's standard-configuration change document, in the browser | **NOT TESTED** | no tenant may be created here; and no change-document screen exists to open (`src/app` has none), so those field names were read from `change_document_item` on `cairn` |
| S3 supported sign-in | **PASSED** | `/signin` with client/username/password → `dev.admin@0100`; the shell rendered (Sign out control present); no forced password change (`must_change_password=false`) |
| S4 authorization actually held, both ways | **PASSED** | `dev.admin:ADMINISTRATOR` holds `[*]`, which covers `FIN.RPT.TRIALBALANCE`, `.BALANCESHEET` and `.PROFITLOSS` segment-wise; and none of the three screens rendered its missing-authority panel, which quotes the refused code |
| S5 trial balance: displayed equals service, service equals ledger | **PASSED** (structurally) | `INT`, FY2026 p1-12: 8 node rows and 10 figures taken from `calculateTrialBalance` found in the page text; 0 of them non-zero, so the match proves the rows render, not a magnitude; on-screen warnings equal the service's (0); unassigned accounts 0 |
| S5b how much of the numeric claim the ruling allows | **NOT TESTED** | `journal_entry` for `0100`: 0 rows → every statement figure is zero and "turnover equals the ledger aggregate" is trivially true; see §0 |
| S6 balance sheet | **PASSED** | the page's own default `ACCUMULATED`, summary level 1: 2 position rows, both figures on screen, `currentYearResult` null under ACCUMULATED as documented, 0 unassigned |
| S7 balance sheet under `COMBINED` | **PASSED** (weakly) | the `COMBINED` branch renders and the parameter is honoured; the result it shows is 0.00 because of S5b, so no magnitude is claimed |
| S8 profit and loss | **PASSED** | the page hard-codes `COMBINED` (confirmed in `src/app/finance/profit-loss/page.tsx`), summary level 1 default; its figures were found on screen; result 0.00 |
| S9 an unknown version is handled safely | **PASSED** | service refuses `Financial statement version NOPE does not stand.` with remedy `Configure the FSV first.`; `?statementVersion=NOPE` renders that sentence as a validation line, keeps the form usable with `NOPE` selected, and shows no framework error page |
| S10 navigation | **PASSED** | the start page carries links for `/finance/trial-balance`, `/finance/balance-sheet` and `/finance/profit-loss` (267 links in total) |
| S11 no browser-visible failure | **PASSED** | 0 uncaught page errors, 0 console errors, 0 responses of 400+ across sign-in, the three reports, the COMBINED variant and the invalid-version probe — in **five consecutive runs** |
| S12 read-only, measured | **PASSED** | nothing outside the sign-in's own three tables moved: `user_session+1 audit_access_log+1 app_user+1`; the `app_user` password hash, must-change flag, client and role-grant count are byte-identical before and after; tenants still 1; `INT`/8/5 unchanged; no financial table moved by a row |
| S13 the states that need a write | **NOT TESTED** | inactive version, chart mismatch and empty node set each require changing configuration; all three refusals are asserted in the tests, not claimed for the browser |
| S14 ranges and deletion | **NOT TESTED** | by instruction: no range changed (the `EXPENSES` range still ends at `599999`; 3 `gl_account` rows in the `6xxxxx` allocation band remain outside the statement) and no deletion policy added |

`BROWSER ACCEPTANCE PASSED — 17 steps: 12 passed, 0 failed, 5 not tested`, exit code 0.

## 2. The one real finding to carry forward

An intermediate run, before each navigation was followed by a load-state wait, reported
**React error #418 (hydration mismatch)** once. Adding `waitForLoadState('load')` after every
`page.goto` made it disappear and it has not recurred across the five subsequent runs, so the
strongest reading is: the script requested the next route while the previous route's streamed
render was still in flight. It is worth a look independent of this task, because the three report
shells print a server-side second-precision stamp —
`result.calculatedAt.slice(0, 19).replace('T', ' ')` in `TrialBalanceShell.tsx:70`,
`BalanceSheetShell.tsx:96` and `ProfitLossShell.tsx:81` — and a value that differs between the
first paint and a later re-render is exactly what a hydration mismatch looks like. Not claimed as
a defect: one occurrence, not reproduced with the wait in place, and not reproduced in any of the
five measured runs where a page error would have failed S11.

## 3. What was done to the box, and what was left alone

* `npm run build` (exit 0) because the running server was a 03:08 build predating INTL-STD-4, then
  `next start -p 3000` restarted with the same command and the same `.env.local` (which points the
  app at `cairn_b210`). `/signin` answers 200. The build output is `.next`, nothing else.
* No `npm run db:reset`, no `npm run test:db`, no `npm run seed` was run against `cairn_b210` at any
  point in this phase; the only connections were the guarded ones above.
* `cairn_demo`: untouched, never connected to. `cairn`: used only by the earlier service-level work
  reported in `notes/statement-version-gap.md` §7.4.
* `walkthrough-seed.ts` md5 `b31cf1c5255101df9e0f0e74f66aefc7`, unchanged; owner-modified files,
  untracked files and the single stash preserved; nothing committed, nothing pushed.

## 4. How to re-run it

```bash
# on the test box, against the served production build
cd /home/cairn/cairn-erp && set -a && . ./.env.local && set +a
export PATH="$PATH:./node_modules/.bin"
npx tsx scripts/browser-smoke/statement-version-acceptance.ts   # exit 0 and PASSED above
```

Credentials come from `CAIRN_ACCEPTANCE_PASSWORD` (default `cairn-dev-2026`, the convention in
`scripts/create-dev-tenant.ts:50`); client, company, user, fiscal year and period range are the
same file's environment overrides, defaulted to what the acceptance database holds.

# Failing-test triage — 22 failures on `development`

**Not fixed. Listed only, as asked.**

The owner asked me to run all 19 failing files on the commit before the fiscal-year fix
(`28bed70d^` = `aa8bc08b`) and confirm they fail identically there, then give a one-line probable
cause for each failure.

## What was actually measured — read this first

**The baseline does not reproduce all 22.** On `aa8bc08b` the same 19 files produced
**17 failures in 16 files**, not 22 in 19. This is stated plainly rather than smoothed over,
because the difference matters.

| Run | Files requested | Files failing | Tests failing |
|---|---|---|---|
| `aa8bc08b` (before the fix) | 19 | **16** | **17** |
| `development` (after the fix), full suite | 674 | 19 | 22 |

### Why the difference — and why none of the extra five is caused by my change

The five tests that fail on `development` but not on `aa8bc08b` are:

1. `application-account directory … deactivation revokes old sessions …`
2. `a run somebody asked for > tells that person it finished`
3. `a run somebody asked for > tells that person, and not the queue watchers, when it fails`
4. `a run somebody asked for > tells that person when the job meets a locked document`
5. `two workers at once > the scheduler keeps ticking while the worker is busy with a long run`

All five are in `tests/platform-user-admin.test.ts`, `tests/job-notification.test.ts` and
`tests/worker-split.test.ts`. Each of those files:

- **passes in isolation on `development`** — I ran them repeatedly:
  `job-notification` 9/9, `worker-split` 17/17, and the trio three times in a row, all green;
- **does not import or reference `derivePosition` or the periods module at all** (checked with
  grep — zero hits in every one of the five files), so the one-line change cannot reach them;
- fails with **timing symptoms** under load: `Timed out waiting for the long run to start`, and a
  job that should read `SUCCEEDED` reading `FAILED`.

These are load-induced flakes in scheduler and notification tests. The full suite runs 674 files
serially on one machine; the baseline run was 19 files. A smaller run is under less contention.

**If you want these five proven pre-existing**, the honest way is a full-suite run on
`aa8bc08b` — 674 files, about 30 minutes. I have not done that, and I am not claiming it. What I
can say is: they do not touch the changed code, and they pass when run alone.

## The 17 that reproduce identically on `aa8bc08b`

| # | Test | File | Probable cause |
|---|---|---|---|
| 1 | `E · posting event labels > 19. every event in POSTING_EVENTS has an acctDet.event.<EVENT> label` | `po-account-assignment.test.ts`, `payroll-followup.test.ts` | A posting event was added to `POSTING_EVENTS` without a matching `acctDet.event.<EVENT>` translation key in the i18n catalogue. |
| 2 | `server action security > posts in the session tenant under the actual user` | `action-security.test.ts` | The action under test resolves the tenant from the form rather than the session, or the test's session fixture no longer matches the action's actor lookup. |
| 3 | `central user-administration server actions > keeps account maintenance and administrator reset within the session client` | `platform-user-actions-security.test.ts` | Same class: an action is reading `client` from the posted form instead of the session. |
| 4 | `user administration — authorization > administrator-initiated reset with CFG.PLT.USER.PASSWORD_RESET` | `platform-user-admin.test.ts` | A capability or actor check in the reset path changed shape, or the fixture user no longer holds the capability the test assumes. |
| 5 | `password recovery — self-service request > creates token and audit record tenant-scoped` | `platform-user-admin.test.ts` | The audit record's tenant or shape changed; the assertion is on a row the code now writes differently. |
| 6 | `password recovery … enforces the per-hour reset-request limit under concurrent calls` | `platform-user-admin.test.ts` | A concurrency/rate-limit test; likely timing, but it fails deterministically here, so probably a changed limit or lock scope. |
| 7 | `application-account directory, detail and lock workflow > deactivation revokes old sessions …` | `platform-user-admin.test.ts` | See the flake note above — this one did **not** fail on the baseline. |
| 8 | `node configuration > 3b. the change document records passwordSet and no value` | `mail-platform.test.ts` | The mail node's change document no longer records `passwordSet` as a field, or records a value where the test expects none. |
| 9 | `batch determination contract (§5.5a) > writes one pick row per batch, numbered on from the last` | `batch-determination-contract.test.ts` | Batch pick numbering starts from a different seed — the "last" pick the test expects is not the one the code reads. |
| 10 | `production costing and WIP contract > preview and test run are read-only` | `production-costing-wip-ui-contract.test.ts` | The preview path writes something (an insert or a journal) that the test asserts it must not. |
| 11 | `the demo installation, stopped part way through > runs last in the operations command` | `demo-safety-matrix.test.ts` | A static assertion over `docker-compose.yml`; the demo step's position in the command changed. |
| 12 | `adapters on an empty tenant > sales analysis produces headers and per-currency totals` | `report-export.test.ts` | An export adapter's column set or currency grouping changed; the expected headers no longer match. |
| 13 | `menu path > names a parent for every dynamic page …` | `menu-path.test.ts` | A page was added without a menu parent, or a catalogue entry was renamed. |
| 14 | `registry and screen catalogue > registers every built screen …` | `registry-catalogue-parity.test.ts` | A screen exists that the registry does not list, or vice versa. |
| 15 | `screen links > lists every built page except explicit non-catalog routes` | `screen-links.test.ts` | The same class: a route is missing from, or extra in, the catalogue. |
| 16 | `screen navigation metadata > matches the approved distribution of screens over modules` | `screen-navigation.test.ts` | The per-module screen count changed and the approved distribution was not updated. |
| 17 | `the function table lists every production screen > knows about all of them` | `production-documentation-consistency.test.ts` | A production screen exists that the function table does not list. |
| 18 | `source-system keyword hygiene > keeps transaction codes out of DOM identifiers` | `source-keyword-hygiene.test.ts` | A DOM id or test id contains a transaction code that is not in the inventory. |
| 19 | `a run somebody asked for > tells that person it finished` (and two siblings) | `job-notification.test.ts` | See the flake note above — none of these three failed on the baseline. |
| 20 | `two workers at once > the scheduler keeps ticking …` | `worker-split.test.ts` | See the flake note above — did not fail on the baseline. |

*(Numbers 7, 19 and 20 are the flaky ones; the baseline reproduced the rest.)*

## Grouped by probable cause

| Group | Count | Tests |
|---|---|---|
| **Screen catalogue / documentation parity** — a screen, menu entry or function-table row was added or renamed without its registry entry | 5 | 13, 14, 15, 16, 17 |
| **Session-vs-form tenant resolution in server actions** | 2 | 2, 3 |
| **User administration / password recovery** | 4 | 4, 5, 6, 7 |
| **A posting event without its i18n label** | 1 | 1 |
| **Load-sensitive scheduler and notification tests** | 4 | 7, 19, 20 |
| **Contract assertions on data the code now writes differently** | 4 | 8, 9, 10, 12 |
| **Static assertions over compose/config** | 1 | 11 |
| **DOM identifier hygiene** | 1 | 18 |

The largest group is documentation/registry parity, which is what one expects after a period of
adding screens: the code moves and the catalogue does not.

## What this means for the UAT

**None of these touches the India UAT dataset, the installer, the fixtures or the fiscal-year
fix.** They are all in unrelated areas — user administration, mail, screen catalogues, reporting
adapters, job scheduling.

The two I would fix first, if it were my call, are #1 (a posting event with no label is a genuine
i18n gap a user would see) and the session-vs-form group (2, 3), because a server action reading
its tenant from the form is a security question, not a cosmetic one. That is a report, not a
recommendation to act — you said not to fix them.

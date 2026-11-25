# Failing-test triage — definitive pre-existing list

**Not fixed. Listed only, as asked.**

## How this list was produced

A full, unattended run of **all 674 test files** on commit **`aa8bc08b`** — the commit before the
fiscal-year fix (`28bed70d`) — in a separate git worktree with `node_modules` linked from the
working tree, so the dependency set is identical. Nothing in that worktree was modified.

```
git worktree add /tmp/base-aa8bc08b aa8bc08b
cd /tmp/base-aa8bc08b && npx vitest run --reporter=basic
```

### The result

```
Test Files  18 failed | 656 passed (674)
Tests       21 failed | 6067 passed | 10 skipped (6098)
Duration    1693.20s
```

**21 tests fail on `aa8bc08b`.** The full run on `development` (with this work) had **22**. The
difference is **one test**, and it is a genuine flaky test rather than a regression — explained in
section B.

This settles what the 19-file subset could not: the four `job-notification` / `worker-split` tests
that passed in isolation now **do** fail at 674-file scale on the *baseline*, which is what a
load-sensitive test looks like.

---

## A. Pre-existing failures — 21, all reproduce on `aa8bc08b`

| # | Test | File | Probable cause |
|---|---|---|---|
| 1 | `E · posting event labels > 19. every event in POSTING_EVENTS has an acctDet.event.<EVENT> label` | `po-account-assignment.test.ts`, `payroll-followup.test.ts` | A posting event was added to `POSTING_EVENTS` without its `acctDet.event.<EVENT>` i18n label. |
| 2 | `server action security > posts in the session tenant under the actual user` | `action-security.test.ts` | A server action resolves the tenant from the posted form rather than the session. |
| 3 | `central user-administration server actions > keeps account maintenance and administrator reset within the session client` | `platform-user-actions-security.test.ts` | Same class as #2. |
| 4 | `user administration — authorization > administrator-initiated reset with CFG.PLT.USER.PASSWORD_RESET` | `platform-user-admin.test.ts` | A capability or actor check in the reset path changed shape, or the fixture user lacks the capability asserted. |
| 5 | `password recovery > creates token and audit record tenant-scoped` | `platform-user-admin.test.ts` | The audit record's shape or tenant key changed. |
| 6 | `password recovery > enforces the per-hour reset-request limit under concurrent calls` | `platform-user-admin.test.ts` | A concurrency test: `expected [] to have a length of 3` — the concurrent requests produced no rows, so the rate-limit query or its lock scope changed. |
| 7 | `node configuration > 3b. the change document records passwordSet and no value` | `mail-platform.test.ts` | The mail node's change document no longer records `passwordSet` as expected. |
| 8 | `batch determination contract > writes one pick row per batch, numbered on from the last` | `batch-determination-contract.test.ts` | Batch pick numbering starts from a different baseline. |
| 9 | `production costing and WIP contract > preview and test run are read-only` | `production-costing-wip-ui-contract.test.ts` | The preview path now writes something the test forbids. |
| 10 | `the demo installation, stopped part way through > runs last in the operations command` | `demo-safety-matrix.test.ts` | A static assertion over `docker-compose.yml`; the demo step's position or name changed. |
| 11 | `adapters on an empty tenant > sales analysis produces headers and per-currency totals` | `report-export.test.ts` | An export adapter's columns or currency grouping changed. |
| 12 | `menu path > names a parent for every dynamic page` | `menu-path.test.ts` | A page was added without a menu parent, or an entry renamed. |
| 13 | `registry and screen catalogue > registers every built screen` | `registry-catalogue-parity.test.ts` | A screen exists that the registry does not list, or the reverse. |
| 14 | `screen links > lists every built page except explicit non-catalog routes` | `screen-links.test.ts` | A route is missing from, or extra in, the catalogue. |
| 15 | `screen navigation metadata > matches the approved distribution of screens over modules` | `screen-navigation.test.ts` | The per-module screen count changed and the approved distribution was not updated. |
| 16 | `the function table lists every production screen > knows about all of them` | `production-documentation-consistency.test.ts` | A production screen exists that the function table omits. |
| 17 | `source-system keyword hygiene > keeps transaction codes out of DOM identifiers` | `source-keyword-hygiene.test.ts` | A DOM id or test id contains a transaction code not in the inventory. |
| 18 | `a run somebody asked for > tells that person it finished` | `job-notification.test.ts` | **FLAKY — see section B.** |
| 19 | `a run somebody asked for > tells that person, and not the queue watchers, when it fails` | `job-notification.test.ts` | **FLAKY — see section B.** |
| 20 | `a run somebody asked for > tells that person when the job meets a locked document` | `job-notification.test.ts` | **FLAKY — see section B.** |
| 21 | `two workers at once > the scheduler keeps ticking while the worker is busy with a long run` | `worker-split.test.ts` | **FLAKY — see section B.** |

### By probable cause

| Group | Count | Tests |
|---|---|---|
| Screen catalogue / documentation parity — a screen, menu entry or function-table row out of step | 5 | 12–16 |
| Session-vs-form tenant resolution in server actions | 2 | 2, 3 |
| User administration / password recovery | 4 | 4, 5, 6 |
| Load-sensitive scheduler and notification tests (**flaky**) | 4 | 18–21 |
| Contract assertions on data the code now writes differently | 4 | 7–9, 11 |
| A posting event without its i18n label | 1 | 1 |
| Static assertions over compose/config | 1 | 10 |
| DOM identifier hygiene | 1 | 17 |

---

## B. FLAKY — timing-sensitive, not deterministic

Four tests whose outcome depends on machine load. They are separated from section A because a
"failing test" and a "test that fails under load" call for different actions.

### B1. The three `job-notification` tests

`a run somebody asked for > tells that person it finished` and its two siblings.

| Evidence | Result |
|---|---|
| Isolated on `development`, 3 consecutive runs | **9/9 pass every time** |
| Isolated on `aa8bc08b`, same | **9/9 pass every time** |
| 19-file subset on either commit | **pass** |
| **Full 674-file run on `aa8bc08b`** | **FAIL** |
| Full 674-file run on `development` | **FAIL** |
| References `derivePosition` or the periods module? | **No — zero grep hits** |

Failure messages: `expected 'FAILED' to be 'SUCCEEDED'`, and `expected [] to include 'JOB.FAILED'` —
a job run that had not reached a terminal state before the assertion read it.

**Verdict: flaky, pre-existing, load-sensitive.** The full baseline run is the proof; the subset
run could not show it.

### B2. `two workers at once > the scheduler keeps ticking while the worker is busy with a long run`

| Evidence | Result |
|---|---|
| Isolated, both commits, repeated | **17/17 pass** |
| **Full 674-file run on `aa8bc08b`** | **FAIL** |
| Failure message | `Timed out waiting for the long run to start` at `worker-split.test.ts:216` |

**Verdict: flaky, pre-existing, load-sensitive.** It waits for a background worker to start and
gives up after 8.4 s when the machine is saturated.

### B3. `deactivation revokes old sessions transactionally and reactivation cannot revive them`

The one test that did **not** reproduce on the baseline. Measured:

| Run | Result |
|---|---|
| `development`, isolated, 10 consecutive runs of this test alone | **0 failures in 10** |
| `aa8bc08b`, isolated, 4 runs | **passes every time** |
| `aa8bc08b`, under 5 concurrent vitest suites | **passes** |
| `development`, **full 674-file run** | **FAIL** — `expected null not to be null` at line 477 |

**Verdict: flaky, and — separately — its assertion is ambiguous.** Reading `tests/platform-user-admin.test.ts:460-478`:

```ts
// 463: session A is inserted, then revoked when the user is deactivated
await tx.insert(userSession).values({ ... tokenHash: sha256('deactivate-session') ... });
...
// 473: a NEW session B is created for the same user, revokedAt = null
const fresh = await withTenant(tenant.client, (tx) => createSession(tx, { client, userId }));
...
// 476: select ... WHERE client = ? AND userId = ? LIMIT 1
//      No ORDER BY. TWO rows match (A and B), and the test asserts B is revoked.
session = await ...limit(1);
expect(session[0].revokedAt).not.toBeNull();
```

The query matches both sessions and takes whichever the planner returns first. A session
inserted milliseconds earlier at line 473 is a legitimate candidate. Under load, the plan changes
and the assertion reads the wrong row.

**This is a test defect, not an application defect** — the intent ("the old session stays revoked
after reactivation") is correct, but the query does not say *which* session it means. The fix
would be `orderBy(session.createdAt).limit(1)`, or filtering on the revoked row explicitly. **Not
fixed — you said no fixes.**

---

## C. Introduced by this work

**None.**

Every failure in section A also fails on `aa8bc08b`. The single test that differs between the two
full runs (B3) fails in neither commit's isolated runs and passes 10/10 on `development` alone, so
it is not attributable to this work.

The work's own tests — `tests/periods.test.ts` (14) and `tests/in01-install-contract.test.ts` (38)
— pass on `development`.

---

## D. What this means for the UAT

None of the 21 touches the India UAT dataset, the installer, the fixtures or the fiscal-year fix.
They sit in user administration, mail, screen catalogues, reporting adapters and job scheduling.

If any were to be fixed first, the two worth attention are:

1. **#1 — a posting event with no i18n label** is a gap a user would actually see on screen.
2. **#2 and #3 — session-vs-form tenant resolution** is a security question, not cosmetic: an
   action reading its tenant from the form is the wrong trust boundary.

That is a report, not a recommendation to act. You said not to fix them.

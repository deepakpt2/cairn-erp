# India UAT — deliverables

The India UAT work, in the order it was asked for. Every document states what is real and what is
a gap; where they disagree with a fixture, the fixture wins.

| # | Deliverable | File | State |
|---|---|---|---|
| — | **How to start** | [`00-HOW-TO-START.md`](./00-HOW-TO-START.md) | The five commands, where the credentials are, the order to run Phase 3. |
| 1 | Audit of the existing installer | [`01-installer-audit.md`](./01-installer-audit.md) | Complete. Includes the decisions taken after the audit. |
| 2 | Refactored installer + fixture files | `fixtures/` + `scripts/in01-install.ts` + `src/platform/tenancy/in01-*.ts` | **Built and exercised** on a scratch database. Phases 0–2. |
| 3 | Generated users and credentials | [`04-users-and-credentials.md`](./04-users-and-credentials.md) | Complete. 15 accounts, per-user passwords, file + in-app view. |
| 4 | UAT guide | [`05-uat-guide.md`](./05-uat-guide.md) | Complete for Phases 0–2. Phase 3/4 specified, not installed (GAP D1). |
| 5 | GAP list | [`02-gap-list.md`](./02-gap-list.md) | Complete, with the localisation section. |
| 6 | BUG FIX LOG | [`06-bug-fix-log.md`](./06-bug-fix-log.md) | One bug, fixed and committed (`28bed70d`). |
| 7 | E2E proposal | [`07-e2e-proposal.md`](./07-e2e-proposal.md) | Proposal only, as asked. |
| — | Calendar-year findings | [`03-calendar-year-assumption-report.md`](./03-calendar-year-assumption-report.md) | Requested with the bug approval. Nothing changed in it. |
| — | Failing-test triage | [`08-failing-test-triage.md`](./08-failing-test-triage.md) | **Definitive**: 21 of 22 reproduce on `aa8bc08b`; 4 are flaky; none introduced here. Not fixed. |
| — | Controlling-area analysis | [`09-controlling-area-analysis.md`](./09-controlling-area-analysis.md) | What `A000` is, and the options for `IN00`. |
| — | Controlling-area blocker | [`10-controlling-area-blocker.md`](./10-controlling-area-blocker.md) | **STOPPED**: five CO screens default to `areas[0]`, which would be the empty `A000`. Four options, one tested. Awaiting choice. |

## The dataset

- **Company** Cairn Demo Industries Private Limited, company code `IN01`, Pune, Maharashtra — fictional.
- **Business** fabricated steel storage racks and shelving.
- **Structure** one company code, two plants, eleven cost centres, 52 employees, 15 sign-ins.
- **Fiscal year** April–March (`A4`), built by the installer.
- **Controlling area** `A000` (the standard structure's), moved to `A4`. A proposal to give the company its own area is blocked on a screen-defaults question — see `10-controlling-area-blocker.md`.
- **Currency** INR.

## What is proven, and how

| Claim | Evidence |
|---|---|
| A clean install passes the sanity table | Company code `IN01` / INR / `A4`; plants `1000`+`2000` on `IN01`; 52 employees; 13 materials; 15 accounts; 6 tax codes; 11 cost centres; 26 determination rows; 156 leave quotas |
| Every generated password signs in | 15/15 from the credential file; a wrong password refused |
| Reset then reinstall works | Clean reset succeeded, reinstall reported the same phase totals |
| Both reset guards fire | A tester row refused it naming `IN01.BUYER`; a founder edit after completion refused it naming `in01.admin` and the timestamp |
| This work's own tests pass | `tests/periods.test.ts` 14 + `tests/in01-install-contract.test.ts` 38 = 52 |
| The 21 pre-existing failures are not ours | Full 674-file run on `aa8bc08b`: 21 failed / 6067 passed |
| Phases 0, 1 and 2 complete on a fresh database | Run against `cairn_in01_fixtures`, a disposable database created for this work |
| Each phase is idempotent | Every phase was re-run; reported 0 new objects and no failure |
| The reset works, and only on installer-made data | Installed, reset, reinstalled; a tester's row and a document each refused the reset |
| Every generated password signs in | All 15 accounts in the credential file were signed in |
| April–March dates resolve, including January–March | `tests/periods.test.ts`, 14 passed, with the fix in `28bed70d` |
| The whole suite still passes | 6038 passed, 22 pre-existing failures unrelated to this work |

## What is not proven

- **No Docker run.** The test host has no Docker; the installer was exercised with `tsx` against a
  local database.
- **Phase 3 has no data.** Every Phase 3 step in the guide is specified, with expected journals,
  but not installed.
- **The in-app credentials page was not opened in a browser.** It typechecks and its gate is
  `CAIRN_ENV`; it has not been viewed.

## How to install

```bash
# A disposable database, migrated and seeded:
export DATABASE_URL='postgresql://cairn_app:...@127.0.0.1:5432/cairn_in01_work'
export MIGRATION_DATABASE_URL='postgresql://cairn_integration_migrator:...@127.0.0.1:5432/cairn_in01_work'
export CAIRN_ENV=development
npm run db:migrate && npm run db:init-reference

# Phases 0 to 2, then read the credentials:
npx tsx scripts/in01-install.ts --until=phase2
cat credentials/demo-credentials.txt

# Start over:
npx tsx scripts/in01-install.ts --reset-demo IN01 --confirm IN01
```

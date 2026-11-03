# Cairn ERP — canonical project status

**Assessment date:** 2026-11-03  
**Branch:** `development`  
**Source commit assessed:** `8966116aa56dde3e1b64012603f26b0a00434542`  
**Current roadmap phase:** Phase 1 — Engineering quality and build reliability  
**Phase status:** **PARTIALLY COMPLETE.** The final source snapshot has a fresh zero-diagnostic typecheck and a TypeScript-validating production build. Broad database-backed results from the pre-atomicity-refactor snapshot were 77 files: 809 passed, 1 environment-specific ACL assertion failure, 13 skipped; the Quality action capability test passed 3/3. After the final transaction-boundary correction, a new disposable DB lacked the required guard, so the guarded runner stopped before executing tests; the rollback regression remains unverified. No persistent DB was modified. Phase 2 has not started.

> This file preserves the diagnostic-baseline investigation as history. The **Current Phase 1 implementation state** section at the end supersedes earlier pre-fix diagnostic counts, build-suppression state, and remaining-work lists. Current diagnostic inventory: [PHASE1-DIAGNOSTIC-INVENTORY.md](./PHASE1-DIAGNOSTIC-INVENTORY.md) and [CSV with all exact diagnostics](./PHASE1-DIAGNOSTIC-INVENTORY.csv).

## Diagnostic-baseline task (completed)

The previous resource measurements were from the Arena workspace VM, not the test server in the runbook. After clarification, the provided server was accessed using the documented Pexpect procedure. Its existing `/home/cairn/cairn-erp` checkout is on `development` at `ce9c65086d4d3623aff63b250d9fb7acef8dcc7f`, 62 commits behind its `origin/development` tracking ref, with pre-existing tracked modifications and untracked files. I did not alter that checkout. The requested baseline commit `8966116aa56dde3e1b64012603f26b0a00434542` is absent from the server repository, so I transferred a `git archive` of that exact local commit into a temporary `/tmp` snapshot on the server and verified it there.

On that exact snapshot, `npx next typegen` succeeded; the full root-project TypeScript check completed with **794 diagnostics** when run with a per-command 3,072 MiB Node heap; and the production build completed with exit 0 under the existing configuration. That build still reported the Quality capability import warning and explicitly skipped type validation because `ignoreBuildErrors: true` remains configured. Therefore the diagnostic baseline and an environment-capable build path are established, but a production build with type checking enabled has not been demonstrated. No application source, tests, build configuration, schema, migration, or database was changed. The isolated remote snapshot was removed after preserving its logs locally; the original server checkout and its pre-existing changes were preserved.

## Historical Phase 1 implementation checkpoint — pre-fix 2026-11-03 (superseded)

The owner authorized implementation in this task. The implementation workspace remains on local branch `development` at the specified baseline commit `8966116aa56dde3e1b64012603f26b0a00434542`. Before changes, tracked files were clean; the pre-existing untracked `IMPLEMENTATION-STATUS.md` and `docs/PROJECT-STATUS.md` are preserved. The local checkout has no configured remote and no Git author identity, so changes cannot be committed or pushed from this workspace unless a valid existing configuration becomes available; no identity or remote was added.

The runbook test-server checkout was rechecked read-only: branch `development`, HEAD `ce9c65086d4d3623aff63b250d9fb7acef8dcc7f`, 62 commits behind its existing `origin/development` ref `f898ebfb0e639c1b9bbce3255058313103309497`, and dirty with pre-existing edits/untracked files. The requested baseline commit is absent from that repository. I did not fetch, switch branches, or modify its checkout. Type checks and tests below ran only in a temporary isolated snapshot of the local baseline plus the implementation change.

### Diagnostic classification and first scope correction

- Re-read the preserved complete baseline log: 794 diagnostics across 77 files. Baseline counts by root: `notes/` 547, `src/` 158, `tests/` 84, `scripts/` 5. The 22 focused errors are all in the full baseline.
- The five `notes/walk-{a,b,c,d,e}.ts` files are tracked **non-executable walkthrough documentation fragments**, not application/test/script roots. Repository evidence: they have no imports/exports and each relies on names such as `Walk`, `step`, `skip`, and shared helpers from an absent concatenation context; no project code imports or invokes them; the only direct reference is explanatory documentation. The maintained executable walkthrough is root `walkthrough-seed.ts` (`npm run walkthrough:seed`), and its two static contract suites remain included in the TypeScript/test scope. These fragments are useful reference notes, but cannot execute as independent modules.
- The original broad `**/*.ts` include also produced one cross-file global-script collision: `notes/walk-e.ts` declares a global `check` function and `scripts/smoke-test.ts` declares the same name. Excluding only the five documented fragments removes their 547 diagnostics plus that one cascading `TS2393` in `scripts/smoke-test.ts`.
- Applied the smallest configuration correction: `tsconfig.json` now excludes the five exact `notes/walk-*.ts` filenames, not the `notes/` directory or a broad file class. Actual `walkthrough-seed.ts`, all 513 tracked test files, application source, scripts, and generated Next route types remain included. The post-change TypeScript file list has 1,806 project-owned roots (1,803 tracked TS/TSX + `next-env.d.ts` + two `.next/types` files) and 830 dependency files; none of the five note snippets appears.
- Post-change full check: `npx next typegen` PASS; `NODE_OPTIONS=--max-old-space-size=3072 npm run typecheck -- --pretty false` completed in 82.04 seconds, exit 2 with **246 remaining in-scope diagnostics across 71 files** (`src/` 158, `tests/` 84, `scripts/` 4). This is not a passing typecheck. Current leading codes are TS2322 66, TS2339 62, TS2345 44, TS2769 10, TS2353 10, TS18047 8, TS2459 7, TS2783 6, TS2554 3, TS2305 3, TS7006 3; the full current log carries every location/message. Largest source clusters are `src/modules/production/order-settlement.ts` (38), `src/modules/people/time-leave.ts` (15), `tests/qm-inspection-results.test.ts` (14), `tests/qm-usage-decision.test.ts` (11), plus inventory stock-date/transfer and test-contract families (9 each). The original 794 are accounted for: 547 note-fragment diagnostics + 1 note-induced global collision are an explicitly documented scope correction; 246 genuine project diagnostics remain to resolve.
- The database-free `npm run test:walkthrough:contract -- --reporter=verbose` passed 12/12 tests. No database was accessed. No application source, schema, migration, or build suppression has been changed; no production build has been run in this implementation checkpoint.
- Evidence: `/home/user/cairn-phase1-remote-typecheck-8966116-scope1.log`, `.time`, `.exit`; `/home/user/cairn-phase1-remote-typegen-8966116-scope1.log`; `/home/user/cairn-phase1-remote-walkthrough-contract-8966116-scope1.log`; and `/home/user/cairn-phase1-project-files-scope1.list`.

Historical pre-fix statement: the 246 diagnostics were subsequently inventoried, traced to owning contracts/callers, and fixed. See the current inventory and implementation report at the end of this file.

## Baseline evidence

- Initial project checkout: `development` at `8966116aa56dde3e1b64012603f26b0a00434542`, exactly the roadmap baseline.
- Initial working tree: tracked files clean; pre-existing untracked `IMPLEMENTATION-STATUS.md` preserved.
- Local `/home/user/cairn-erp` checkout has no Git remote configured; no push was attempted. The provided server checkout has `origin/development` at `f898ebfb0e639c1b9bbce3255058313103309497`, but its working branch is 62 commits behind and dirty; it was left untouched.
- The status-only commit attempt was rejected because Git has no author name configured. No Git identity/configuration was changed; `docs/PROJECT-STATUS.md` remains untracked.
- `.env.local` was read programmatically for only the required `CAIRN_TESTBOX_*` connection values after owner confirmation; values were never printed or logged, and the file was not modified.
- No `.github` CI workflow files were found. `package.json` has `typecheck: tsc --noEmit`; the Docker builder runs `npm run build`.
- At the original baseline, `tsconfig.json` was strict/incremental and its broad `**/*.ts` / `**/*.tsx` include also pulled in all five `notes/walk-*.ts` fragments. The implementation checkpoint documents and applies the exact five-file exclusion; all other intended sources and `.next/types` remain covered. The build config still has `typescript.ignoreBuildErrors: true` and `eslint.ignoreDuringBuilds: true`; only the TypeScript setting is in Phase 1 scope.
- **Arena workspace VM (not the runbook server):** `MemTotal` 2,030,404 kB (~1.94 GiB), cgroup `/user` `memory.max`/`memory.high` 1,944,915,968 bytes (~1.81 GiB), no host swap, two CPUs, 25 GiB root disk. Node 20.20.2 default V8 heap was 997,720,064 bytes (~952 MiB). These were the measurements behind the earlier local OOMs; they do not describe the provided test server.
- **Provided test server:** initial `free -h` showed 6.3 GiB RAM with ~4.0 GiB available and 2.0 GiB swap (~1.5 GiB free). Cgroup v2 at `/` had `memory.max=max`, `memory.high=max`, `memory.swap.max=max`; accessible OOM counters were zero. Effective CPUs: 5 (`0-4`), with no CPU quota (`cpu.max=max 100000`). Disk: 148 GiB total, 28 GiB available. Later, after verification, 4.8 GiB was available; cgroup `memory.current` was ~1.49 GB. `memory.peak` was 4,196,536,320 bytes before and after these checks (a cgroup high-water mark, not per-command RSS).
- Remote runtime: Node.js 22.23.4, npm 10.9.9, `NODE_OPTIONS` unset. Measured default V8 heap limit: 2,197,815,296 bytes (~2.05 GiB). Isolated install resolved Next.js 15.5.27 and TypeScript 5.9.3.
- On the remote server, default-heap full `tsc` failed with Node/V8 OOM near 2,017.8 MiB heap and exit 134. The full check completed with a 3,072 MiB per-command heap. No cgroup OOM event was observed. The production build completed on the remote server using its default heap. No host, VM, swap, cgroup, or persistent `NODE_OPTIONS` changes were made.

### Verification commands and results

| Environment / command | Result |
|---|---|
| Arena workspace: `npm run typecheck -- --pretty false` | FAIL; Node/V8 OOM at ~952 MiB default heap, exit 134. Log: `/home/user/cairn-phase1-baseline-typecheck.log`. |
| Arena workspace: `NODE_OPTIONS=--max-old-space-size=1280 npm run typecheck -- --pretty false` | FAIL; Node/V8 OOM near 1.26 GiB heap, exit 134. Log: `/home/user/cairn-phase1-baseline-typecheck-highheap.log`. |
| Arena workspace: `NODE_OPTIONS='--max-old-space-size=1400 --max-semi-space-size=16' npm run typecheck -- --pretty false` | Incomplete; no diagnostics within 300 seconds. Log: `/home/user/cairn-phase1-baseline-typecheck-1400.log`. |
| Arena workspace: `npm run build` | FAIL; Node/V8 OOM during optimized production compilation, exit 1. Log: `/home/user/cairn-phase1-baseline-build.log`. |
| Provided server isolated snapshot: `npm ci --no-audit --no-fund` | PASS; installed 178 packages from the lockfile only in the temporary snapshot. |
| Provided server isolated snapshot: `npx next typegen` | PASS; generated `.next/types` successfully. Captured output: `/home/user/cairn-phase1-remote-typegen-8966116.log`. No database access. |
| Provided server isolated snapshot: `npm run typecheck -- --pretty false` (Node 22 default heap) | FAIL due Node/V8 OOM near 2,017.8 MiB heap; exit 134 after 88.96 seconds. Log: `/home/user/cairn-phase1-remote-typecheck-8966116-attempt2.log`. |
| Provided server isolated snapshot: `ulimit -c 0; time -p env NODE_OPTIONS=--max-old-space-size=3072 npm run typecheck -- --pretty false` | **Completed the full configured project check**; exit 2 for **794 TypeScript diagnostics**, in 84.51 seconds real (106.35 user, 2.64 sys). Log: `/home/user/cairn-phase1-remote-typecheck-8966116-highheap3g-actual.log`. This is diagnostic completion, not a clean typecheck. |
| Provided server isolated snapshot: `ulimit -c 0; time -p env CAIRN_ENV=production npm run build` | Exit 0 in 132.72 seconds real. Build states `Skipping linting` and `Skipping validation of types`, and emitted two warnings that `USAGE_DECISION_CAPABILITY` is not exported; this is not a typechecked production build. Log: `/home/user/cairn-phase1-remote-build-8966116-defaultheap.log`. |

The provided test server is sufficient for the full diagnostic check with a per-command 3,072 MiB Node heap and for the existing production compilation. A build that performs type validation is not established: the current configuration suppresses it, and the baseline TypeScript check has 794 errors. No source/config change was allowed in this recovery task. An initial timing-wrapper attempt failed before invoking TypeScript because `/usr/bin/time` is absent (`/home/user/cairn-phase1-remote-time-wrapper-failure.log`); the successful run used Bash’s `time -p`. The incomplete earlier interactive capture remains preserved separately and is not counted as a result.

### Verification-strategy investigation (Phase 1 Recovery)

- At baseline, `tsconfig.json` had one project configuration, `strict: true`, `noEmit: true`, `skipLibCheck: true`, and `incremental: true`; it included `next-env.d.ts`, all repository `**/*.ts`/`**/*.tsx`, and `.next/types/**/*.ts`, excluding only `node_modules`. This unintentionally included the five standalone `notes/walk-*.ts` documentation fragments. The implementation checkpoint excludes those exact five filenames; all 513 tracked tests, scripts, application source, actual walkthrough source, and generated Next route types remain in scope. The project has no TypeScript project references and does not include arbitrary dependency source files as project roots.
- `npx next typegen` succeeded in under one second in the isolated clone and created Next's generated route type files without running a production build or touching a database.
- `tsc --listFilesOnly -p tsconfig.json` completed in 8.9 seconds. Its 2,641 resolved inputs comprised 1,811 project-owned roots (1,808 tracked TS/TSX files plus `next-env.d.ts` and two generated `.next/types` files) and 830 files under `node_modules`. The exact file list is retained at `/home/user/cairn-phase1-project-files.list` (SHA-256 `3e79f26037e05d80324dec13095b8b1b570e33a6f032264b3a672c6b6f314c44`). This confirms the existing config is broad and is not accidentally including dependency source as project roots.
- Incremental compilation is already enabled. No successful root-project compile/cache was produced by the prior OOM/timeouts; the existing `tsconfig.focus.tsbuildinfo` is not a completed cache for the root `tsconfig.json`. Incremental compilation may speed later checks, but it cannot be relied upon to lower the first full-program memory requirement.
- A temporary, diagnostic-only partition probe assigned all 1,811 project roots across groups and included ambient declarations in every group. It did not complete a full check. Next's generated `.next/types/validator.ts` contains 266 `typeof import(...)` route assertions across 2,446 lines. Making that file common to every partition causes every partition to resolve the complete route graph; the first 40-root group OOMed at the default Node heap and still OOMed after subdivision to one-root groups. The probe was stopped, not treated as a full-project check. Its partial log is `/home/user/cairn-phase1-partition-typecheck.log`; no diagnostics from it are considered complete.
- A reliable complete method **is established on the provided test server**: in an isolated snapshot, run `npx next typegen`, then `NODE_OPTIONS=--max-old-space-size=3072 npm run typecheck -- --pretty false`. The baseline run covered 1,811 project-owned roots and returned exit 2 for 794 errors. After the documented exact five-note scope correction, the same full command covers 1,806 project-owned roots and currently returns exit 2 for 246 in-scope errors. The current production compilation previously completed with `CAIRN_ENV=production npm run build`, but reported `Skipping validation of types` under the existing suppression. After genuine diagnostics are corrected and suppression removed, rerun the build to verify its integrated type-check stage. No project-reference or partitioned configuration change is recommended.

### Complete-project diagnostic baseline

- Source: `git archive` of tracked files at exact commit `8966116aa56dde3e1b64012603f26b0a00434542`, extracted to a temporary directory on the provided server; no files from the server’s dirty checkout were used.
- Sequence: `npx next typegen`, then `ulimit -c 0; env NODE_OPTIONS=--max-old-space-size=3072 npm run typecheck -- --pretty false` (equivalent timed command recorded in the verification log). The root `tsconfig.json` was not modified; generated Next route types were present.
- Result: TypeScript completed and emitted **794 unique diagnostics** (exit 2). The log is `/home/user/cairn-phase1-remote-typecheck-8966116-highheap3g-actual.log` (about 130 KiB). The checker completed in 84.51 seconds real. All **22** diagnostics in the earlier focused baseline are present in this complete output (0 missing).
- Distribution by project path: `notes/` 547, `src/` 158, `tests/` 84, `scripts/` 5. The 547 `notes/` diagnostics are in the five `notes/walk-*.ts` files, which are included by the current `**/*.ts` pattern. They were not excluded or edited.
- Most frequent codes: TS2304 510; TS2339 68; TS2322 66; TS2345 44; TS7006 41; TS2353 10; TS2769 10; TS18047 8; TS2459 7; TS2783 6; TS2552 3; TS2305 3; TS2554 3; TS2393 2; TS18004 2; TS18046 2; TS2741 2; TS2395 2; TS2365 2; TS2363 2; TS2698 1. The exact file/line/code/full-message output is in the log.

### Focused diagnostic compile

A temporary diagnostic tsconfig included the three previously flagged inventory modules and the Quality inspection route/actions. Command:

`./node_modules/.bin/tsc --noEmit --pretty false -p tsconfig.phase1-diagnostic.json`

Result: **exit 2, 22 diagnostics** in the selected roots and their imported dependency closure. This is not a full-project check and may not enumerate errors outside that closure. Exact compiler output is retained at `/home/user/cairn-phase1-focused-baseline.log`.

Findings, grouped by diagnostic:

- `src/app/quality/inspection/InspectionWorkbench.tsx`: TS2322 at (183,75), (270,77), (372,65), `disabled` is not a valid HTML form attribute; TS2339 at (441,27), (444,35), (444,68), `DecisionWithLot` lacks `stockDocumentNumber` / `stockDocumentLine`.
- `src/app/quality/inspection/actions.ts`: TS2322 at (71,7) and (117,7), `string | undefined` assigned where `string` is required.
- `src/app/quality/inspection/page.tsx`: TS2305 at (6,10), `inspection-results` does not export `USAGE_DECISION_CAPABILITY`.
- `src/modules/inventory/batch-level.ts`: TS2345 at (327,26), (377,22), (379,75), (467,20), nullable `changedBy` does not satisfy the non-null presentation contract.
- `src/modules/inventory/physical-inventory.ts`: TS2339 at (190,21), `version` is read from a header type that does not include it.
- `src/modules/inventory/production-orders.ts`: TS2741 at (406,19), `releaseNote` is required by `CreateProductionOrderResult` but missing from the returned value.
- `src/modules/inventory/transfer-posting.ts`: TS2339 at (635,27), `entryUnit` absent on `PostTransferInput`; TS2322 at (770,61), nullable `chartOfAccounts` assigned to a required string; TS2322 at (813,3), nullable `base.unit` conflicts with required string; TS2339 at (966,35) and (980,35), `entryQuantity` absent on `PostTransferInput`; TS2322 at (967,32) and (981,32), nullable strings assigned to required strings.

The four `batch-level.ts` diagnostics, the one `physical-inventory.ts` diagnostic, and the one `production-orders.ts` diagnostic from the earlier assessment remain present. All 22 focused diagnostics were confirmed in the complete 794-diagnostic project output; the focused log remains a subset, not a substitute for the full log.

## Historical Quality capability root cause — pre-fix (superseded)

`src/modules/quality/usage-decision.ts` defines and exports the authoritative `USAGE_DECISION_CAPABILITY` value (`QM.USAGE.DECIDE`). The Quality inspection page incorrectly imports it from `src/modules/quality/inspection-results.ts`, which exports only the inspection-result capability. The server actions already import the usage-decision capability from the authoritative module. This is an import-source mismatch; no duplicate capability or broader authorization is warranted.

The production build lists `/quality/inspection`, but it emitted the unresolved-import warning twice and explicitly skipped type validation. The route, action authorization, navigation, and user workflow were **not** runtime-verified. Relevant existing tests include `tests/qm-inspection-results.test.ts`, `tests/qm-usage-decision.test.ts`, and `tests/quality-lot.test.ts`; they were not run because this task was diagnostic-only.

## Database, migrations, and security

- Database operations performed: **none**.
- Migrations/schema changes: **none**.
- No persistent acceptance database was accessed.
- No credential value was disclosed. `.env.local` was read programmatically only for the owner-authorized test-server connection variables; no environment file was changed.

## Historical remaining Phase 1 work — pre-fix list (superseded)

1. Complete the root-cause/dependency classification for all 246 in-scope diagnostics, then fix by shared contract/root cause in bounded batches, with focused typechecks and tests after each.
2. Resolve all genuine project diagnostics, including the six previously focused inventory issues, the Quality inspection page/actions/UI errors, and the remaining current errors across `src/`, `tests/`, and `scripts/`.
3. Verify authorized and unauthorized Quality inspection access, action-level capability checks, route/navigation registration, and resolve both build warnings by correcting the authoritative import.
4. Run `npx next typegen`, the full 3,072 MiB typecheck (zero diagnostics), safe applicable focused/broader tests, and a production build after removing `typescript.ignoreBuildErrors: true`; do not claim skipped or DB-blocked tests as passing.
5. Review all diffs and update this report. Git author identity is currently absent and the local checkout has no remote configured; if unchanged at completion, leave changes uncommitted/unpushed and report the exact condition. Preserve unrelated/untracked files and do not access prohibited databases or Phase 2 scope.

**Historical next-batch instruction (superseded):** see the current implementation decision at the end of this file; Phase 2 remains unopened.


## Prior Phase 1 implementation checkpoint — before database finalization (2026-11-03)

This section preserves the implementation/type/build checkpoint recorded before the authorized disposable-database suites ran. Its pre-finalization runtime and database-verification statements are superseded by the latest “Database verification and change delivery” section at the end of this file. The work was carried out only on `development`, starting from baseline `8966116aa56dde3e1b64012603f26b0a00434542`. Roadmap order is unchanged.

### Criteria and outcome

| Criterion | Status | Evidence / boundary |
|---|---|---|
| Complete intended-project diagnostic evidence and actionable inventory | **PASS** | Baseline was 246 diagnostics in 71 files after excluding only the five non-executable `notes/walk-{a,b,c,d,e}.ts` fragments. Every baseline diagnostic’s exact file/line/column, code, message, and continuation text is in [PHASE1-DIAGNOSTIC-INVENTORY.csv](./PHASE1-DIAGNOSTIC-INVENTORY.csv); the shared-root/caller/test map is in [PHASE1-DIAGNOSTIC-INVENTORY.md](./PHASE1-DIAGNOSTIC-INVENTORY.md). |
| Correct shared source, caller, and test contracts without suppressions or weakened types | **PASS** | The final full-project typecheck is zero-diagnostic. Root families include production settlement, inventory/material movement, People/time leave, purchasing, finance/credit memo, Quality, production configuration, scripts, and tests. No `any`, suppression, fake business defaults, test removal, or broad path exclusion was used to make the check pass. |
| Quality capability import and action boundaries | **IMPLEMENTED; RUNTIME PART UNVERIFIED** | Inspection page imports the authoritative `USAGE_DECISION_CAPABILITY` from `src/modules/quality/usage-decision.ts`; UI input/result handling and action result contracts were corrected. Existing session and action-level capability checks were reviewed. Database-backed workflow, authorization outcomes, and no-partial-stock/business-update behavior could not be exercised because integration DB setup failed before tests ran. |
| Remove `typescript.ignoreBuildErrors` only after independent clean check | **PASS** | `next.config.ts` suppression was removed after a complete zero-diagnostic typecheck. The separate production build below also ran Next’s `Checking validity of types` stage. `eslint.ignoreDuringBuilds` is pre-existing and was not changed. |
| Production build with TypeScript validation enabled | **PASS** | `npm run build` exited 0; the log explicitly shows `Checking validity of types ...`, not `Skipping validation of types`. |
| Relevant tests | **PARTIAL** | Database-free walkthrough contract suite: 2 files / 12 tests passed. Database-backed focused suites were blocked during setup by `ECONNREFUSED` to `127.0.0.1:55435`; no tests in that invocation ran. No database retry or service startup was performed. |
| Canonical status, Git/remote state, safety | **PASS WITH LIMITATIONS** | This canonical status file and diagnostic inventory are updated. No commit or push was made; details and preserved unrelated state follow below. No persistent acceptance database was accessed or modified. |

### Diagnostic counts and root families

The 246 pre-fix diagnostics were **all cleared**: `src/` 158, tests 84, scripts 4, across 71 files; final full typecheck reports **zero**. Family breakdown (the CSV supplies the exact individual records):

| Shared family | Count |
|---|---:|
| Production settlement | 42 |
| Inventory / material movement | 38 |
| People capabilities / time leave | 29 |
| Purchasing contracts and workflows | 22 |
| Finance / credit-memo UI | 14 |
| Quality inspection / usage decision | 9 |
| Browser/database-guard scripts | 4 |
| Production configuration UI | 2 |
| Other app/shared contracts | 2 |
| Tests and fixtures | 84 |
| **Total** | **246** |

Repairs corrected source contracts/callers, nullability and optionality, SQL/posting projections, form/action state types, test fixtures, and DOM/query types. Settlement and stock workflows retain validation and honest failure states rather than substituting business values. Tests were updated to match the corrected contracts; none were removed or marked skipped as a workaround. Exact root descriptions and test mappings are in the linked inventory.

### Exact final verification

All commands below ran in the hash-verified isolated snapshot of the intended `development` baseline plus the 70-file implementation archive; they did not use or overwrite the dirty/stale runbook checkout.

| Command | Result and duration |
|---|---|
| `npx next typegen` | **PASS**, exit 0, 1.30 s real. |
| `env NODE_OPTIONS=--max-old-space-size=3072 npm run typecheck -- --pretty false --incremental false` | **PASS**, exit 0, **0 diagnostics**, 79.74 s real (101.99 s user, 2.49 s sys). This forces a fresh full-project check after type generation and after the final test-helper/cast cleanup; no incremental build-info result is relied on. |
| `env CAIRN_ENV=production NODE_OPTIONS=--max-old-space-size=3072 npm run build` | **PASS**, exit 0, 217.48 s real (308.74 s user, 17.49 s sys). Next compiled successfully and logged `Checking validity of types ...`, then generated all 22 static pages. Thus TypeScript validation was enabled and succeeded in the production build. |
| `env NODE_OPTIONS=--max-old-space-size=3072 npm run test:walkthrough:contract -- --reporter=verbose` | **PASS**, 2 test files / 12 tests, 2.15 s real (Vitest duration 1.67 s). |
| Authorized focused DB-backed test invocation | **BLOCKED BEFORE TEST EXECUTION**: integration setup received `ECONNREFUSED` for `cairn_integration` at `127.0.0.1:55435`. No test results are claimed for those suites. Do not retry/start a DB without authorization. |

Final remote evidence logs are in the isolated snapshot parent `/tmp/cairn-phase1-implementation-8966116-scope1/`: `typegen-final.log`, `typecheck-final.log`, `typecheck-final.time`, `typecheck-final-independent.log`, `typecheck-final-independent.time`, `production-build-phase1-final.log`, and `database-free-contract-tests-final.log`. Snapshot archive SHA-256: `0a0f93c848cc7cab72785fe3587e930e2daaed1ba2779898ee54b0b009e4073a`. The complete pre-fix compiler log remains `/home/user/cairn-phase1-remote-typecheck-8966116-scope1.log`.

### Git, workspace, and database safety

- Work remained on local branch `development`; source HEAD remains `8966116aa56dde3e1b64012603f26b0a00434542`. The implementation touched the 70 intended source/test/config files (71 files appear in the tracked diff including the pre-existing unrelated `CAIRN-7.md` edit, which was preserved and not included in the verification archive). `IMPLEMENTATION-STATUS.md` and this originally untracked `docs/PROJECT-STATUS.md` were preserved. The two diagnostic inventory files are newly added untracked artifacts.
- Nothing was staged, committed, or pushed. The local repository has no configured remote and Git author identity remains unset; no identity or remote was invented/configured. The documented test-server checkout remains untouched at `ce9c65086d4d3623aff63b250d9fb7acef8dcc7f`, dirty and 62 commits behind its recorded remote. All final checks used the isolated snapshot.
- The integration database connection was refused before test execution. No migrations, seeds, reset/cleanup, or writes to any database were run; no persistent acceptance database was accessed. No credential was printed, `.env.local` was not modified, and no host/VM/resource setting was changed.

### Remaining risks and decision

- Database-backed settlement, finance, inventory, People, purchasing, and Quality test suites remain unverified in this environment. Quality runtime authorization and atomic no-partial-update behavior therefore remain an explicit acceptance risk; static review and type/build success are not substitutes for those tests.
- No lint result is claimed; the existing `eslint.ignoreDuringBuilds` setting is outside the requested TypeScript reliability change.
- **Phase 1: PARTIALLY COMPLETE, not accepted as fully complete** until the authorized relevant database-backed tests and Quality runtime workflow checks can run and pass. **Phase 2: NOT STARTED — do not begin it.**

## Database verification and change delivery — latest (2026-11-03)

This is the current finalization record and supersedes the pre-finalization database/runtime statements above. The Phase 1 decision remains **PARTIALLY COMPLETE**; Phase 2 remains **NOT STARTED**.

### `ECONNREFUSED` diagnosis and authorized target

- The original refusal was from the Arena workspace network namespace, not evidence that PostgreSQL on the test host was stopped. In the workspace, `/proc/self/ns/net` was `net:[4026531840]`, there was no listener on port `55435`, and a loopback socket diagnostic returned `ConnectionRefusedError: 111`.
- Via the documented Pexpect SSH path, the test host `cairn` had a different network namespace (`net:[4026532947]`). PostgreSQL 17.11 was listening only on `127.0.0.1:55435`; `pg_isready -h 127.0.0.1 -p 55435 -d cairn_integration` reported “accepting connections.” The runbook records this listener as loopback-only. Therefore `127.0.0.1` in the Arena VM and `127.0.0.1` on the test host are different endpoints; the guarded command had to execute on the test host. No host listener, network, or resource setting was changed.
- The documented persistent `cairn_integration` and `cairn_acceptance` application databases were not migrated, reset, reseeded, or written. Only guarded readiness/identity checks used to validate the test infrastructure were made; all application tests used task-created, dated `cairn_migration_test_...` databases.

### Database-backed results

The broad suites used task-created `cairn_migration_test_20261103_p1verify`, owner `cairn_integration_migrator`, runtime role `cairn_app`, with the required `cairn_integration_guard.cluster_identity()` guard. It stood with 335 migrations and the guarded integration preflight accepted the endpoint/role/target. Results below are from the implementation snapshot **before** the subsequent transaction-boundary correction described in Quality scope below.

| Suite group | Files | Result |
|---|---:|---:|
| Settlement / finance / production | 24 | 156 passed |
| Inventory | 26 | 242 passed |
| People / purchasing / Quality / configuration, including the DB-resolved Quality action test | 27 | 411 passed, 1 failed, 13 skipped |
| **Aggregate** | **77** | **809 passed, 1 failed, 13 skipped** |

The single failure was `tests/routing-execution-order-audit.test.ts`, which asserts ACL ownership/grantor text `cairn=arwdDxtm/cairn`. The actual isolated DB ACL was `{cairn_integration_migrator=arwdDxtm/cairn_integration_migrator,cairn_app=ar/cairn_integration_migrator}`. This is the documented secure separation between migrator owner and runtime read-only role. The assertion and role setup were not altered. The QM usage-decision suite passed 7/7 before the final transaction-boundary change. The new `tests/quality-inspection-action-security.test.ts` passed 3/3 on `p1verify`: persisted users and roles were used to create sessions, then `resolveSession` loaded their capabilities from the database; no-role actions were refused, inspector-only actions were allowed, and usage-decision permission was denied/allowed by role.

### Quality: source verification versus runtime evidence

- The final source keeps the authoritative `QM.USAGE.DECIDE` capability import, capability checks before action writes, and the decision/stock/audit work in the existing tenant transaction. A source review found that the old Quality stock callback called public `postTransfer()`, which opened a separate `withTenant()` transaction. The Phase 1 correction adds `postTransferInTx(tx, ...)`, checks `current_setting('cairn.client')` matches the requested tenant, and calls it from `postUsageDecisionWithStock` so the transfer, usage decision, and audit share one transaction. A regression test was added to `tests/qm-usage-decision.test.ts` to force the decision write to fail after transfer work and assert stock, material document, decision, and audit are all rolled back.
- The final corrected source and regression test are covered by the fresh typecheck and production build below, but the new database rollback case is **not runtime-verified**. The authorized runner was invoked on a newly created `cairn_migration_test_20261103_p1atomic` (335 migrations), then stopped before test discovery because that DB lacked `cairn_integration_guard.cluster_identity()` (`schema "cairn_integration_guard" does not exist`; 0 tests ran). The runbook’s guard script is bootstrap-owned. No guard bypass, role/grant change, or alternate test command was attempted; no authorized bootstrap-admin access path was established for this new DB. This is the remaining blocker for runtime verification of the final atomicity correction.
- Separately, `tests/quality-lot.test.ts` passed on `p1verify`, verifying cross-tenant reads/writes and a `quality_lot` CREATE audit record. The earlier `qm-usage-decision.test.ts` 7/7 run verified persisted decisions, accepted/rejected stock outcomes, incomplete-result and duplicate rejection, and readback; those results predate the transaction correction and do not prove its rollback behavior. Source/type/build evidence is not a substitute for rerunning the final DB regression under the guard.

### Final source/build verification

On the final isolated source snapshot (including the transaction-aware helper and rollback test), after `npx next typegen`:

- `NODE_OPTIONS=--max-old-space-size=3072 npm run typecheck -- --pretty false --incremental false` — **PASS, exit 0, zero diagnostics**, fresh full-project check.
- `CAIRN_ENV=production NODE_OPTIONS=--max-old-space-size=3072 npm run build` — **PASS, exit 0**; Next logged `Checking validity of types ...`, compiled successfully, and generated 22/22 static pages.
- The first final-build attempt exposed that the temporary snapshot’s `node_modules` was a symlink into the dirty server checkout and its Next package was incomplete. I removed only the symlink inside the task-created `/tmp` snapshot, ran `npm ci --no-audit --no-fund` there (178 packages), and reran the build successfully. The dirty `/home/cairn/cairn-erp` checkout and its `node_modules` were not changed.

### Database cleanup and delivery state

- Before cleanup, each task-created DB was checked for exact owner `cairn_integration_migrator`, zero active sessions, and zero `T###` development test tenants. `p1verify`, earlier unusable `p1r2`, and the final `p1atomic` preflight DB were then dropped; final catalog checks showed zero remaining databases and sessions for those exact names. No unrelated or persistent DB was dropped.
- The repository remains on `development` at baseline `8966116aa56dde3e1b64012603f26b0a00434542`. Nothing was staged, committed, or pushed. The dirty/stale server checkout and its owner files remain preserved. `.env.local` was not edited; secrets were not printed.
- The final change inventory, clean-baseline patch, exact full-source snapshot archive, and their SHA-256 records are preserved in the separate workspace folder `cairn-phase1-finalization-8966116/`. The patch excludes the unrelated `CAIRN-7.md` edit and the owner’s `IMPLEMENTATION-STATUS.md`; its clean-baseline applicability and file contents are verified. Artifact names and checksums are in the final handoff report.

**Current decision: Phase 1 PARTIALLY COMPLETE.** Typecheck/build and the earlier broad DB suites pass apart from the documented ACL mismatch, but final atomicity runtime verification is blocked by the missing bootstrap guard on the only newly created test DB. Do not bypass the guard or alter the migrator/runtime role design. **Phase 2 remains NOT STARTED.**


## Phase 2 implementation checkpoint — 2026-11-03

**Phase 2 is in progress but incomplete.** At the start of this Phase 2 batch the checkout had 80 tracked modified paths, 0 staged, and 5 untracked files. This batch changed two tracked paths (`scripts/backup-integration-db.py` and `docs/DEVELOPMENT-OPERATIONS.md`) and added one untracked test. The current checkout remains `development` at baseline `8966116aa56dde3e1b64012603f26b0a00434542`, with 82 tracked modified paths, 0 staged, and 6 untracked files. No owner changes were replaced. The prior Phase 1 status above is retained; current code presence is not treated as proof that every Phase 1 acceptance gate passed.

### Completed bounded change

- Hardened `scripts/backup-integration-db.py` manifest publication: verified JSON is written to an exclusive mode-0600 temporary file, flushed/fsynced, then atomically published without overwriting an existing manifest. A stale manifest-temp name is detected before the backup dump starts.
- Added `tests/backup_manifest_test.py`: **3/3 passed** using only Python's standard library and temporary directories. `py_compile` and focused `git diff --check` passed.
- The backup script itself was **not run**. No database, archive, restore, host, environment file, schedule, retention, off-host destination, or production infrastructure was accessed or changed. The change does not establish backup durability, restoreability, monitoring, or a production backup service.

### Owner decisions — still open; no profile selected

| Decision | Options / trade-off | Status |
|---|---|---|
| Recovery objectives/profile | A: daily logical dump; proposed 24h RPO / 8h RTO, simplest, no PITR. B: 4-hour logical dump; proposed 4h / 4h, more storage/transfer, still no PITR. C: full base backups + continuous WAL; proposed 15m / 4h, highest operational/security complexity. All targets are unmeasured and are not commitments. | **Owner decision required** |
| Cadence, retention, restore drills | Select backup frequency, daily/weekly/month-end retention and drill frequency from business RPO/RTO and legal requirements. Longer retention improves history but raises storage, privacy and deletion obligations. Older D-031 values are not to be configured automatically. | **Owner decision required** |
| Destination/failure domain | Owner-selected independent account/provider/region and data-residency location; separate account/region improves failure isolation but adds cost, transfer and access-management work. | **Owner decision required** |
| Encryption/key custody/access | Choose at-rest or client-side encryption and the key custodian/recovery path; stronger separation limits exposure but makes emergency restore depend on tested key access. Decide who may read, restore, delete, or place holds on backups. | **Owner decision required** |
| Immutability | Object lock/immutable retention reduces ransomware or accidental deletion risk but can prevent early deletion and complicate legal holds; ordinary versioned storage is more flexible but less resistant to privileged deletion. | **Owner decision required** |
| Recovery/service ownership | Name business/system owner, DBA/SRE, security/key custodian, incident commander, recovery/cutover authority and reconciliation approver. Two-person restore approval adds control; single-operator approval can be faster. Define support hours and escalation. | **Owner decision required** |
| Monitoring/logging | Select managed or self-hosted monitoring, alert channel and on-call rota; managed service adds cost/dependency, self-hosting requires staffed operation. Set SLOs, thresholds, log access/retention and test alert delivery. | **Owner decision required** |
| Production/deployment/data scope | Confirm actual production topology and deployment model (Compose or another platform), data classification, jurisdiction and legal retention. No production environment is identified in this task. | **Owner decision required** |
| Source integration | Approve a clean destination/branch and owner review of the dirty working tree. No commit/push performed; no main or `cairn_b210` access. | **Owner decision required** |

No production capability is inferred from the test-host assessment or repository configuration. Do not start a restore rehearsal until a backup profile and authorized independent source are approved. Do not begin Phase 3.


## Phase 2 — Batch 2: application liveness endpoint (2026-11-03)

**Status: bounded implementation and isolated verification complete; Phase 2 remains in progress.** No Phase 3 work began.

### Implementation and documentation

- Added `src/app/api/health/live/route.ts`: `GET /api/health/live` uses the explicit Next.js `nodejs` runtime and `force-dynamic`; returns HTTP 200 with exactly `{"status":"ok"}` and `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`, `Pragma: no-cache`, and `Expires: 0`. It imports no application/database code, reads no environment settings, and performs no external checks. No write-method handlers are exported.
- Added `tests/health-live.test.ts`: covers the 200 response and JSON shape, method-handler contract, runtime/dynamic settings, cache-prevention headers, and absence of sensitive information.
- Updated `docs/DEVELOPMENT-OPERATIONS.md`: documents endpoint semantics, distinguishes liveness from readiness, and states that liveness does not prove database connectivity, migration readiness, backup freshness, or restoreability. It also records that the Dockerfile's existing `/signin` healthcheck was not changed and that no monitoring integration is implied.
- Updated `CAIRN-7.md` §30, row 2.877. No Dockerfile, Compose, environment, monitoring, production, backup, or database configuration was changed.

### Verification (isolated only; no running application)

- `npm ci --no-audit --no-fund` — **PASS**, 177 packages installed; `package-lock.json` remained unchanged. No project test server or database was contacted.
- `npx vitest run --config .phase2-health-vitest.config.ts --reporter=verbose tests/health-live.test.ts` — **PASS**, 1 file / 5 tests. The temporary config set `globalSetup: []` and `envDir: false` to avoid the repository's database-connecting/fixture-cleaning global setup and to avoid loading environment files. The temporary config was removed after the run.
- `npx tsc --project .phase2-health-tsconfig.json --noEmit --pretty false` — **PASS**, exit 0, zero diagnostics for the route and focused test. The temporary scoped config was removed after the run.
- The route was tested by directly invoking the handler in Vitest, **not** through a running Next.js application. Unsupported write-method behavior is verified by asserting that no POST/PUT/PATCH/DELETE handlers are exported; an HTTP 405 response was not exercised through a server.
- No full-project typecheck/build, database test, remote test-server access, `.env.local` access, or production check was performed. The endpoint is not wired to the Dockerfile healthcheck, and no external monitor or readiness endpoint is configured.

### Worktree after Batch 2

Branch remains `development` at `8966116aa56dde3e1b64012603f26b0a00434542`; 82 tracked modified paths, 0 staged, and 8 untracked paths. Existing owner changes remain preserved. `node_modules` was installed locally for the focused tests and is ignored/excluded from workspace snapshots; package metadata was not changed.


## Phase 2 — Batch 3: container liveness integration (2026-11-03)

**Status: source/configuration change complete; container verification blocked by unavailable tooling.** Phase 2 remains in progress; no Phase 3 work began.

### Change

- `Dockerfile`: changed only the application healthcheck target from `/signin` to `http://127.0.0.1:3000/api/health/live`. Preserved `--start-period=20s`, `--interval=30s`, `--timeout=5s`, `--retries=3`, and startup command `CMD ["node", "server.js"]`.
- `docs/DEVELOPMENT-OPERATIONS.md`: documents the in-container loopback healthcheck, unchanged thresholds, and that it is liveness only—not database readiness, backup health, restoreability, or evidence of production deployment.
- `CAIRN-7.md`: appended §30 row 2.878. The Batch 2 untracked route and test, and all other owner files, were preserved.

### Verification and runtime limitation

- Preflight: `git branch --show-current` → `development`; `git rev-parse HEAD` → `8966116aa56dde3e1b64012603f26b0a00434542`; prior worktree remained dirty and unstaged.
- `command -v docker` → Docker not installed; `command -v podman` → Podman not installed. The documented `docker compose build app` was **not run**. No image/container was built or started.
- Static Dockerfile/route assertions passed: the healthcheck references only the in-container loopback liveness URL; timing thresholds and startup command are unchanged; the route returns only `{"status":"ok"}` and contains no database/network/environment access. `git diff --check -- Dockerfile docs/DEVELOPMENT-OPERATIONS.md` passed.
- No in-container endpoint request, healthy status, unhealthy transition, application-stop test, or container cleanup was possible. No resources were created, so no cleanup was needed. No database, `.env.local`, test server, backup configuration, or production infrastructure was accessed.
- Final Git status: branch `development` at the same baseline; 83 tracked modified paths, 0 staged, 8 untracked paths. No stage, commit, or push.

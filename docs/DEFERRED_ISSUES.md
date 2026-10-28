# Deferred issues — Cairn ERP

**Started:** 2026-10-27 (roadmap checkpoint after Pass 35 / Pass 36). No other deferred-issues tracker
existed in the repo — `docs/` held only per-transaction audits, and the project log records decisions
(`D-nnn`), requirements (`R-nn`) and findings (`FND-nnn`) inline — so this file is the queue of *non-blocking*
findings, kept separate from `pp-stage1-settlement-production-readiness.md`, which is the pass log.

**Rules.** IDs are stable and never reused. An entry is appended, never rewritten; when work closes an entry its
status changes to `CLOSED` with the commit that closed it, and the text stays. A finding is not deferred because
it is inconvenient: `DEFERRED` here means it was examined, judged non-blocking under §4 of the checkpoint brief
(no authorization or security bypass, no integrity or persistence risk, no broken business transaction, no
blocked milestone), and given acceptance criteria so the next person can close it in one pass.

| ID | Title | Severity | Area | Status |
|---|---|---|---|---|
| DI-001 | A claim still in flight reads as writable on `mode !== 'DISPLAY'` screens | Medium | Change lock / UI | OPEN |
| DI-002 | A failed claim on a legacy screen offers no retry control | Medium | Change lock / UI | OPEN |
| DI-003 | A failed claim is announced politely, not urgently, on legacy screens | Low | Accessibility | OPEN |
| DI-004 | No browser acceptance target for the change-lock configuration screens | Medium | Test coverage | CLOSED (`1102554`) |
| DI-005 | Browser coverage still stops at one lock per configuration screen | Low | Test coverage | OPEN |
| DI-006 | StrictMode claims, releases and re-claims once in development | Low | Change lock / React | OPEN |
| DI-007 | Ten `t()` keys resolve to their own name in finance and GL screens | Low | i18n | OPEN |
| DI-008 | `typecheck` reports 149 errors while `next.config.ts` says types are gated | High | Build gate | OPEN — owner-occupied |
| DI-009 | The settlement masters' action layer has no authorization test | Low | Settlement configuration | OPEN |
| DI-010 | One settlement rule per order, and the rule screen takes no session of its own | Low | Settlement rules | DEFERRED BY DECISION (D-11, D-12) |
| DI-011 | Read-only actions behind a claim gate: swept on one screen only | Low | Change lock / UI | OPEN |
| DI-012 | The order has no money basis, so variance, WIP and settlement cannot be built | High | PP / CO | OPEN — needs schema authorization |
| DI-013 | Production documentation denied behaviour that had shipped | Medium | Documentation | CLOSED by this commit |
| DI-014 | Five production screens gate on capability codes the registry does not hold | Medium | Authorization / PP | OPEN — needs a registry decision |
| DI-015 | Sixteen browser acceptance targets cannot reach the assertion they were written to make | Medium | Test harness / browser targets | OPEN — 21 files repaired by this commit |
| DI-016 | Six sibling validators repeat the quantity check that mis-fired at CO01 | Low | PP validation | OPEN |
| DI-017 | Thirty-five fixtures still choose a material type by which one sorts first | Low | Test fixtures | OPEN |
| DI-018 | Sales pricing resolves an item price and no other condition type | Medium | SD pricing | OPEN |
| DI-019 | Credit exposure counts invoiced receivables only, so no sales document is in the basis before billing | Medium | SD credit control | OPEN |
| DI-020 | Delivery, goods issue and billing for a sales order line, credit-bound | High | SD order-to-invoice | OPEN — built and verified on the test box; open for the AR tail past the invoice and the re-bill path (see below) |
| DI-021 | The sales order-to-invoice journey has no browser acceptance run | Medium | Test harness / SD | DEFERRED BY DECISION (owner instruction 2026-10-28: no browser target runs until the test server is in use) |

---

## DI-001 — A claim still in flight reads as writable on `mode !== 'DISPLAY'` screens

* **Severity:** Medium. **Area:** `src/ui/lock/claim.ts` `projectClaim`, and the **15** screens of the form
  `const writable = canMaintain && lock?.mode !== 'DISPLAY'`.
* **Evidence:** `projectClaim` returns `null` for `idle` and `pending` on purpose — a projection that answered
  "not yet answered" as "not writable" would disable every form in the app for one round trip. Measured in Pass 36:
  **196** projection-`mode` comparisons in **119** files outside `src/ui/lock/`. §20.7 of the pass log records it.
* **Impact:** during the owed window a legacy form looks editable and accepts a press. Nothing is written — the
  action calls `assertChangeForSession` and answers an `EnqueueError` with the platform's own two sentences — so
  this is a *silence* problem, not a lost update. `batch-document-management` proves in a browser that during that
  window nothing is written, no lock stands, and no notice appears.
* **Why deferred:** making the client honest here is a decision about every form in the app (disable? dim? show a
  "opening…" line?) and needs owner-approved copy. It is not a defect the checkpoint brief's priority rule
  escalates.
* **Acceptance criteria:** one stated answer for the whole family — either `projectClaim` returns a non-`null`
  "claim owed" view that the gates read as closed, or the screens keep `null` and each migrated screen shows a
  pending affordance; pinned by a measurement case in `tests/change-lock-claim.test.ts` (`pending` → the chosen
  answer) and by the existing browser targets' owed-window phase, which must still see no write and no lock.

## DI-002 — A failed claim on a legacy screen offers no retry control

* **Severity:** Medium. **Area:** `src/ui/lock/ChangeLock.tsx` (`LockNotice` vs `ClaimFailureNotice`); the
  unmigrated consumers of `useChangeLock`, e.g. all three sections of
  `src/app/config/settlement-configuration/SettlementMasters.tsx` (`:212`, `:482`, `:663`).
* **Evidence:** only the four migrated screens render `ClaimFailureNotice`, which is where the `lock.claimRetry`
  button lives. Elsewhere a `failed` claim reaches the screen as a `LockNotice` whose remedy sentence is
  `lock.claimFailedRecovery` — "Nothing was written. **Try again**, and if it fails again ask an administrator to
  check the server log." — while nothing on that screen is labelled as such. The recovery that does work is
  re-opening the row (Close → Edit), which files a fresh claim; the `settlement-configuration` browser target added in
  the checkpoint after Pass 36 proves exactly that path, and its contract test refuses to let that target claim a
  retry control the screen does not render.
* **Impact:** the copy invites an action the screen does not carry. An operator re-selects the row or reloads;
  nothing is corrupted and nothing is double-applied (the reducer keeps `retry` a no-op off `failed`, and a fresh
  claim starts clean).
* **Why deferred:** the fix is a UX decision for ~110 screens — either mount the shared notice with its control
  everywhere, or split the copy so a screen without a control says "open the record again". Per the brief, the
  change-lock refactor must not be broadened merely to remove the inconsistency.
* **Acceptance criteria:** owner picks one of the two shapes; then either (a) `useChangeLock` returns the claim
  handle (not only the projection) so a screen can mount `ClaimFailureNotice` without migrating, with the choice
  recorded in §20-style prose, or (b) a new catalogue key for the no-control variant, with a source pin asserting
  that no screen renders `lock.claimFailedRecovery` while lacking `lock.claimRetry`'s control.

## DI-003 — A failed claim is announced politely, not urgently, on legacy screens

* **Severity:** Low. **Area:** `LockNotice` (`role="status"`), `ClaimFailureNotice` (`role="alert"`).
* **Evidence:** `LockNotice` returns `<p role="status">` for *both* a refusal and a failure; a failure is a
  different fact — nothing will be saved and the operator must act — and the migrated screens announce it with
  `role="alert"`. `grep -n "role=\"status\"" src/ui/lock/ChangeLock.tsx:140`.
* **Impact:** a screen-reader user may not hear that the claim died, on the screens that were not migrated. No
  functional or authorization consequence.
* **Why deferred:** `role` choice inside a shared component changes what every legacy screen announces, and the
  refusal/failure pair needs separating before that is safe.
* **Acceptance criteria:** `LockNotice` takes the tone from the phase (or a second component is used for failures)
  so a `failed` claim is `role="alert"` and a refusal stays `role="status"`; pinned in
  `tests/change-lock-ux-contract.test.ts` by rendering condition, and one browser target asserts the alert role
  on a legacy screen.

## DI-004 — No browser acceptance target for the change-lock configuration screens — CLOSED

* **Closed by `1102554`** (Pass 36): `movement-types` (T868), `valuation-classes` (T869) and
  `batch-document-management` (T867) each drive their screen through creation without a lock, the owed window, a
  grant, a real second session's refusal, a dead claim, a retry and the release, with the table, `change_document`
  and `public.enqueue_entry` read back at every phase. Each target exits 0 with nine `✓`, and
  `tests/change-lock-configuration-browser-targets-contract.test.ts` (8 cases) pins the harness obligations.
  Recorded here because the checkpoint brief asked for it by name, and it is no longer open.

## DI-005 — Browser coverage still stops at one lock per configuration screen

* **Severity:** Low. **Area:** the four configuration browser targets.
* **Evidence:** `valuation-classes` drives `ACCOUNT_CATEGORY_REFERENCE`; `VALUATION_CLASS` and `MATERIAL_TYPE`
  keep the same gates and notices and are pinned by source only. `settlement-configuration` drives
  `SETTLEMENT_ALLOCATION_STRUCTURE`; `SETTLEMENT_PROFILE` and `SETTLEMENT_ORDER_TYPE` are not driven, and the
  structure's *assignment* forms (`saveAssignmentAction`, `removeAssignmentAction`), which demand the structure
  session even for an add, have no browser phase.
* **Impact:** a regression confined to an undriven lock object, or to the assignment path's `holds = true` rule,
  would be caught by source pins and by module tests, not by a run.
* **Why deferred:** each extra phase costs a fixture row and a claim cycle; the sections share one hook, one
  projection and one notice, so the marginal risk is small.
* **Acceptance criteria:** extend the two targets with one change phase per remaining lock object (valuation class
  row, material-type assignment, settlement profile, settlement order type), plus an assignment add/remove on the
  settlement structure, each asserting its own `lock_object` in `enqueue_entry` and its own `change_document` count.

## DI-006 — StrictMode claims, releases and re-claims once in development

* **Severity:** Low. **Area:** `src/ui/lock/ChangeLock.tsx` `useEffect` teardown, development builds.
* **Evidence:** recorded since Pass 34 (§18) and unchanged: React runs the effect twice in StrictMode, so the
  first claim is released by the teardown and a second is filed.
* **Impact:** none in production; in development the platform's first-opener-wins rule plus session-scoped
  release make it harmless, and a heartbeat keeps the surviving claim alive.
* **Why deferred:** it is a hook-lifecycle question, not a lock-semantics one; the alternatives (a ref guard, a
  `useSyncExternalStore` rewrite) all change teardown behaviour for real unmounts, where the release *must*
  happen.
* **Acceptance criteria:** either a claim that survives the double-invoke without a release/re-claim pair — proved
  by a development-mode browser target that counts `openChangeLockAction` posts per mount — or a recorded decision
  that the extra pair is the intended cost, with the count asserted so a future change cannot add a third.

## DI-007 — Ten `t()` keys resolve to their own name in finance and GL screens

* **Severity:** Low. **Area:** `src/platform/i18n/index.ts` and the finance/GL screens that use them.
* **Evidence:** `pl.*`, `bs.*`, `finance.label`, `mdDoc.document`, `glAccount.matrixUnchanged`,
  `chartOfAccounts.blockedRule` render their key text. Recorded in Pass 35 (§19.6).
* **Impact:** an operator on those screens sees a dotted identifier instead of a label. Cosmetic; no behaviour is
  gated by it.
* **Why deferred:** `src/platform/i18n/index.ts` is **owner-modified right now** (the `co09.*` hunk), so any edit
  there collides with in-flight work. The lock-surface localisation case in
  `tests/change-lock-ux-contract.test.ts` is deliberately scoped to `lock.*` for exactly that reason.
* **Acceptance criteria:** when the owner's i18n hunk has landed: keys added in the same style as the `lock.*`
  group, `LOCALES` unchanged, and the existing localisation case widened to the whole catalogue so no key
  resolves to its own name anywhere.

## DI-008 — `typecheck` reports 149 errors while `next.config.ts` says types are gated

* **Severity:** High as a gate, but **owner-occupied** — do not start this without coordinating.
* **Area:** `next.config.ts:5-9`, the 149 `npx tsc --noEmit` errors, and gap-closure step 1 of
  `/home/user/pp-readiness-assessment.md` §6.
* **Evidence:** `typescript.ignoreBuildErrors: true` and `eslint.ignoreDuringBuilds: true` with the comment
  claiming types are gated by a separate step; the count is **149** at `1102554` (measured this pass; Pass 35 and
  36 recorded the same figure). Five were once in PP services; the concentration is in tests. The assessment also
  notes there is no ESLint configuration file at all — the only lint is `scripts/lint-ip.ts` (141 finding lines,
  red by design).
* **Impact:** a type regression in a service reaches `main` silently, and the build's own comment misstates the
  guarantee — the class of contradiction readiness blocker 8 warns about.
* **Why deferred:** the plan's own step 1 is the owner's current work (`scripts/browser-smoke/co09-availability.ts`,
  `tests/production-order-writer-guard.test.ts` and the PP module hunks are all modified in the tree), and a
  ratchet baseline file would freeze the owner's transient error count into the repo.
* **Acceptance criteria:** after the owner's step-1 landing: a committed baseline file of the surviving errors,
  `npm run typecheck` failing only on errors **not** in it, the `next.config.ts` comment rewritten to say what the
  gate actually is, and the five PP service errors gone rather than baselined.

## DI-009 — The settlement masters' action layer has no authorization test

* **Severity:** Low. **Area:** `src/app/config/settlement-configuration/actions.ts`.
* **Evidence:** recorded in `/home/user/pp-stage1-settlement-ownership-implementation.md`: this database stores no
  `role_capability` rows, so no session holds any capability and an end-to-end authorization test here would
  exercise the platform rather than the screen. The actions use the same `requireCapability` plus
  `assertChangeForSession` as the other 66 config screens, and the module they call is tested.
* **Impact:** a capability-string typo would be caught by `tests/config-settlement-lock-object-contract.test.ts`
  and the screens' refusal copy, not by a granted/denied pair.
* **Why deferred:** needs a tenant with roles; the browser targets sign in as the development administrator.
* **Acceptance criteria:** when a role-bearing fixture exists (or the harness gains `role_capability` rows for a
  disposable tenant): one save refused for lack of `CFG.COST.SETTLEMENT.DEFINE` with the `AuthzError` sentence, and
  the same save allowed once the capability is granted — both read back against `allocation_structure`.

## DI-010 — One settlement rule per order, and the rule screen takes no session of its own

* **Severity:** Low. **Area:** `/controlling/settlement-rules`, `settlement_distribution_rule`.
* **Evidence:** `rule_number` is fixed at 1 with delete-and-insert semantics, and the rule screen opens no enqueue
  session. Both were **declared out of scope** by the owner as D-11 (multi-rule support) and D-12 (the rule
  screen's session-lock question) in the settlement-ownership plan.
* **Impact:** a rule edit is a replace rather than a change, and two sessions editing one order's rule contend on
  the per-order version guard instead of on a lock. No loss: a stale form is refused, and a settled document is
  not rewritten.
* **Why deferred:** explicit owner decision, not drift. Recorded so the next reader finds the decision rather than
  rediscovering it.
* **Acceptance criteria:** only by a new owner ruling. If D-12 is ever reversed, the migration shape is the four
  already-migrated screens: `useChangeLockClaim` with the order's lock object, `LockNotice` for the refusal,
  `ClaimFailureNotice` for a dead claim, and a browser target that proves the second session is refused.

## DI-011 — Read-only actions behind a claim gate: swept on one screen only

* **Severity:** Low. **Area:** the ~110 unmigrated `mode !== 'CHANGE'` gates.
* **Evidence:** Pass 36 found a real instance while driving a screen: `MovementTypes.tsx` had put its **Check**
  button behind `!lockedOut`, although `checkMovementTypeAction` asks the platform for no lock — a refused session
  lost an action it was entitled to take. Fixed there, and pinned (check form outside the refusal guard, delete
  inside). No equivalent sweep was run over the other screens, because the census that justified the shared change
  measured refusal *wording* and boolean guards, not read-only actions placed behind a gate.
* **Impact:** over-gating a read: an operator who was refused a change cannot run a check, a preview or a print that
  would have written nothing. Annoyance, not integrity — but it is the kind of thing that teaches people to open
  two sessions.
* **Why deferred:** finding the cases is a scan plus a per-action reading of whether it takes a lock; the scan is
  cheap, the judgement is per screen, and the brief forbids broadening the refactor to remove every inconsistency.
* **Acceptance criteria:** a script that lists every `disabled={…locked…}` control whose `<form action>` resolves to
  an action with no `assertChangeForSession`/`assertChangeLock` call; each hit then either ungated with a pin in
  its screen's contract test, or kept with a sentence saying why the read needs the opening.

## DI-012 — The order has no money basis, so variance, WIP and settlement cannot be built

* **Severity:** High for ERP readiness. **Area:** `production_order*`, costing, `PROD.ORDER.SETTLE`.
* **Evidence:** `/home/user/pp-readiness-assessment.md` §5 blocker 3 and §6 step 3: nothing on the order says what
  the good cost, no order closes financially, and the settlement capability can be granted to a role and do
  nothing beyond the settlement run's own rules. The proposed smallest increment is "an actual-value column pair on
  `production_order_component`/`production_order` **derived in a view**, not a stored counter, plus a report".
* **Impact:** a manufacturing month cannot be closed from this module alone; a controller reconciles consumption
  against output outside it.
* **Why deferred:** the increment needs a migration (a view, and per §27.010 of the project log its own grant
  declaration) and new persisted surface. The checkpoint brief's §4 forbids schema or migration changes without
  explicit authorization, and the settlement-ownership work that this queue came out of is complete and verified
  for its own scope.
* **Acceptance criteria:** owner authorizes one migration; then a derived read-only projection of
  `work_center_costing` × activity rates × confirmed quantities plus the receipt valuation basis, a report that
  reads it, `PROD.ORDER.SETTLE` still refusing per order until variance and settlement land (step 4), and no
  accumulated counter anywhere — matching `confirmation-movements.ts:10-13`'s "derived, never accumulated here".
* **Update (Pass 38, documentation):** the claim is now stated where a reader will meet it first, so nobody builds
  a settlement screen on the assumption that one exists: `PROD.ORDER.SETTLE` is described as registered-and-inert in
  `src/modules/inventory/production-orders.ts`, in `implemented-functions.md`'s production table, and in step 12 of
  `docs/production-tcode-order.md`. No money basis was invented here, and none of this closes the entry: the
  migration decision above is still outstanding.

## DI-013 — Production documentation denied behaviour that had shipped — CLOSED

* **Severity:** Medium. **Area:** `docs/production-tcode-order.md`, `implementation-status.md`,
  `implemented-functions.md`, the headers of `src/modules/inventory/goods-issue.ts` and
  `src/modules/inventory/production-orders.ts`.
* **What was wrong:** five documents stated, in the present tense, that the production module could not do things
  it had already been extended to do — the 261 component issue ("refused by name — canon has no order master"),
  technical completion and the finished-goods receipt (both listed as deferred in the order module), the BOM
  explosion and planned-order conversion (`MD01` "does not explode a bill of material … does not turn a planned
  order into a production order"), the production order on `MD04` ("does not list a production order", and the same
  claim as an open gap), change of quantity, dates and components ("cannot be changed"), and work centres (listed
  in `implementation-status.md` among "Workbench entries that are not built" while
  `/production/work-centers` and `work-center.ts` exist). The Production table in `implemented-functions.md`
  carried four rows while the application holds 25 production screens over 32 registered `PROD.*` codes.
* **Evidence, measured in this pass rather than recalled:** `GOODS_ISSUE_SCENARIOS` carries
  `code: '261' … screen: 'MIGO'` (`goods-issue.ts:95-98`) and `MB1A_SCENARIOS`/`MIGO_ISSUE_SCENARIOS` are filters
  on that `screen` field (:101-104), so the refusal is a *screen* refusal — `:201` reads "Movement 261 is posted
  from MIGO, not from this screen", which is what `tests/goods-issue.test.ts:211` and
  `tests/migo-component-issue.test.ts:26,152,251` already pinned. `technicallyCompleteProductionOrder`
  (`production-order-change.ts:599`) and `revokeTechnicalCompletion` (`:656`) ship, with `changeType 'TECO'`.
  `PROD.ORDER.GR` ships in `src/modules/inventory/production-receipt.ts` and is granted to the production role in
  `src/platform/tenancy/index.ts:75`. `mrp-run.ts:27` imports `explodePlannedSupply`, and `stock-requirements.ts`
  reads `production_order` as a receipt element (:412) and `production_order_component` as the demand beneath it
  (:484). 25 directories under `src/app/production` hold a `page.tsx`; `find src/app -name page.tsx` returns 236.
* **Resolution:** the five files were corrected to the sentences above — comments and documentation only, with no
  behaviour, no interface and no business rule touched. `tests/production-documentation-consistency.test.ts` pins
  each corrected sentence to the code that makes it true, and holds the function table against the screen tree, so
  a correction cannot rot back and a new screen cannot be left out.
* **What was deliberately not decided here:** the money basis (`CO88`, variance, WIP and settlement) stays exactly
  as DI-012 has it; the `CO09` paragraph was rewritten only to the read-only overview the module already refuses by
  name, and `docs/co09-availability-audit.md` remains the matrix — that screen is under its owner's active work and
  was not edited. `implementation-status.md`'s counts (`169` codes, `166` pages, `71` activities, "fourteen … no
  page") could not be re-derived from any rule, and the file now states the measured catalogue figures and the guard
  that holds the claim instead. A stale count is the same harm as a stale sentence.

## DI-014 — Five production screens gate on capability codes the registry does not hold

* **Severity:** Medium. **Area:** `CAPABILITIES` in `scripts/seed.ts`, `/production/work-centers`,
  `/production/work-center-display`, `/production/confirmation-cancel`, `/inventory/materials?view=MRP`.
* **Evidence:** `src/modules/production/work-center.ts:32-34` defines `PROD.WORKCENTER.{CREATE,CHANGE,DISPLAY}` and
  the two work-centre pages demand them with `requireCapability`; `confirmation-cancel` demands
  `PROD.CONFIRM.CANCEL`; the MRP view records `PROD.MRP.SETTINGS` in the screen catalogue and the term registry.
  None of the four codes appears in `CAPABILITIES` (measured: 33 `PROD.*` rows, 32 unique codes, and no
  `WORKCENTER` or `CONFIRM.CANCEL` among them — only the activity `CFG.PROD.WORKCENTER.DEFINE` is registered). A
  role that can only be granted registered codes therefore cannot be given these screens; a role holding a wildcard
  such as `PROD.*` can, which is what `tests/work-center.test.ts:218-221` exercises. Fail-closed, so not a bypass.
* **Impact:** a tenant configured through the grant screens, rather than by a wildcard, cannot open the work-centre
  or confirmation-cancel screens that the production flow starts at — the same family as the ~28 pages reported to
  fall back to `auth.readOnly`.
* **Why deferred:** the fix is a registry change. `CAPABILITIES` seeds rows that become persisted capability
  identifiers, which the checkpoint brief's §4 puts behind explicit authorization, and DI-008's type/build gate is
  owner-occupied in the same area. Recording it here keeps the next person from concluding the screens are dead.
* **Acceptance criteria:** either the four codes are registered in `CAPABILITIES` with `module: 'PROD'` and the
  action that matches their use, in which case `tests/production-documentation-consistency.test.ts`'s last case
  asks that DI-014 be marked CLOSED in the same commit; or the four pages are re-gated on registered codes
  (`CFG.PROD.WORKCENTER.DEFINE` and `PROD.CONFIRM.ORDER` respectively), in which case `implemented-functions.md`'s
  production table loses its "built screens not in the registry" sentence. No third option: leaving the codes
  unregistered while the catalogue prints them is what makes a grant list and a screen disagree.


## DI-015 — Sixteen browser acceptance targets cannot reach the assertion they were written to make

* **Severity:** Medium. **Area:** `scripts/browser-smoke`, the acceptance evidence for PP, SD/AR and FI.
* **Evidence:** of the 42 targets run on 2026-10-27 against a build of `main`, 16 exit non-zero while the
  vitest suite stayed green, because nothing in the suite opens a browser. Twenty-one files, 46 lines of
  them typed into a `<select>`: `page.fill('input[name="companyCode"]', …)` and its row variants, against
  fields `ConstrainedField` renders as a closed select because their kind is in `CLOSED_KINDS`. Those are
  repaired by this commit, together with five fixtures that paired a RAW valuation class with a FIN
  material type and three that asserted copy the screens had reworded. The 16 that still fail wait for a
  `section[aria-labelledby=…]` the screen no longer uses — `aq-entry`, `dp-entry`, `rt-reverse`,
  `op-header`, `cdpc-header`, `vdpc-header`, `info-record-create` — for a `p[role="status"]` that
  `goods-issue.ts:217` and `scr144-close-the-gaps.ts` expect in other words, or for
  `[data-cancel="PI-2026-0000001"]` in `physical-inventory.ts:145`, an anchor carrying a document number
  the run does not produce. The per-target text is in `/tmp/p39-<target>.out` on the verification box.
* **Impact:** the workflows behind those 16 targets — fixed-asset acquisition, depreciation and retirement,
  the down-payment and outgoing-payment legs, the info record and the MB1A goods-issue status — have unit
  coverage and no current screen-level evidence. A reviewer following the acceptance standard cannot mark
  them accepted from a green run, and a broken screen in one of them would read exactly like a stale target.
* **Why deferred:** each is target-side drift, not product behaviour: the screens renamed their sections and
  reworded their status lines while the targets were last touched. Repairing 16 files needs the same
  read-the-component-then-rewrite cycle this commit applied to 21, and it is mechanical work with no
  business decision in it, so it does not compete with the PP money basis or the SD document chain.
* **Acceptance criteria:** `bash /home/cairn/p39-wide.sh 1` and `… 2` report `fail=none` for all 42 targets
  against a build of `main` with `server_errors=0`; each repaired target keeps its assertion on the
  persisted result (a row read back through `withTenant`, not a screenshot); and no repair removes a check
  — a target that cannot be made to pass is deleted only with the flow it covers re-covered elsewhere.
  `tests/browser-target-constrained-driving.test.ts` must stay green and must still fail on the mutant
  described in its header, so a repaired target cannot drift back into typing into a select unnoticed.

## DI-016 — Six sibling validators repeat the quantity check that mis-fired at CO01

* **Severity:** Low. **Area:** `src/modules/production` quantity-scale validation.
* **Evidence:** this commit fixed `production-version.ts:195` because `order-bom-snapshot.ts:85` hands the
  check `input.orderQuantity.toFixed(3)`, and three padding digits exceed the zero places `PC` allows. The
  same expression — `(text.split('.')[1] ?? '').length > Math.min(3, decimals)` — stands at
  `material-bom.ts:273`, `routing.ts:365`, `time-ticket.ts:249`, `production-order-change.ts:153`,
  `planned-order-create.ts:124` and `planned-order-change.ts:125`. Only the version check is known to be
  fed normalized text; the others read what the screen sent, so no refusal is demonstrated at them today.
  `production-order-change.ts` is the one to watch: a change form that prefills from a numeric column reads
  back `25.000`.
* **Impact:** if any of those paths receives padded text, a count-unit material is refused for a number the
  user never typed, the way CO01 was. Nothing else: the rule itself — refuse rather than round — is
  deliberate and stays.
* **Why deferred:** changing six validators on the strength of one demonstrated case would widen a
  validation relaxation beyond the evidence, and CAIRN.md's DV-003 owns the rule. The fix belongs with a
  case that reproduces a refusal, not with a resemblance.
* **Acceptance criteria:** either a test shows a padded value reaching one of the six and the significant-
  fraction comparison is applied there too, or each site gains a test proving that a whole number for a
  zero-decimal unit passes and `x.001` is still refused, which makes the difference intentional rather than
  latent.

## DI-017 — Thirty-five fixtures still choose a material type by which one sorts first

* **Severity:** Low. **Area:** `scripts/browser-smoke` fixtures.
* **Evidence:** `grep -rln "order by material_type limit 1" scripts/browser-smoke | wc -l` reports 35
  targets. The pattern inserts a material with `t.material_type` from
  `(select material_type from material_type … order by material_type limit 1)` while the same fixture sets a
  valuation class by hand. `valuation-class-definition.ts:427` refuses a class the material type's account
  category reference does not permit, which is exactly how `migo-component-issue`, `goods-issue`,
  `migo-transfer-posting`, `physical-inventory` and `journal-document-display` failed until this commit named
  `RAW` or `FIN` per material.
* **Impact:** a fixture can fail with "Valuation class … is not allowed for material type …" and read like a
  ledger defect when it is a fixture guess; and the pair can also agree by accident, which hides the rule the
  ledger is enforcing.
* **Why deferred:** five files were repaired because their targets were being run anyway. The remaining 30
  are untouched by this pass, and rewriting a fixture that passes has no acceptance value — it would be
  standardizing working code, which the brief rules out.
* **Acceptance criteria:** when one of those targets is next repaired or extended, its material insert names
  the type its valuation class belongs to, and the refusal message it would otherwise hit is quoted in the
  commit note. A fixture that has to pick a type from what exists is replaced by one that creates the type
  it needs. No new shared helper: the pairing is per material and a helper would hide it again.

## DI-018 — Sales pricing resolves an item price and no other condition type

* **Severity:** Medium. **Area:** `src/modules/sales`, SD pricing.
* **Evidence:** migration `drizzle/9190` constrains both `sales_pricing_step` and `sales_condition_record`
  to `condition_type = 'PR00'`, and `src/modules/sales/pricing.ts` reads exactly three accesses
  (customer-and-material, material alone, customer alone) for the order date. There is no pricing-procedure
  table, no step table and no access sequence: `grep -rn "material_sales" src/modules` returns nothing, and
  `customer_sales_area.pricing_procedure` is a validated varchar no code resolves. CAIRN.md:2032-2044 puts
  full pricing procedures in Phase 3.
* **Impact:** no discounts, no freight, no header conditions, no scales, no condition supplements, no
  accruals, and no per-document-type procedure. An item whose customer has no record and no general record
  is refused, so the gap shows as a refusal rather than as a wrong price. Because the order stores the
  `condition_number` it read, a later billing document can re-read the same record and stay consistent.
* **Why deferred:** the masters a step vocabulary needs (procedure, step, access sequence, condition table)
  have no reader yet, and a table nothing reads is what this ledger exists to record. Their maintenance screen
  is a configuration screen of its own, not a form bolted onto order entry.
* **Acceptance criteria:** with the billing link, add `sales_pricing_procedure` and `sales_pricing_step`
  (condition type, step category, calculation level, required flag) plus the material sales view, resolve the
  customer's procedure instead of ignoring it, and give each a maintenance screen under the two `CFG.SALES.*`
  codes that are registered today. A procedure that names a step no record answers must refuse the document,
  as the price step does now, and one test must show an order and its invoice deriving the same figure.

## DI-019 — Credit exposure counts invoiced receivables only, so no sales document is in the basis before billing

* **Severity:** Medium. **Area:** `src/modules/finance/credit.ts`, SD credit control.
* **Evidence:** `exposureIn` (src/modules/finance/credit.ts:111) sums posted, uncleared
  `journal_entry_line` rows reached through the company codes assigned to the credit control area, in local
  currency. Nothing before billing creates a receivable, so an order, a delivery and a posted goods issue add
  nothing to the figure the ladder compares against the limit.
* **Impact:** a customer with a large book of open orders and no invoice is judged on what has been billed. The
  block that the order does raise is real — `checkSalesDocumentCredit` is called on create and on every change,
  and a determination in status BLOCKED is what the release screen claims — but "open order value" and
  "delivered not yet invoiced" are not components of exposure.
* **Why deferred:** widening the sum changes a live control that already has a screen, an audit trail and tests,
  and the documents that would be summed (delivery, goods issue, billing) do not exist yet (DI-020). Choosing a
  basis is a business decision, not a coding step, and this pass was not authorized to invent one.
* **Acceptance criteria:** when the chain exists, state the components in the engine (open order value,
  delivered-not-billed, open receivables, and the uncleared-item rule that already stands), show the split on
  /finance/credit-monitor, and prove with tests that an order which pushes exposure past the limit blocks the
  *next* document and that releasing it re-reads the same basis. `tests/credit-release.test.ts` and
  `tests/credit-monitor.test.ts` stay green unchanged.
* **Status (the pass that built DI-020).** Unchanged as a defect, narrowed in one respect: the basis is now
  `openSalesCommitments`, which adds the standing `credit_determination` value of sales documents that are not
  yet billed, so a delivery or a blocked order does move the ladder — and the exclusion of the document being
  judged (`excludeSalesDocument`) is passed at all three call sites, so a document never blocks itself. What is
  still true of DI-019 is the part it names: the exposure figure is `amount_local` of unclosed journal lines with
  no currency conversion, and open orders are counted only through their determinations rather than as receivable
  equivalents. Left open on purpose; nothing in the fulfillment work depended on closing it.

## DI-020 — The outbound delivery, goods issue and billing links of the sales chain (built; verified on the test box)

* **Severity:** High. **Area:** `src/modules/sales`, `src/modules/inventory`, SD order-to-invoice.
* **Evidence:** the database holds `sales_order`, `sales_order_line` and `sales_condition_record` and no
  `delivery`, `delivery_line`, `delivery_picking`, `billing_document` or `billing_document_line` (the authorized
  `drizzle/9190` was narrowed to the order link on purpose, so nothing ships with no writer). `src/modules/inventory/goods-issue.ts:80`
  offers movements 201, 551 and 261 — no 601 and no 602, so there is no goods-issue movement against a delivery.
  There is no `/sales/delivery` or `/sales/billing` route, and `grep -n "sales-order" scripts/browser-smoke/targets.ts`
  finds no target for the new screens either.
* **Impact:** acceptance items 2 to 6 and 9 of the order-to-invoice brief are unmet: an order cannot be fulfilled,
  nothing is billed, and the credit block therefore binds no follow-on document — the refusal site does not exist.
  The AR tail on the other side (customer invoice, incoming payment, clearing, ageing, dunning) is untouched and
  still works, so no half-built accounting path stands either.
* **Why deferred:** the delivery needs its own migration, picking rows, the 601/602 scenario and its journal,
  billing that creates the receivable through `postCustomerInvoice`, and screens for each. That is the next
  milestone of the chain, not a tail to this one, and adding tables or a scenario number without their postings
  would be the "registered code with no production caller" this brief rules out.
* **Acceptance criteria:** the seven-table migration (already authorized); a delivery built from the open quantity
  of one order, refusing over-delivery and a second delivery for the same quantity; pick confirmations that move
  no stock; one 601 goods issue per delivery posting stock and cost of goods sold in the same transaction as the
  delivery status, with 602 the only reversal and refused once reversed; a billing document from delivered
  quantities that posts through the existing customer-invoice service and refuses a second billing of the same
  quantity; the credit determination refusing a blocked document at delivery creation and at billing release; and
  one browser target covering create → deliver → pick → goods issue → bill → payment and clearing, with blocked
  credit, insufficient stock, partial fulfillment and a repeated submission as its failure paths. The enqueue
  guard's object classes gain `sales_order` and the new documents at the same time, so a change lock covers them.

* **Status (the pass that built it).** `drizzle/9191_sales_delivery_billing.sql` creates the five document tables
  (`delivery`, `delivery_line`, `delivery_picking`, `billing_document`, `billing_document_line`) with forced RLS,
  literal grants and the five `SALES.*` capability codes; movement 601 and its 602 reversal arrive as a
  `GOODS_ISSUE_SCENARIOS` entry in `src/modules/inventory/goods-issue.ts` (`screen: 'SALES'`,
  `expenseEvent: 'SALES_ISSUE'`), which `ensureMovements` seeds per tenant, so no movement master migration is
  needed. `src/modules/sales/delivery.ts` creates a delivery from the open quantity of one order, records picks,
  and posts the goods issue by calling `postGoodsIssue` **inside** the delivery transaction;
  `src/modules/sales/billing.ts` bills the goods-issued quantity through `postCustomerInvoice` and cancels
  through `cancelCustomerInvoice`. Credit is enforced at the three points CAIRN.md §14.8 names: delivery
  creation, picking and the goods issue refuse a standing block, and a block raises at the billing release,
  which holds the invoice instead of undoing the movement. `changeSalesOrder` refuses to drop, reject, or
  re-quantity a line a delivery has drawn on, and `cancelSalesOrder` refuses an order the chain has touched.
  Screens `/sales/delivery` and `/sales/billing` with their server actions, both `screen-catalog.ts` entries,
  `tests/sales-delivery.test.ts` and browser target `sales-order-to-invoice` (fixture key T871, the next free
  key after settlement's T870, because T982 is the runner's own cross-tenant probe, which
  `tests/storage-location-ui-contract.test.ts:83` refuses for any target) are written.
* **What the gates said (the workspace pass; read the box status at the end of this entry first).** The verification box stayed unreachable (`ssh -p 2222 cairn@107.173.201.115` times
  out while a raw connect to the port answers), so the gates were run here instead, on a PostgreSQL 17.11
  cluster the sandbox owns: `cairn_app` without `BYPASSRLS` as the runtime role and `cairn` as the migration
  role, the repository's own development defaults, 313 migrations applied including `+ 9191_sales_delivery_billing.sql`.
  `npm run db:verify` passes 13 of 13. `tests/sales-delivery.test.ts` passes 9 of 9 and `tests/sales-order.test.ts`
  17 of 17. The suites this change reaches are green: goods issue 14, MIGO component issue 10, MIGO matrix
  contract 12, customer invoice 3, credit 3, credit release 4, credit monitor 3, account determination 13,
  material document reversal 9, document reversal 4, atomic inventory posting 11, inventory block invariant 6,
  screen links 6, browser targets 208, constrained driving 2, storage location contract 5. The whole suite ran
  458 files and 3,178 tests with six failures in four files: two of them (`migration-grant-policy`,
  `default-privilege-audit`) read `DATABASE_URL` and `MIGRATION_DATABASE_URL` from the environment and pass 13 of
  13 under `npm run db:verify`, which is the way the repository runs them; the other two were contract tests
  pinning text this change legitimately altered, and both are green since. A `tsc --noEmit` narrowed to this
  change's files and everything they import reports 27 errors, and comparing against the same narrowed program
  in a worktree at `c10f707` shows not one of them arriving with this change (its own `billing.ts` and
  `sales-delivery.test.ts` errors, seven in all, were fixed: the built-row union became a discriminant, and the
  change calls gained the `rejectLines` the input type requires). The full `tsc --noEmit` cannot run in the
  sandbox: 2 GB of RAM, killed past about a gigabyte of heap, which is also why the numbers above come from a
  scoped program rather than the 152-error repository figure. `npm run lint:ip` names 141 trademark occurrences
  across the repository and none of them in a file of this change.
* **What running the code found.** Two faults a static read cannot see. `postBillingDocument`'s deliberate retry
  after a credit release re-entered `createBillingFromDelivery`, which refuses any delivery that already carries a
  billing row, so the retry could never post whatever it released: the retry now posts the standing document
  through `postStandingBilling`, and both paths share `linkPostedInvoice` so the invoice, its link and the status
  move as one act. And five refusal sentences interpolated the `char(6)` unit column, so they printed
  `UNT   ` to the user; the messages trim, `assertUnitScale` looks the unit up trimmed and names a unit that is
  missing. One fixture moved with the semantics rather than being worked around: the order-change test's customer
  now holds a 400.00 limit, because since DI-019 a standing sales commitment of the same customer is in the credit
  basis, and at 200.00 the order the test meant to pass was blocked by the previous test's order.
* **What was NOT yet true in the workspace pass (the box run below settles the build and the type check, and DI-021 carries the browser leg).** `npm run build` and the browser target were owed,
  and by owner instruction (2026-10-28) **every browser target is deferred until the test server is available**, so
  nothing in this workspace should attempt them before that. The build and the target were both tried anyway, and
  both are owed to this sandbox's memory rather than to the code. The build was attempted four times with heap
  caps from 900 MB to 1500 MB and the Next build worker was killed every time, once with 1,476 MB free and the
  database stopped; `next start` therefore has nothing to serve. The target was driven against a `next dev` server
  on the guarded `cairn_b210` database instead, and it reached: the identity guard passing ("Verified DI-020 sales
  order to invoice local loopback database: cairn_b210 on 127.0.0.1:5432; runtime role restricted, migration role
  elevated"), Chromium launching, and the onboarding form creating a tenant (`POST /clients/new` answering 303,
  the sign-in redirect carrying `client=T871&created=1`). Next's own dev rule then ended it: `server/lib/start-server.js`
  restarts the server after a request in which the heap has passed 80 per cent of its limit, and the restart drops
  the navigation in flight. What that run did prove is worth recording: every route the target reads compiled, in
  0.7 to 6.3 seconds each, and served 200 or the 307 to the sign-in page an unauthenticated session must see —
  `/signin`, `/clients/new`, `/config`, `/sales/orders`, `/sales/delivery`, `/sales/billing`. So the screens build
  and answer; the eight browser proofs on persisted rows are the piece that needs a host able to hold a production
  build. Two design points are also documented rather than claimed as met: the brief's journey ends at
  *payment and clearing*, which this pass does not build (the AR tail after the invoice is unchanged and already
  works, and the browser target stops at the posted receivable); and re-billing a delivery whose billing document
  was cancelled is refused by `billing_document_delivery_uq`, because a delivery earns one billing row ever — the
  credit-memo path that would allow a re-bill does not exist (DI-018's sibling gap, recorded here).
* **On the criterion about the enqueue guard's object classes.** `src/platform/lock/enqueue.ts` holds no
  object-class allowlist — `openChangeForSession` and `openForChange` take any class, and the enqueue rows are
  audited under the single `'enqueue_entry'` class. The documents therefore enter that vocabulary through their
  change records and their own concurrency guards: `recordChange` is called with `objectClass` `sales_order`
  (`src/modules/sales/sales-order.ts:45`), `delivery` (`delivery.ts:43`) and `billing_document`
  (`billing.ts:43`), and every act re-reads `version` inside the transaction and re-checks it on the final update,
  which is the same shape the production and inventory document services use rather than the maintenance
  screens' claim-a-lock shape. Nothing here is registered as a lock class because the mechanism has no class
  registry to register in.
* **Status (the pass that ran the gates on the test box).** The box came back and the whole battery was run there,
  on the repository's own `.env.local` database `cairn_b210` at `127.0.0.1:5432`, after syncing the 27 files of
  `c74c535`/`9896197` into the box tree (verified byte-for-byte by `sha256sum` against the commit, and the box
  tree was confirmed to equal `c10f707` apart from the owner's own untracked test and the two docs). The box holds
  **no** owner-owned modified file, so this is the committed state and nothing else, which is what makes the
  numbers below attributable.
  * **Implemented and verified.** `npm run db:migrate`: `Applied 1 migration(s): + 9191_sales_delivery_billing.sql`
    over 313. `npm run db:verify`: 13 of 13. Focused suites: `sales-delivery` 9, `sales-order` 17, `goods-issue` 14,
    `migo-component-issue` 10, `migo-matrix-ui-contract` 12, `customer-invoice` 3, `credit` 3, `credit-release` 4,
    `credit-monitor` 3, `account-determination` 13, `material-document-reversal` 9 and its accounting twin 5,
    `document-reversal` 4, `reversal-batch` 2, `atomic-inventory-posting` 11, `inventory-block-invariant` 6 —
    **16 files, 125 tests, no failures**. Whole suite: **455 of 458 files, 3,145 of 3,152 tests**. `npx tsc --noEmit`:
    **152 errors, the repository's own figure to the unit, and not one of them in a file of this change** (the
    seven it reports in `goods-issue.ts` are the pre-existing ones, present at `c10f707` with the same messages at
    shifted lines). `npm run lint:ip`: **141 occurrences, the baseline count, with the same text multiset as
    `c10f707`** — the one hit naming a file of this change, `goods-issue.ts:103 [SAP]`, is the pre-existing
    sentence at `:93` moved down by an insertion. `npm run build`: **exit 0**, "Compiled successfully in 59s", the
    route manifest carrying `ƒ /sales/orders`, `ƒ /sales/delivery` and `ƒ /sales/billing`.
  * **The six full-suite failures are not this change, and the proof is a worktree.** At `c10f707` alone — no
    delivery or billing file, no 9191, owner's uncommitted work absent, same database — `tests/action-security.test.ts`
    fails the same **4** tests with the same reasons (`expected { ok: false, …(4) } to match { ok: true, changed:
    true, version: 2 }` at `:234`, two `expected false to be true`, `expected 12 to be 11` at `:269`) and
    `tests/grir-clearing.test.ts` the same **2** (`{ base: 7, entered: 7 }` against `{ base: 84, entered: 7 }` at
    `:338`). Both belong to the change-lock and alternative-unit work the owner is carrying uncommitted in this
    workspace, where those two files pass. The seventh box failure, `tests/production-order-writer-guard.test.ts`,
    is the owner's own untracked test, present on the box and failing for the same reason (CO09 availability
    status `UNSUPPORTED` where their in-flight work would answer `AVAILABLE`).
  * **No longer blocked by the environment.** The previous bullets in this entry describe the 2 GB workspace
    sandbox, where `next build` and the full `tsc` could not be run at all (the build worker SIGKILL'd four times,
    `tsc --noEmit` exit 137 at 18 minutes, and the two database files `migration-grant-policy` and
    `default-privilege-audit` failing a bare `npx vitest run` for want of the exported URLs while passing 13/13
    under `npm run db:verify`). The scoped-typecheck substitute recorded there was a subset program and is not
    being offered as equivalent to the full check: the full check has now run on the box, and 152 is its answer.
  * **Deferred, not outstanding.** Browser acceptance has its own entry, **DI-021**, so that this one can be read
    as what the code does rather than as what the harness has not yet run. Running no browser target here is the
    owner's instruction of 2026-10-28, not a finding: nothing in this pass launched Chromium against the
    development server, and no browser evidence is claimed.
  * **Still open substantively, and unchanged in kind.** Two things the acceptance list asked for are not built:
    the journey stops at the **posted receivable** — payment and clearing of a sales invoice are the AR services
    that already exist for FB70 (`tests/incoming-payment`, `tests/customer-clearing`, `tests/dunning`, all green
    here), and nothing drives them from the sales chain; and re-billing a delivery whose billing document was
    cancelled is refused by `billing_document_delivery_uq`, because a delivery earns one billing row ever, with no
    credit-memo path to authorize a second (weakening that unique index is not this pass's call). Both need an
    owner decision, not a coding decision.
  * **Guarantees as coded, read off the code rather than asserted.** Concurrency: every act takes
    `pg_advisory_xact_lock(hashtextextended('<client>/sales-order/<n>' or '<client>/delivery/<n>', 0))`
    (`delivery.ts:158`, `:162`; the billing path takes the delivery's key) and re-checks `version` inside the same
    transaction before its final update (`delivery.ts:844` for the goods issue, `:630` for a pick), so two
    submissions on one delivery serialize and a stale read is refused by name — and that is all they do: there is
    no claim, no lock row and no object-class registry, exactly as the bullet above this one records, and
    `recordChange` is the audit trail (`sales_order`, `delivery`, `billing_document`), not a mutex. Quantity
    integrity is enforced below the service, so no caller can talk its way past it: `delivery_line_remaining_quantity_ck`
    keeps `remaining = ordered − delivered_before − delivery` and `>= 0` (over-delivery is refused by the
    database), `delivery_line_picked_ck` keeps `picked <= delivery`, `delivery_line_issued_ck` keeps
    `issued <= picked`, `delivery_goods_issued_ck` forbids `GOODS_ISSUED` without a material document and its
    year, and `billing_document_posted_ck` forbids `POSTED` without both the customer invoice number and the
    journal document number. Idempotency and duplicate protection: `delivery_request_key_uq`,
    `delivery_picking_request_key_uq`, `billing_document_delivery_uq` and
    `billing_document_line_delivery_line_uq`, plus the derived keys handed to the services that own those ledgers
    (`sd-gi-<client>-<delivery>` into `postGoodsIssue`, `sd-bl-<client>-<billing>` into `postCustomerInvoice`), so
    a replay returns the standing document instead of writing a second one, and `delivery_picking_delta_ck`
    refuses a zero delta so no "correction" can pass as a silent no-op. Reversal runs only through 602 or MBST,
    against the tested `reversal_movement_type` link. Tenancy: `enable` plus `force row level security` on all five
    tables with a `tenant_isolation` policy on `cairn.client` for both `using` and `with check`, `revoke all ...
    from public`, DML granted per table to `cairn_app`, and `revoke update, delete, truncate` on `delivery_picking`
    and `billing_document_line` — append-only by rights, which is what the two database files in `db:verify`
    audit. Credit is enforced at three points (creation, pick, goods issue, each naming the document and refusing
    before any stock or journal write) and a breach caused by the movement holds the receivable rather than undoing
    the movement; the release path posts the standing billing under its existing number through
    `postStandingBilling`, which is the fix that retry needed.
* **To close it:** the two substantive items above — an authorized AR tail driven from the sales chain, and a
  decision on re-billing after cancellation. The browser leg has moved to DI-021, where its target, preconditions
  and eight proofs are recorded for the run the test server will allow. The environment the rest was run in, and how to raise it again: a PostgreSQL 17 cluster on
  loopback, a `cairn` superuser owning `cairn_dev`/`cairn_b210` and a `cairn_app` role that is neither superuser
  nor `BYPASSRLS` (which is what `assertApplicationRole` demands), those two URLs in `.env.local`, then `npm run
  db:migrate`, `npm run db:verify`, `npm run seed` and `npm run seed:reference`, then the suites named above.
  Nothing the service
  gates would report is still owed: they were run, and what they reported was fixed.

---

## DI-021 — The sales order-to-invoice journey has no browser acceptance run

* **Severity:** Medium. **Area:** `scripts/browser-smoke/`, SD order-to-invoice. Split out of DI-020 by owner
  instruction (2026-10-28) so that implementation completion and browser acceptance are tracked apart; DI-020
  keeps the substantive gaps.
* **Status:** **deferred by decision, not by inability.** The target is written and registered; the box can build
  and serve it (`npm run build` exits 0 there and the manifest lists `/sales/orders`, `/sales/delivery` and
  `/sales/billing`); and no browser target is to be run until the test server is in use for it. Absence of browser
  evidence is not a functional defect and no browser acceptance is claimed.
* **What already exists, so this can be finished in one pass.** `scripts/browser-smoke/sales-order-to-invoice.ts`
  (the journey in the order a user does it), registered in four places: `targets.ts:173` (id
  `sales-order-to-invoice`, fixture key **T871** — deliberately not T982, which is the runner's own cross-tenant
  probe and which `tests/storage-location-ui-contract.test.ts:83` refuses for any target),
  `database-guards.ts:202` (bound to `cairn_b210` on `127.0.0.1:5432`, batch "DI-020 sales order to invoice local
  loopback"), `checks.ts` (`CHECKS['sales-order-to-invoice']`), and `scripts/browser-smoke.ts:183` (protected
  route `/sales/orders` for the sign-out redirect assertion). The static half of its contract is already green on
  the box: `tests/browser-targets.test.ts` 208 tests and `tests/browser-target-constrained-driving.test.ts` 2.
* **How to run it.** On the test server, from the repository root: `npm run build`, serve it
  (`SMOKE_BASE_URL` defaults to `http://127.0.0.1:3000`, so `npx next start -p 3000` is enough), with the
  guarded `cairn_b210` provisioned (`npm run db:migrate`, `npm run seed`, `npm run seed:reference`) and
  `CAIRN_ENV=development`; then `npm run smoke:browser -- --target sales-order-to-invoice`. Cold-server runs want
  the deadline raised, never lowered: `CAIRN_BROWSER_RUN_TIMEOUT_MS`, `CAIRN_BROWSER_PAGE_TIMEOUT_MS`,
  `CAIRN_BROWSER_NAV_TIMEOUT_MS`. Chromium is in the box image at `/ms-playwright`; the runner enforces the loopback
  and role guards, creates the fixture tenant through `/clients/new`, and refuses the run if T871 belongs to any
  other tenant.
* **Acceptance criteria — the eight proofs, on persisted rows, with no page errors.** (1) an order priced from
  standing condition records; (2) a delivery drawn from the quantity the order still has open, with
  `deliveredQuantity`/`remainingQuantity` reading back; (3) over-delivery refused by name, quoting the unit;
  (4) a pick recorded against the delivery item, with a correction as a signed delta and an under-zero pick
  refused; (5) one 601 goods issue posting stock, valuation and the journal in the delivery's own act, and a
  602/MBST reversal as the only way back; (6) one billing document for the delivered quantity, and no second one
  for the same delivery; (7) the credit determination refusing a delivery on a blocked order, and holding the
  invoice raised by a movement that breached the limit, then posting the same billing number once released;
  (8) the links readable back from the tables the services wrote — order, delivery, material document, billing
  document, customer invoice, accounting document. Its failure paths are blocked credit, insufficient stock,
  partial fulfillment and a repeated submission, and the sign-out at the end must land on `/signin?`.

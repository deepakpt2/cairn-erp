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

# People

**Purpose:** HR master data, multi-tenant SAP-style ERP: employee+dated records, org structure (units/jobs/positions/reporting line), position→cost-centre assignment, pay structure (components+GL/cost mapping), time/leave; plus the people side of the authority model — chain of command, authority chart, delegation (CAIRN §16.6/§23). Master-data/definition only — no pay calc/posting; payroll execution awaits owner decision (DV-001, R-11, D-013).

## Files
### Schema
- `src/modules/people/schema.ts` — 19 Drizzle tables (record types/employee, org structure, pay structure, time/leave, delegation) + route/capability/object-class constants; `position_assignment` gained 8 nullable org-level scope columns (`plant`, `companyCode`, `purchasingOrg`, `purchasingGroup`, `salesOrg`, `distributionChannel`, `division`, `creditControlArea`). Exports: `recordType`, `recordField`, `employee`, `employeeRecord`, `recordFieldValue`, `orgUnit`, `job`, `position`, `orgHierarchy`, `positionAssignment`, `payComponent`, `payComponentConfig`, `timeType`, `absence`, `leaveQuota`, `timeRecording`, `delegation`, `delegationScope`, `delegationApproval`, `AUTHORITY_ROUTE`, `AUTHORITY_VIEW_CAPABILITY`, `MAX_ORG_DEPTH`, `RECORD_VALUE_KINDS`, `PAY_COMPONENT_KINDS`, `COST_RECEIVER_CATEGORIES`, `TIME_TYPE_KINDS`, `ABSENCE_STATUSES`.

### Employee master & record types
- `src/modules/people/employee-master.ts` — employee (personnel #+name) + dated `employee_record`/`record_field_value`. Exports: `createEmployee`, `changeEmployee`, `getEmployee`, `listEmployees`, `createRecord`, `delimitRecord`, `changeRecordValues`, `EmployeeMasterError`.
- `src/modules/people/record-types.ts` — config layer (DV-012): fields a record type asks for + kind. Exports: `defineRecordType`, `changeRecordType`, `addRecordField`, `changeRecordField`, `getRecordType`, `listRecordTypes`, `RecordTypeConfigError`.
- `src/app/people/employees/actions.ts` — wraps employee-master writes: `createEmployeeAction`, `changeEmployeeAction`, `createRecordAction`, `delimitRecordAction`, `changeRecordValuesAction`; logs `CAPABILITY_DENIED` on refusal.
- `src/app/people/employees/Employees.tsx` — client: create/change master, write/correct/delimit record, grouped by type.
- `src/app/people/employees/page.tsx` — `/people/employees` page; loads employees, record types, selection.
- `src/app/config/people-record-types/actions.ts` — `defineRecordTypeAction`, `changeRecordTypeAction`, `addRecordFieldAction`, `changeRecordFieldAction`.
- `src/app/config/people-record-types/RecordTypes.tsx` — client: define type+first field, list, add/correct fields, retire/restore.
- `src/app/config/people-record-types/page.tsx` — `/config/people-record-types` page.

### Org structure & assignment
- `src/modules/people/org-structure.ts` — units/jobs/positions + `org_hierarchy` relations `STRUCTURE`/`REPORTS_TO`; in-transaction tree walk for cycle/depth checks. Exports: `defineOrgUnit`, `changeOrgUnit`, `getOrgUnit`, `listOrgUnits`, `defineJob`, `changeJob`, `getJob`, `listJobs`, `definePosition`, `changePosition`, `getPosition`, `listPositions`, `measureChain`, `OrgStructureError`.
- `src/modules/people/assignment.ts` — `position_assignment`: employee→position→cost centre, dated. Exports: `assignPosition`, `changeAssignment`, `delimitAssignment`, `getAssignment`, `assignmentsOf`, `listAssignments`, `incumbentsOf`, `openAssignmentOf`, `AssignmentError`.
- `src/app/people/organization/actions.ts` — `defineOrgUnitAction`, `changeOrgUnitAction`, `defineJobAction`, `changeJobAction`, `definePositionAction`, `changePositionAction`.
- `src/app/people/organization/Organization.tsx` — client: tabbed units/positions/jobs tree, define/change forms.
- `src/app/people/organization/page.tsx` — `/people/organization` page.
- `src/app/people/assignments/actions.ts` — `assignAction`, `delimitAction`, `changeAssignmentAction`; `delimitAction` redirects via query params (ending open span removes the panel that would show a notice).
- `src/app/people/assignments/Assignments.tsx` — client: search, standing-assignment panel (end/correct-in-place), history table, start form.
- `src/app/people/assignments/copy.ts` — `endedAssignmentMessage`, `dateParam`; shared by redirect+page so confirmation text can't drift.
- `src/app/people/assignments/page.tsx` — `/people/assignments` page; reads `ended`/`to` redirect params into confirmation.

### Pay components & record types (pay structure)
- `src/modules/people/pay-components.ts` — `pay_component` defs + per-chart GL/cost mapping; validates against `gl_account`, `chart_of_accounts`, `cost_center` (other modules' tables). Exports: `definePayComponent`, `changePayComponent`, `savePayComponentMapping`, `getPayComponent`, `listPayComponents`, `listChartsForMapping`, `listAccountsForSide`, `listCostCentresForMapping`, `isPayComponentError`, `listOpenPayComponents`, `PayComponentError`.
- `src/app/config/pay-components/actions.ts` — `defineComponentAction`, `changeComponentAction`, `defineMappingAction`, `changeMappingAction`; `CLEAR`/`NONE` sentinel: "field not sent" vs "clear field."
- `src/app/config/pay-components/PayComponents.tsx` — client: define component, list, select chart, define/correct mapping (debit/credit selects, cost-receiver choice).
- `src/app/config/pay-components/page.tsx` — `/config/pay-components` page.

### Time & leave
- `src/modules/people/time-leave.ts` — `time_type`, `absence` (dated request, status lifecycle), `leave_quota` (entitlement/taken/remaining per employee/type/year), `time_recording` (hours/day, overwritten not dated). Exports: `defineTimeType`, `changeTimeType`, `requestAbsence`, `decideAbsence`, `cancelAbsence`, `recordTime`, `setLeaveQuota`, `getTimeTypeView`, `getAbsence`, `absencesOf`, `listAbsences`, `getLeaveQuota`, `listTimeTypes`, `getTimeRecording`, `openAbsenceOn`, `isTimeLeaveError`, `TimeLeaveError`.
- `src/app/people/time-leave/actions.ts` — `defineTimeTypeAction`, `changeTimeTypeAction`, `requestAbsenceAction`, `decideAbsenceAction`, `recordTimeAction`, `setLeaveQuotaAction`.
- `src/app/people/time-leave/TimeLeave.tsx` — client: define/change time type, request/decide absence, record time, set quota, list types/absences.
- `src/app/people/time-leave/page.tsx` — `/people/time-leave` page.

### Authority, chain of command & delegation
- `src/modules/people/chain-of-command.ts` — joins `app_user`→`employee.app_user_id`→`position_assignment`→`org_hierarchy REPORTS_TO` into person-level answers (who a user answers to, who stands below). Exports: `positionsOfUser`, `holdersOfPosition`, `superiorPositionOf`, `orgUnitOfPosition`, `chainAbove`, `superiorOfUser`, `positionsBelow`, `ChainOfCommandError`, `PositionHolder`, `PositionRef`, `Superior`.
- `src/modules/people/authority-chart.ts` — read model for `/people/authority`: viewer's own reporting line (held positions + everything below), per-person grants (via `effectiveGrants`) and delegations given/received. Exports: `authorityChart`, `authorityChartFor`, `grantLines`, `levelLabel`, `AUTHORITY_CHART_ROUTE`, `AUTHORITY_CHART_CAPABILITY`, `GrantLevel`, `GrantLine`, `PositionLine`, `SubjectSummary`, `SubjectCard`, `DelegationLine`, `AuthorityChart`.
- `src/modules/people/delegation-status.ts` — pure, DB-free leaf: status/liveness/approval predicates shared by delegation service + `platform/auth/authority` (avoids import cycle). Exports: `isTerminal`, `effectiveStatus`, `approvalsSatisfied`, `isLive`, `DelegationStatus`, `ApprovalSide`, `ApprovalStatus`.
- `src/modules/people/delegation.ts` — delegation state machine (DRAFT→PENDING_ACCEPTANCE→ACTIVE→EXPIRED/CLOSED/REVOKED/REFUSED), SUPERIOR/SELF creation flows, two-sided chain-of-command approvals, scope narrowing. Exports: `approversFor`, `createDelegation`, `respondToDelegation`, `decideApproval`, `revokeDelegation`, `closeDelegation`, `assertMayControlDelegation`, `scopeCovers`, `refreshStatus`, `loadDelegation`, `delegationsForUser`, `DelegationError`, `InitiatorKind`, `ApprovalView`, `DelegationView`, `CreateDelegationInput` (+ re-exports of `delegation-status`).
- `src/modules/people/jobs/grant-expiring.ts` — background job `AUTH.GRANT.EXPIRING`: chunked sweep of `user_capability` ending within horizon, one notification per grant (dedup on unseen rows); registered via side-effect import in `src/worker/jobs.ts`. Exports: `GRANT_EXPIRING_JOB`, `grantExpiringJob`.
- `src/app/people/authority/Authority.tsx` — client: two-column chart (people in line | selected person's positions, grants, delegation panels w/ empty states). Exports: `Authority` (default).
- `src/app/people/authority/page.tsx` — `/people/authority` page; `?user=` selects within viewer's line only. Exports: `PeopleAuthorityPage` (default).

## Pages & API routes
- `/people/employees` — master+dated records (create, write/correct/delimit).
- `/people/organization` — units/positions/jobs, `STRUCTURE`/`REPORTS_TO` (tabbed).
- `/people/assignments` — position→cost centre→employee, history, open span.
- `/people/time-leave` — time types, absence req/decision, leave quota, recordings.
- `/people/authority` — read-only authority chart of viewer's reporting line: positions, grants by org level, delegations (`PEOPLE.AUTHORITY.VIEW`). No delegation-maintenance screen yet (service + tests only).
- `/config/people-record-types` — define/retire record types+fields (DV-012).
- `/config/pay-components` — define/retire pay components+GL/cost mapping.

## Database
**Owns:** `record_type`, `record_field`, `employee`, `employee_record`, `record_field_value`, `org_unit`, `job`, `position`, `org_hierarchy`, `position_assignment`, `pay_component`, `pay_component_config`, `time_type`, `absence`, `leave_quota`, `time_recording`, `delegation`, `delegation_scope`, `delegation_approval` (migration `drizzle/9269_delegation.sql`, RLS forced; also adds `audit_access_log.delegation_id`).

**Related, not owned:** `position_capability`, `user_capability`, `user_capability_scope` (authority model, `drizzle/9267_authority_model.sql`) are Drizzle-defined in `src/platform/tables/security.ts` (platform); 9267 also adds the org-level scope columns to `position_assignment`. Read by `authority-chart.ts`/`jobs/grant-expiring.ts`.

**Reads/writes other modules':**
- `gl_account`, `chart_of_accounts` (finance) — `pay-components.ts` validates: chart membership, posting-blocked flag, `account_type` EXPENSE/LIABILITY, `requires_cost_object`.
- `cost_center` (foundation/finance controlling) — `assignment.ts`/`pay-components.ts` check it stands (dated, as-of a day) before naming on assignment/FIXED mapping; not a Drizzle FK (PK carries from-date).
- `app_user`, `user_capability` (platform security) — `chain-of-command.ts`/`authority-chart.ts` read users; `grant-expiring.ts` sweeps `user_capability`.
- `audit_access_log` (platform security) — every action writes `CAPABILITY_DENIED` via raw SQL (`auditAccessLog` typing-only import) on capability failure.

## Depends on
- **Finance** (`gl_account`, `chart_of_accounts`) — pay mapping checked against tenant's chart of accounts.
- **Foundation/controlling** (`cost_center`) — assignments/FIXED mappings charge real dated cost centre; `position_assignment.controlling_area` real FK, `cost_center` via raw SQL (dated).
- **Platform auth** (`platform/auth/current`, `platform/auth/session`) — `requireSession`, `can`, `hasCapability`, `AuthzError`; writes gated (`PEOPLE.*`, `CFG.PEOPLE.*`).
- **Platform db** (`platform/db/client`: `withTenant`, `Tx`) — tenant-scoped tx; advisory locks (`pg_advisory_xact_lock`) serialize overlap checks (records/assignments/absences).
- **Platform change** (`recordChange`) — every create/change writes change-history doc (class, before/after, actor).
- **Platform posting/decimal** (`toScaled`/`fromScaled`) — fixed-point arithmetic for leave-quota/time-recording decimals.
- **Platform tenancy tables** (`client`, `auditColumns`) — tenant FK + audit columns on every table.
- **Platform auth authority** (`platform/auth/authority`: `effectiveGrants`, `AuthorityGrant`, `ScopeKey`) — authority chart/delegation read derived grants; two-way coupling (authority imports `people/schema` + `delegation-status`).
- **Platform job/notification** (`platform/job/registry`, `platform/job/types`, `platform/notification/notify`) — grant-expiry job.

## Used by
`grep -rln "@/modules/people\|src/modules/people" --include="*.ts" --include="*.tsx" /home/coder/project/src /home/coder/project/tests /home/coder/project/scripts | grep -v "src/modules/people\|src/app/people"`

- `src/dev/walkthrough-volume.ts` — seed script exercises People end-to-end (master, record types, org, assignment, time-leave, pay components) for demo tenant; payroll results not fabricated.
- `tests/organisation-scope-admin.test.ts` — imports `employee` table to test org-scope authorization, not People logic.
- `src/platform/auth/authority.ts` — imports `employee`, `positionAssignment`, delegation tables from `schema.ts` + `isLive` from `delegation-status.ts` to derive position/delegated grants.
- `src/platform/notification/recipients.ts` — `delegation`, `employee`, `positionAssignment` for recipient resolution.
- `src/platform/tenancy/demo-people.ts` — demo tenant seeding via `defineOrgUnit`/`defineJob`/`definePosition`, `createEmployee`, `assignPosition`.
- `src/worker/jobs.ts` — side-effect import registers `jobs/grant-expiring`.
- `src/modules/purchasing/requisitions.ts` — `employee` table (requester link).
- `src/modules/platform/user-admin.ts` — `employee` read-only (linked-record flag).
- `src/platform/schema.ts` — re-exports `people/schema` (Drizzle barrel).
- `tests/attention.test.ts` — imports `delegation.ts` services.
- Six `tests/people-*.test.ts`, four authority/delegation tests + four `scripts/browser-smoke/people-*.ts` (below) import services directly; `src/app/config/*`/`src/app/people/*` are the module's own app layer (grep-excluded).

## Tests
- `tests/people-authorization.test.ts` — employee/app-user linking (no implicit login/roles), capability grants via roles, denial paths, cross-tenant isolation.
- `tests/people-employee-master.test.ts` — record-type/field-kind validation, dated-record overlap/append-only, in-place correction of only newest-open record, `requestKey` replay, change-history, cross-tenant isolation, DB delete/overwrite refusal.
- `tests/people-org-assignment.test.ts` — `measureChain` unit test, one-parent/move semantics, cycle/depth-cap refusal, retirement vs deletion, job/position/assignment wiring, overlap and delimit/correct-in-place rules, cost-centre-as-of-start-date checks, request-key replay, tenant isolation, DB privilege checks.
- `tests/people-pay-components.test.ts` — kind pinning `affectsNetPay`, duplicate/kind-vocabulary refusal, rename/retire without touching mappings, side-allowed-by-kind, account chart/type/blocked checks, cost-object requirement, mapping listing, change-history, DB grants (no DELETE), capability wiring.
- `tests/people-service-authorization.test.ts` — service-layer capability enforcement (create/change employee), org-restriction loading (`loadOrgRestrictions`, `hasOrgAccess`), sign-in capability resolution.
- `tests/authority-chart.test.ts` — viewer boundary: own reporting line only, crafted user id can't widen it, grant levels, delegation panels.
- `tests/authority-model.test.ts` — authority resolver (`platform/auth/authority`) over people structure: role grants unchanged, plant-scoped/position grants, expired/future grants stop matching (no sweep), delegation provenance, pattern/exact-grant matching, tenant isolation.
- `tests/chain-of-command.test.ts` — user→employee→position→REPORTS_TO resolution, skips vacant positions, line ends in org unit, no-position answer, ring refusal, dated spans.
- `tests/delegation.test.ts` — state machine, three creation flows, one- vs two-sided approval, acceptance, revoke/close, derived (not copied) delegate authority.
- `tests/people-time-leave.test.ts` — time-type define/change/retire, absence request/overlap/approve/reject/cancel, search by status/type, leave-quota entitlement/taken/remaining on approval, recording create/overwrite, tenant isolation, open-absence-on-a-day lookup.

## Scripts
`scripts/browser-smoke/people-assignments.ts`, `scripts/browser-smoke/people-employee-records.ts`, `scripts/browser-smoke/people-organization.ts`, `scripts/browser-smoke/people-pay-components.ts`
- assignments (PA30): build org, assign, overlap refusal, delimit+next-day start, correct-in-place (values only), cost-centre-as-of checks (future centre ok only for future start).
- employee-records (PA30/PA40/PT60): define/extend record type, create employee, write/overlap-refuse/delimit/correct through screens, change-history readback.
- organization (PPOCE/PPOME/PO10): units/jobs/positions, cycle refusal, move semantics, retirement visibility, ref-transaction-code lookup.
- pay-components (CFG.PEOPLE.PAYCOMPONENT.DEFINE): component+mapping definition, kind-side refusals, cost-object requirement, workbench route-link regression (activity had no route before `9195`).

## Non-obvious behavior / gotchas
- No deletes: every table append-only/retire-only at DB privilege level (migrations `9193`-`9197` revoke DELETE); exception `org_hierarchy` (app can delete — move = delete+reinsert single edge, not history).
- Overlap checks use advisory lock (`pg_advisory_xact_lock(hashtextextended(...))`) before checking, in `employee-master.ts`/`assignment.ts`/`time-leave.ts` — PK is backstop only; concurrent writers could both see a day as free.
- Only newest *open* record/assignment/mapping-row correctable in place; else new dated row required. `changeRecordValues`/`changeAssignment` enforce "no newer row AND still open."
- Field answer lives in one of 3 columns by kind; `record_field_value` CHECK requires exactly one of `text_value`/`number_value`/`date_value` non-null. Changing `valueKind` while rows answer it refused (`KIND_IN_USE`).
- Cost centre checked via raw SQL, never Drizzle FK (PK carries from-date, can't be a single-interval FK target): `assignment.ts` (`costCenterAsOf`, as of assignment start), `pay-components.ts` (`centreStandingToday`, as of today).
- `pay_component_config` check-constraint bug: `pay_component_config_assignment_needs_nothing_ck` in `schema.ts` has stray `}` in SQL template (`... is null})`) — flag if touching this constraint in migration.
- Org structure NOT dated (unlike rest of module): tree placement is "as of today" only by design (§15.1 puts validity dates on Assignment alone) — can't answer "what did org chart look like last quarter."
- Position never stores holder/vacancy; `incumbents`/`positionsFilled` always computed from `position_assignment` as of today — avoids a second driftable answer.
- `TimeLeave.tsx` time-type `<select>`s never populated: `AbsenceRequestForm`/`TimeRecordingForm`/`LeaveQuotaForm` render `<select name="timeTypeCode">` with blank `—` only, no `.map()` over `timeTypes` — prop reaches parent, not threaded in; UI as-is can't select a real time type (apparent bug vs. polished employee/assignment/org screens).
- One employee holds only one assignment at a time — overlap test in `assignment.ts` scoped to employee, not `(employee, position)`; split/% assignments unsupported; two roles = two sequential non-overlapping spans.
- Delegation stores no capabilities: delegate's authority re-derived from delegator on every check (`effectiveGrants` + `isLive`), so revoking/losing the delegator's grant ends it with no sweep; no `delegation_scope` rows = delegator's own scope inherited.
- Delegation approval side satisfied by *any* approver row on that side (multi-position superiors); a side with no rows (line ends in org unit/apex) is self-approving. `superiorOf(delegator)===superiorOf(delegatee)` → one side only.
- `authority-chart.ts` header comment still says delegation panels are empty "until Phase 5" — stale; it now loads real rows via `delegationsForUser`. Page gates only via `requireSession(AUTHORITY_ROUTE)`; visible set is computed from viewer's positions, never from `?user=`.
- Pay components compute/post nothing: `definePayComponent`/`savePayComponentMapping` only define where an amount *would* go — no run/result/payslip/GL posting anywhere (R-11, DV-001); same for time-leave (`recordTime`/`requestAbsence` never touch payroll).

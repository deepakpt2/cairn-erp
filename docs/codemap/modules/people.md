# People
HR: employees, org assignments, time/leave, pay components, salary structures & readiness (payroll phase 1), payroll runs & results (phase 2), payroll posting to G/L (phase 3), salary payment (phase 4), off-cycle runs and service-side scope (phase 5), authority chart & delegation. Routes: `/people/*` (incl. `authority`, `salary-structures`, `payroll-runs`, `payroll-results`; launchpad area `people`), `/config/{pay-components,people-record-types}`. Paths relative to `src/`; tables are SQL names.

## Gotchas

- Background payroll (`payroll-background.ts`, jobs `PAYROLL.RUN.CALC`/`PAYROLL.RUN.POST`, queue INTENSIVE): one active `payroll_run_operation` per run (partial unique index); every other payroll action calls `assertNoActiveOperation`. Calculation stages into `payroll_calc_stage` and publishes in one tx. The job acts as `job_run.triggered_by` via `ServiceAuthorityContext.jobLease` (lease verified + current grants), never a session or the capability-array shortcut. The job runner only ever sees a fixed generic error; the real reason is on the operation.
- Append-only at grant level (DELETE revoked, 9193–9197); exceptions: `org_hierarchy`, and results/exceptions of a PROPOSED payroll run.
- Overlap checks take `pg_advisory_xact_lock(hashtextextended(…))` first; PK is backstop. One assignment per employee at a time.
- Cost centre validity is checked by raw SQL (dated PK can't be an FK target).
- No role holds payroll capabilities (`PEOPLE.PAYROLL*`); demo reaches them via `demo.admin` `*`.
- Payroll: released run frozen (`RUN_FROZEN`); POSTED ⇔ document number (CHECK). 9281 `SECURITY DEFINER` triggers owned by the migrator: `payroll_result_coverage_trg` (23505) and `payroll_result_immutable_trg` (23514). Migrate as `cairn_integration_migrator` or they fail with permission denied.
- `salary_payment` has no status: the row exists exactly when PY posted.
- Scope fails closed for session callers (`assertEmployeeScope` → `NO_COMPANY`); capability-list callers are unchecked.
- Delegation stores no capabilities; re-derived per check. Org structure is undated.
- Demo phases `D7_PAYROLL`…`D11_PAYROLL_OFFCYCLE`; `D9_PAYROLL_POST` granted `demo.admin` company 1000 / plants 1000, 2000.
- Employee reach (`employee-reach.ts`) is the one scope rule for leave, employee master, assignments and per-employee payroll: assignment company must be in the caller's COMPANY_CODE scope; a caller whose PLANT scope leaves a plant of that company uncovered is plant-level and reaches only assignments naming their plants (null plant = not reachable). No PLANT scope, or all plants of the company, = company level. Unresolvable company/plant fails closed. Scope rows are per user (`auth_org_restriction`), not per capability.
- `position_assignment.plant` is written only by `assignPosition`/`changeAssignment` (checked against the plant master and the cost centre's company). Out-of-reach employees answer like unknown ones (`EMPLOYEE_UNKNOWN`/`ASSIGNMENT_UNKNOWN`).
- Employee master: `viewEmployee`/`searchEmployees` are scoped; `getEmployee`/`listEmployees` are unscoped (trusted in-process only; screens must not use them, see `people-scope-contract`). A pending hire (no assignment yet) is reached through its proposed plant (`scopesFor`); an unassigned employee only by company-level callers. `incumbentsOf`/`openAssignmentOf` (no access arg) stay unscoped.
- Services take `LeaveAccess`/`EmployeeAccess`/`AssignmentAccess` = capability list (in-process, no scope) or `{authorization}` (live session; re-judged in the service tx). Screen actions build only `{authorization}`; `can()` only hides buttons.
- Leave (9311–9313): one immutable `leave_ledger`; `leave_quota` is a projection. Accrual at tenant-timezone month end, catch-up on the regular worker, backfill + `LEAVE.BALANCE.EXPORT` on INTENSIVE (all idempotent; system identity via job lease). Annual falls back to the shared unpaid balance; sick/emergency never. Payroll reads policy-absence unpaid spans, legacy `is_paid` for legacy rows.
- Leave capabilities `PEOPLE.LEAVE.{CONFIGURE,ASSIGN,APPROVE,ADJUST,EXPORT,ACCRUE}` are registered (9313, `seed.ts`) and granted to no role. Large export bytes live in `leave_export` (7-day retention), downloaded via `/api/leave/balances/export/[exportId]` (owner only, `private, no-store`).
- Tiers (`employee-tier.ts`, 9314): `position.tier` 1–9 (default 1) is set on the org chart; an employee's tier = tier of their current position. Actor tier: ADMINISTRATOR/PLATFORM_ADMIN role = 99, user linked via `employee.app_user_id` = that employee's tier, otherwise none (refused). Adding, assigning, approving or linking needs actor tier strictly above the person's/position's tier; changing a position tier needs above old and new. In-process capability-list callers bypass tier and scope.
- Hire approval: a live `createEmployee` writes a PENDING, inactive hire (`proposedPositionCode`, `proposedPlant`, `hireRequestedBy` = the session user, logged in the change log). `decideHire` needs `PEOPLE.EMPLOYEE.APPROVE` (granted to no role), higher tier, plant/company reach, and a different person from the requester (admins excepted); reject needs a note. A plant-limited clerk must name a plant they hold. `linkEmployeeUser` is the only writer of `app_user_id` (no self-link, active employee, one user per employee).
- Demo: tiers on demo positions, HR accounts `demo.hr{manager,officer,clerk1,clerk2}` linked to employees 10000101/102/103/20. `scripts/demo-hr-topup.ts` brings an existing demo tenant up to date (reuses the credential-file password).
- Company-configured pay (9318, `payroll-components.ts`): `employee_pay_component` (recurring, ADD | REPLACE, proration PAYABLE_CALENDAR_DAYS | NO_UNPAID_LEAVE_REDUCTION | FULL_PERIOD; gist exclusion stops overlapping active REPLACE rows) and `payroll_adjustment` (one-time, PENDING→APPROVED→APPLIED | REJECTED | CANCELLED; DB check: approver ≠ creator). Capabilities `PEOPLE.PAYROLL.COMPONENT.MAINTAIN` / `ADJUSTMENT.ENTER` / `ADJUSTMENT.APPROVE`, granted to no role. A percentage is of the ASSIGNED BASE only. Calculation (`computeResultDraft`) splits structure lines only where a REPLACE covers days; entries intersect each base segment; FULL_PERIOD lines apply once and refuse (`FULL_PERIOD_AMBIGUOUS`) on >1 assignment, partial coverage or a sibling entry. Lines carry `source_type/source_id/calc_basis`.
- Adjustments are applied at RELEASE (APPROVED→APPLIED under the period lock) and handed back when a released run is cancelled; a PROPOSED run is stale (`staleReasons`, `RUN_STALE_INPUTS`) when the approved set differs from its ONE_TIME lines or a recurring entry was written after `calculated_at` (background runs stamp the operation's `started_at`). Entry writes and calculation share `pg_advisory_xact_lock('employee-pay:…')`. History a RELEASED/POSTED result covers is frozen: entries touching it and adjustments for that period are refused. Release needs `acknowledgePending` while adjustments of the period are pending. Negative net → `NEGATIVE_NET_PAY` exception. Employer-contribution corrections are refused.
- Not implemented: self-service balances via `employee.appUserId`; sensitive report-access audit log; pending absence requests reserve no days.

## Files (76)
| file | exports | tables |
|---|---|---|
| **app/api/leave/balances/export/** | | |
| route.ts | GET |  |
| **app/api/leave/balances/export/[exportId]/** | | |
| route.ts | GET |  |
| **app/config/pay-components/** | | |
| actions.ts | defineComponentAction, changeComponentAction, defineMappingAction, changeMappingAction |  |
| page.tsx | PayComponentsPage |  |
| PayComponents.tsx | PayComponents |  |
| **app/config/people-record-types/** | | |
| actions.ts | defineRecordTypeAction, changeRecordTypeAction, addRecordFieldAction, changeRecordFieldAction |  |
| page.tsx | PeopleRecordTypesPage |  |
| RecordTypes.tsx | RecordTypes |  |
| **app/config/time-types/** | | |
| actions.ts | defineTimeTypeAction, changeTimeTypeAction, definePolicyAction, addPolicyVersionAction, retirePolicyAction, defineGroupAction, addMemberAction, endMemberAction, assignPolicyAction, endAssignmentAction |  |
| page.tsx | TimeTypesPage |  |
| TimeTypes.tsx | TimeTypes |  |
| **app/people/** | | |
| leave-live.ts | liveLeave, leaveRefusal, field |  |
| **app/people/assignments/** | | |
| actions.ts | assignAction, delimitAction, changeAssignmentAction |  |
| Assignments.tsx | Assignments |  |
| copy.ts | endedAssignmentMessage, dateParam |  |
| page.tsx | PeopleAssignmentsPage |  |
| **app/people/authority/** | | |
| Authority.tsx | Authority |  |
| page.tsx | PeopleAuthorityPage |  |
| **app/people/employees/** | | |
| actions.ts | createEmployeeAction, changeEmployeeAction, createRecordAction, delimitRecordAction, changeRecordValuesAction, decideHireAction, linkUserAction |  |
| component-actions.ts | addComponentAction, endComponentAction, withdrawComponentAction |  |
| Employees.tsx | Employees |  |
| page.tsx | PeopleEmployeesPage |  |
| PayStructure.tsx | AssignStructureForm, EndAssignmentForm |  |
| RecurringComponents.tsx | AddComponentForm, EntryActions |  |
| **app/people/organization/** | | |
| actions.ts | defineOrgUnitAction, changeOrgUnitAction, defineJobAction, changeJobAction, definePositionAction, changePositionAction |  |
| Organization.tsx | Organization |  |
| page.tsx | PeopleOrganizationPage |  |
| **app/people/payroll-results/** | | |
| page.tsx | PayrollResultPage |  |
| **app/people/payroll-runs/** | | |
| actions.ts | proposeRunAction, recalculateRunAction, releaseRunAction, cancelRunAction, postPayrollRunAction, cancelOperationAction, payrollOperationStatusAction, paySalaryRunAction |  |
| adjustment-actions.ts | enterAdjustmentAction, decideAdjustmentAction, cancelAdjustmentAction |  |
| Adjustments.tsx | EnterAdjustmentForm, AdjustmentRowActions |  |
| page.tsx | PayrollRunPage |  |
| RunForms.tsx | OperationPanel, ProposeRunForm, RunActions, PaySalaryForm |  |
| **app/people/salary-structures/** | | |
| actions.ts | defineStructureAction, changeStructureAction, setComponentAction, removeComponentAction, assignStructureAction, endAssignmentAction |  |
| page.tsx | SalaryStructurePage |  |
| StructureForms.tsx | DefineStructureForm, ChangeStructureForm, ComponentForm, RemoveComponentForm |  |
| **app/people/time-leave/** | | |
| AbsencesTab.tsx | AbsencesTab |  |
| actions.ts | previewAbsenceAction, requestAbsenceAction, decideAbsenceAction, recordTimeAction, adjustBalanceAction, runAccrualAction, queueExportAction, legacyConversionAction |  |
| BalancesTab.tsx | BalancesTab |  |
| page.tsx | TimeLeavePage |  |
| TimeLeave.tsx | TimeLeave |  |
| TimeRecordsTab.tsx | TimeRecordsTab |  |
| ui.tsx | INPUT, Notice, L, Section |  |
| **modules/people/** | | |
| assignment.ts | AssignmentError, assignPosition, changeAssignment, delimitAssignment, getAssignment, assignmentsOf, listAssignments, incumbentsOf, openAssignmentOf, ASSIGNMENT_CAPABILITY, ASSIGNMENT_ROUTE | cost_center, employee, org_hierarchy, org_unit, plant, position, position_assignment |
| authority-chart.ts | AUTHORITY_CHART_ROUTE, AUTHORITY_CHART_CAPABILITY, grantLines, levelLabel, authorityChart, authorityChartFor | app_user |
| chain-of-command.ts | ChainOfCommandError, positionsOfUser, holdersOfPosition, superiorPositionOf, orgUnitOfPosition, chainAbove, superiorOfUser, positionsBelow | app_user, employee, org_hierarchy, org_unit, position, position_assignment |
| delegation-status.ts | isTerminal, effectiveStatus, approvalsSatisfied, isLive |  |
| delegation.ts | DelegationError, approversFor, createDelegation, respondToDelegation, decideApproval, revokeDelegation, closeDelegation, assertMayControlDelegation, scopeCovers, refreshStatus, loadDelegation, delegationsForUser, approvalsSatisfied, effectiveStatus, isLive, isTerminal | audit_access_log, delegation, delegation_approval, delegation_scope |
| employee-master.ts | EmployeeMasterError, createEmployee, changeEmployee, getEmployee, listEmployees, decideHire, linkEmployeeUser, viewEmployee, searchEmployees, createRecord, delimitRecord, changeRecordValues, EMPLOYEE_CAPABILITY, EMPLOYEE_OBJECT_CLASS, EMPLOYEE_ROUTE, EMPLOYEE_RECORD_OBJECT_CLASS, RECORD_CAPABILITY | app_user, employee, employee_record, plant, record_field, record_field_value, record_type |
| employee-reach.ts | companyPlantsOf, plantScopes, isPlantLevel, scopeCoversAssignment, scopeReaches, assignmentScopes, employeeToday, currentAssignments, currentScopesOf, judgeLiveScope | client, cost_center, plant, position_assignment |
| employee-tier.ts | TOP_TIER, MIN_TIER, MAX_TIER, HIRE_APPROVE_CAPABILITY, positionTier, employeeTier, actorTier, tierRefusal | employee, position, position_assignment, role, user_role |
| leave-absence.ts | planAbsence, previewAbsence, requestLeaveAbsence, approveLeaveAbsence, rejectLeaveAbsence, cancelLeaveAbsence, absenceAllocations, addDays | absence, employee, leave_quota, payroll_result, payroll_run, time_type |
| leave-access.ts | LEAVE_CONFIGURE, LEAVE_ASSIGN, LEAVE_ENTER, LEAVE_APPROVE, LEAVE_ADJUST, LEAVE_VIEW, LEAVE_EXPORT, LEAVE_ACCRUE, LeaveError, isLeaveError, refuse, judgeLeave, actorOf, reachesEmployee, assertReachesEmployee, reachableEmployees |  |
| leave-accrual.ts | CATCH_UP_MONTHS, SYSTEM_ACCRUAL_ACCESS, accrueEmployee, accrueChunk, startAccrualRun, recordAccrualChunk, failAccrualRun, requestLeaveAccrual, leaveAccrualStatus, actorOf, tenantToday | employee, job_definition, job_run, leave_quota, position_assignment |
| leave-export.ts | LEAVE_EXPORT_JOB, LEAVE_EXPORT_RETENTION_DAYS, EXPORT_DOWNLOAD_PREFIX, requestLeaveExport, listLeaveExports, downloadLeaveExport, runLeaveExportChunk | job_run |
| leave-ledger.ts | lockEmployeeLeave, postLedgerEntry, balancesAsOf, projectionDrift, tenantToday, adjustLeaveBalance, previewLegacyConversion, applyLegacyConversion, listLedger | absence, client, leave_quota, time_type |
| leave-math.ts | SCALE, dayNumber, isoOf, addDays, daysInMonth, monthStart, monthEnd, daysInYear, spanDays, isValidTimezone, localDate, monthIsComplete, lastCompleteMonth, nextCreditMonthEnd, rat, addRat, mulRat, roundHalfUp, toScaled, fromScaled, monthEntitlement, cumulativeEntitlement, monthlyCredit, annualGrant, allocate |  |
| leave-policy.ts | defineLeavePolicy, addLeavePolicyVersion, changeLeavePolicy, defineLeaveGroup, addGroupMember, endGroupMember, assignLeavePolicy, endLeavePolicyAssignment, resolveLeaveSegments, getPolicy, listLeavePolicies, listLeaveGroups, listLeaveAssignments, LEAVE_VIEW | employee, time_type |
| leave-report.ts | REPORT_MAX_EMPLOYEES, REPORT_MAX_LINES, leaveBalanceReport, csvText, csvNumber, leaveBalanceCsv, EXPORT_MAX_EMPLOYEES, buildLargeCsv | absence, employee, leave_quota |
| leave-views.ts | searchLeaveEmployees, listLeaveAbsences, listLeaveTimeRecordings, listLeaveGroupChoices | absence, employee, time_recording, time_type |
| org-structure.ts | OrgStructureError, measureChain, defineOrgUnit, changeOrgUnit, getOrgUnit, listOrgUnits, defineJob, changeJob, getJob, listJobs, definePosition, changePosition, getPosition, listPositions, MAX_ORG_DEPTH, ORG_ROUTE, ORG_UNIT_CAPABILITY, POSITION_CAPABILITY, POSITION_OBJECT_CLASS, ORG_UNIT_OBJECT_CLASS | job, org_hierarchy, org_unit, position, position_assignment |
| pay-components.ts | PayComponentError, definePayComponent, changePayComponent, savePayComponentMapping, getPayComponent, listPayComponents, listChartsForMapping, listAccountsForSide, listCostCentresForMapping, isPayComponentError, listOpenPayComponents, COST_RECEIVER_CATEGORIES, PAY_COMPONENT_CAPABILITY, PAY_COMPONENT_CONFIG_OBJECT_CLASS, PAY_COMPONENT_KINDS, PAY_COMPONENT_OBJECT_CLASS, PAY_COMPONENT_ROUTE | chart_of_accounts, cost_center, gl_account, pay_component, pay_component_config |
| payroll-access.ts | judgePayrollAccess, reachesCompany, assertCompanyScope |  |
| payroll-background.ts | PAYROLL_CALC_JOB, PAYROLL_POST_JOB, submitPayrollProposal, submitPayrollRecalculation, submitPayrollPosting, cancelPayrollOperation, listPayrollOperations, getPayrollOperation, runPayrollCalcChunk, runPayrollPostChunk | job_run, payroll_calc_stage, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation |
| payroll-components.ts | COMPANY_RESPONSIBILITY_NOTICE, BASIS_LABEL, addEmployeeComponent, endEmployeeComponent, withdrawEmployeeComponent, listEmployeeComponents, listEntryComponents, enterAdjustment, decideAdjustment, cancelAdjustment, listAdjustments, ADJUSTMENT_APPROVE_CAPABILITY, ADJUSTMENT_ENTER_CAPABILITY, COMPONENT_MAINTAIN_CAPABILITY, COMPONENT_MODES, PRORATION_POLICIES | cost_center, employee, employee_pay_component, pay_component, pay_component_config, payroll_adjustment, payroll_result, payroll_run, position_assignment |
| payroll-posting.ts | PAYROLL_POST_CAPABILITY, PAYROLL_POSTING_DOCUMENT_TYPE, PAYROLL_NET_PAY_EVENT, PayrollPostingError, buildPayrollJournal, postPayrollRun, getPayrollPosting | account_determination, accounting_reversal_link, gl_account, journal_entry, journal_entry_line, pay_component, payroll_result, payroll_result_line, payroll_run |
| payroll-run.ts | PayrollRunError, refuse, EXECUTE, judge, INFORMATIONAL_EXCEPTIONS, translateTrigger, proposeInput, runActionInput, parse, releaseInput, daysBetween, payableDaysFor, daysOutside, calculateComponent, runView, staleReasonsOf, getPayrollRun, listPayrollRuns, listResults, getResultWithLines, currencyDecimals, loadRun, runRowFrom, selectEmployees, calculateResult, computeResultDraft, coverageOf, lockPeriod, assertPeriodOpen, proposePayrollRun, recalculatePayrollRun, activeOperation, assertNoActiveOperation, assertCalculationSettled, assertProposed, releasePayrollRun, cancelPayrollRun, listPayrollCompanies, currentPayrollPeriod, PAYROLL_RESULT_CAPABILITY, PAYROLL_RESULT_ROUTE, PAYROLL_RUN_CAPABILITY, PAYROLL_RUN_ROUTE | absence, company_code, cost_center, currency, employee, employee_pay_component, pay_component, pay_component_config, payroll_adjustment, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation, position_assignment, salary_structure_assignment, salary_structure_component, time_type |
| payroll-structure.ts | EMPLOYEE_ROUTE, PAY_COMPONENT_ROUTE, EOS_PROVISION_KIND, PAYROLL_RESULT_CAPABILITY, PayrollStructureError, assertEmployeeScope, defineSalaryStructure, changeSalaryStructure, setStructureComponent, listStructures, getStructure, listAssignableComponents, removeStructureComponent, assignStructure, endAssignment, assignmentFor, listAssignments, validateEmployeeForRun, employeeRunReadiness, defaultPayrollCurrency, AMOUNT_KINDS, SALARY_ASSIGNMENT_OBJECT_CLASS, SALARY_STRUCTURE_CAPABILITY, SALARY_STRUCTURE_OBJECT_CLASS, SALARY_STRUCTURE_ROUTE | company_code, cost_center, currency, employee, pay_component, pay_component_config, position_assignment, salary_structure, salary_structure_assignment, salary_structure_component |
| record-types.ts | RecordTypeConfigError, defineRecordType, getRecordType, listRecordTypes, changeRecordType, addRecordField, changeRecordField, RECORD_TYPE_CAPABILITY, RECORD_TYPE_ROUTE | employee_record, record_field, record_field_value, record_type |
| salary-payment.ts | SalaryPaymentError, buildSalaryPaymentJournal, paySalaryRun, getSalaryPayment, SALARY_PAYMENT_CAPABILITY, SALARY_PAYMENT_DOCUMENT_TYPE | account_determination, accounting_reversal_link, bank_account, employee, house_bank, journal_entry, journal_entry_line, payroll_result, payroll_run, salary_payment |
| schema.ts | RECORD_VALUE_KINDS, RECORD_TYPE_ROUTE, EMPLOYEE_ROUTE, RECORD_TYPE_CAPABILITY, EMPLOYEE_CAPABILITY, RECORD_CAPABILITY, RECORD_TYPE_OBJECT_CLASS, EMPLOYEE_OBJECT_CLASS, EMPLOYEE_RECORD_OBJECT_CLASS, ORG_ROUTE, ASSIGNMENT_ROUTE, ORG_UNIT_CAPABILITY, POSITION_CAPABILITY, ASSIGNMENT_CAPABILITY, AUTHORITY_ROUTE, AUTHORITY_VIEW_CAPABILITY, ORG_UNIT_OBJECT_CLASS, JOB_OBJECT_CLASS, POSITION_OBJECT_CLASS, ORG_HIERARCHY_OBJECT_CLASS, ASSIGNMENT_OBJECT_CLASS, ORG_RELATIONS, ORG_NODE_KINDS, MAX_ORG_DEPTH, recordType, recordField, employee, employeeRecord, recordFieldValue, orgUnit, job, position, orgHierarchy, delegation, delegationScope, delegationApproval, positionAssignment, PAY_COMPONENT_KINDS, COST_RECEIVER_CATEGORIES, PAY_COMPONENT_ROUTE, PAY_COMPONENT_CAPABILITY, PAY_COMPONENT_OBJECT_CLASS, PAY_COMPONENT_CONFIG_OBJECT_CLASS, payComponent, payComponentConfig, SALARY_STRUCTURE_ROUTE, SALARY_STRUCTURE_CAPABILITY, SALARY_STRUCTURE_OBJECT_CLASS, SALARY_ASSIGNMENT_OBJECT_CLASS, AMOUNT_KINDS, salaryStructure, salaryStructureComponent, salaryStructureAssignment, PAYROLL_RUN_ROUTE, PAYROLL_RESULT_ROUTE, PAYROLL_RUN_CAPABILITY, PAYROLL_RUN_OBJECT_CLASS, PAYROLL_RESULT_OBJECT_CLASS, PAYROLL_RUN_STATUSES, PAYROLL_RESULT_ORIGINS, payrollRun, payrollRunOperation, payrollCalcStage, payrollRunException, payrollResult, payrollResultLine, SALARY_PAYMENT_CAPABILITY, SALARY_PAYMENT_DOCUMENT_TYPE, SALARY_PAYMENT_OBJECT_CLASS, salaryPayment, TIME_TYPE_KINDS, ABSENCE_STATUSES, timeType, absence, leaveQuota, timeRecording, COMPONENT_MAINTAIN_CAPABILITY, ADJUSTMENT_ENTER_CAPABILITY, ADJUSTMENT_APPROVE_CAPABILITY, EMPLOYEE_COMPONENT_OBJECT_CLASS, PAYROLL_ADJUSTMENT_OBJECT_CLASS, COMPONENT_MODES, PRORATION_POLICIES, ADJUSTMENT_STATUSES, LINE_SOURCES, employeePayComponent, payrollAdjustment | absence, delegation, delegation_approval, delegation_scope, employee, employee_pay_component, employee_record, job, leave_quota, org_hierarchy, org_unit, pay_component, pay_component_config, payroll_adjustment, payroll_calc_stage, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation, position, position_assignment, record_field, record_field_value, record_type, salary_payment, salary_structure, salary_structure_assignment, salary_structure_component, time_recording, time_type |
| time-leave.ts | TIME_LEAVE_ROUTE, TIME_ENTER_CAPABILITY, LEAVE_VIEW_CAPABILITY, TIME_TYPE_OBJECT_CLASS, ABSENCE_OBJECT_CLASS, LEAVE_QUOTA_OBJECT_CLASS, TIME_RECORDING_OBJECT_CLASS, ABSENCE_STATUSES, TimeLeaveError, defineTimeType, changeTimeType, requestAbsence, decideAbsence, cancelAbsence, recordTime, setLeaveQuota, getTimeTypeView, getAbsence, absencesOf, listAbsences, getLeaveQuota, listTimeTypes, getTimeRecording, isTimeLeaveError, openAbsenceOn, TIME_TYPE_KINDS | absence, employee, leave_quota, time_recording, time_type |
| **modules/people/jobs/** | | |
| grant-expiring.ts | GRANT_EXPIRING_JOB, grantExpiringJob | user_capability |
| leave-accrual.ts | LEAVE_ACCRUAL_JOB, LEAVE_BACKFILL_JOB, leaveAccrualJob, leaveBackfillJob | app_user, job_run |
| leave-export.ts | leaveExportJob |  |
| payroll-run.ts | payrollCalcJob, payrollPostJob |  |

## Routes (13)
`/api/leave/balances/export` · `/api/leave/balances/export/[exportId]` · `/config/pay-components` · `/config/people-record-types` · `/config/time-types` · `/people/assignments` · `/people/authority` · `/people/employees` · `/people/organization` · `/people/payroll-results` · `/people/payroll-runs` · `/people/salary-structures` · `/people/time-leave`

## Tables owned (31)
absence, delegation, delegation_approval, delegation_scope, employee, employee_pay_component, employee_record, job, leave_quota, org_hierarchy, org_unit, pay_component, pay_component_config, payroll_adjustment, payroll_calc_stage, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation, position, position_assignment, record_field, record_field_value, record_type, salary_payment, salary_structure, salary_structure_assignment, salary_structure_component, time_recording, time_type

## Depends on
finance, foundation, platform/auth, platform/change, platform/db, platform/i18n, platform/job, platform/notification, platform/numbering, platform/periods, platform/posting, platform/tables, ui/kit

## Used by
dev/walkthrough-volume.ts, platform, platform/auth, platform/notification, platform/tenancy, purchasing, worker/jobs.ts

## Tests (28)
attention, authority-chart, authority-model, chain-of-command, delegation, leave-absence, leave-accrual, leave-export, leave-math, leave-policy, leave-report, leave-views, payroll-background, payroll-company-components, payroll-components-background, payroll-followup, payroll-posting, payroll-run, payroll-structure, people-authorization, people-employee-master, people-org-assignment, people-pay-components, people-plant-scope, people-service-authorization, people-tier-approval, people-time-leave, salary-payment

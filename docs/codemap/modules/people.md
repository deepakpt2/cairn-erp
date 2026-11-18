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

## Files (48)
| file | exports | tables |
|---|---|---|
| **app/config/pay-components/** | | |
| actions.ts | defineComponentAction, changeComponentAction, defineMappingAction, changeMappingAction |  |
| page.tsx | PayComponentsPage |  |
| PayComponents.tsx | PayComponents |  |
| **app/config/people-record-types/** | | |
| actions.ts | defineRecordTypeAction, changeRecordTypeAction, addRecordFieldAction, changeRecordFieldAction |  |
| page.tsx | PeopleRecordTypesPage |  |
| RecordTypes.tsx | RecordTypes |  |
| **app/people/assignments/** | | |
| actions.ts | assignAction, delimitAction, changeAssignmentAction |  |
| Assignments.tsx | Assignments |  |
| copy.ts | endedAssignmentMessage, dateParam |  |
| page.tsx | PeopleAssignmentsPage |  |
| **app/people/authority/** | | |
| Authority.tsx | Authority |  |
| page.tsx | PeopleAuthorityPage |  |
| **app/people/employees/** | | |
| actions.ts | createEmployeeAction, changeEmployeeAction, createRecordAction, delimitRecordAction, changeRecordValuesAction |  |
| Employees.tsx | Employees |  |
| page.tsx | PeopleEmployeesPage |  |
| PayStructure.tsx | AssignStructureForm, EndAssignmentForm |  |
| **app/people/organization/** | | |
| actions.ts | defineOrgUnitAction, changeOrgUnitAction, defineJobAction, changeJobAction, definePositionAction, changePositionAction |  |
| Organization.tsx | Organization |  |
| page.tsx | PeopleOrganizationPage |  |
| **app/people/payroll-results/** | | |
| page.tsx | PayrollResultPage |  |
| **app/people/payroll-runs/** | | |
| actions.ts | proposeRunAction, recalculateRunAction, releaseRunAction, cancelRunAction, postPayrollRunAction, cancelOperationAction, payrollOperationStatusAction, paySalaryRunAction |  |
| page.tsx | PayrollRunPage |  |
| RunForms.tsx | OperationPanel, ProposeRunForm, RunActions, PaySalaryForm |  |
| **app/people/salary-structures/** | | |
| actions.ts | defineStructureAction, changeStructureAction, setComponentAction, removeComponentAction, assignStructureAction, endAssignmentAction |  |
| page.tsx | SalaryStructurePage |  |
| StructureForms.tsx | DefineStructureForm, ChangeStructureForm, ComponentForm, RemoveComponentForm |  |
| **app/people/time-leave/** | | |
| actions.ts | defineTimeTypeAction, changeTimeTypeAction, requestAbsenceAction, decideAbsenceAction, recordTimeAction, setLeaveQuotaAction |  |
| page.tsx | TimeLeavePage |  |
| TimeLeave.tsx | TimeLeave |  |
| **modules/people/** | | |
| assignment.ts | AssignmentError, assignPosition, changeAssignment, delimitAssignment, getAssignment, assignmentsOf, listAssignments, incumbentsOf, openAssignmentOf, ASSIGNMENT_CAPABILITY, ASSIGNMENT_ROUTE | cost_center, employee, org_hierarchy, org_unit, position, position_assignment |
| authority-chart.ts | AUTHORITY_CHART_ROUTE, AUTHORITY_CHART_CAPABILITY, grantLines, levelLabel, authorityChart, authorityChartFor | app_user |
| chain-of-command.ts | ChainOfCommandError, positionsOfUser, holdersOfPosition, superiorPositionOf, orgUnitOfPosition, chainAbove, superiorOfUser, positionsBelow | app_user, employee, org_hierarchy, org_unit, position, position_assignment |
| delegation-status.ts | isTerminal, effectiveStatus, approvalsSatisfied, isLive |  |
| delegation.ts | DelegationError, approversFor, createDelegation, respondToDelegation, decideApproval, revokeDelegation, closeDelegation, assertMayControlDelegation, scopeCovers, refreshStatus, loadDelegation, delegationsForUser, approvalsSatisfied, effectiveStatus, isLive, isTerminal | audit_access_log, delegation, delegation_approval, delegation_scope |
| employee-master.ts | EmployeeMasterError, createEmployee, changeEmployee, getEmployee, listEmployees, createRecord, delimitRecord, changeRecordValues, EMPLOYEE_CAPABILITY, EMPLOYEE_OBJECT_CLASS, EMPLOYEE_ROUTE, EMPLOYEE_RECORD_OBJECT_CLASS, RECORD_CAPABILITY | employee, employee_record, record_field, record_field_value, record_type |
| org-structure.ts | OrgStructureError, measureChain, defineOrgUnit, changeOrgUnit, getOrgUnit, listOrgUnits, defineJob, changeJob, getJob, listJobs, definePosition, changePosition, getPosition, listPositions, MAX_ORG_DEPTH, ORG_ROUTE, ORG_UNIT_CAPABILITY, POSITION_CAPABILITY, POSITION_OBJECT_CLASS, ORG_UNIT_OBJECT_CLASS | job, org_hierarchy, org_unit, position, position_assignment |
| pay-components.ts | PayComponentError, definePayComponent, changePayComponent, savePayComponentMapping, getPayComponent, listPayComponents, listChartsForMapping, listAccountsForSide, listCostCentresForMapping, isPayComponentError, listOpenPayComponents, COST_RECEIVER_CATEGORIES, PAY_COMPONENT_CAPABILITY, PAY_COMPONENT_CONFIG_OBJECT_CLASS, PAY_COMPONENT_KINDS, PAY_COMPONENT_OBJECT_CLASS, PAY_COMPONENT_ROUTE | chart_of_accounts, cost_center, gl_account, pay_component, pay_component_config |
| payroll-access.ts | judgePayrollAccess, reachesCompany, assertCompanyScope |  |
| payroll-background.ts | PAYROLL_CALC_JOB, PAYROLL_POST_JOB, submitPayrollProposal, submitPayrollRecalculation, submitPayrollPosting, cancelPayrollOperation, listPayrollOperations, getPayrollOperation, runPayrollCalcChunk, runPayrollPostChunk | job_run, payroll_calc_stage, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation |
| payroll-posting.ts | PAYROLL_POST_CAPABILITY, PAYROLL_POSTING_DOCUMENT_TYPE, PAYROLL_NET_PAY_EVENT, PayrollPostingError, buildPayrollJournal, postPayrollRun, getPayrollPosting | account_determination, accounting_reversal_link, gl_account, journal_entry, journal_entry_line, pay_component, payroll_result, payroll_result_line, payroll_run |
| payroll-run.ts | PayrollRunError, refuse, EXECUTE, judge, INFORMATIONAL_EXCEPTIONS, translateTrigger, proposeInput, runActionInput, parse, daysBetween, payableDaysFor, calculateComponent, runView, getPayrollRun, listPayrollRuns, listResults, getResultWithLines, loadRun, runRowFrom, selectEmployees, calculateResult, computeResultDraft, coverageOf, lockPeriod, assertPeriodOpen, proposePayrollRun, recalculatePayrollRun, activeOperation, assertNoActiveOperation, assertCalculationSettled, assertProposed, releasePayrollRun, cancelPayrollRun, listPayrollCompanies, currentPayrollPeriod, PAYROLL_RESULT_CAPABILITY, PAYROLL_RESULT_ROUTE, PAYROLL_RUN_CAPABILITY, PAYROLL_RUN_ROUTE | absence, company_code, cost_center, currency, employee, pay_component, pay_component_config, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation, position_assignment, salary_structure_assignment, salary_structure_component, time_type |
| payroll-structure.ts | EMPLOYEE_ROUTE, PAY_COMPONENT_ROUTE, EOS_PROVISION_KIND, PAYROLL_RESULT_CAPABILITY, PayrollStructureError, defineSalaryStructure, changeSalaryStructure, setStructureComponent, listStructures, getStructure, listAssignableComponents, removeStructureComponent, assignStructure, endAssignment, assignmentFor, listAssignments, validateEmployeeForRun, employeeRunReadiness, defaultPayrollCurrency, AMOUNT_KINDS, SALARY_ASSIGNMENT_OBJECT_CLASS, SALARY_STRUCTURE_CAPABILITY, SALARY_STRUCTURE_OBJECT_CLASS, SALARY_STRUCTURE_ROUTE | company_code, cost_center, currency, employee, pay_component, pay_component_config, position_assignment, salary_structure, salary_structure_assignment, salary_structure_component |
| record-types.ts | RecordTypeConfigError, defineRecordType, getRecordType, listRecordTypes, changeRecordType, addRecordField, changeRecordField, RECORD_TYPE_CAPABILITY, RECORD_TYPE_ROUTE | employee_record, record_field, record_field_value, record_type |
| salary-payment.ts | SalaryPaymentError, buildSalaryPaymentJournal, paySalaryRun, getSalaryPayment, SALARY_PAYMENT_CAPABILITY, SALARY_PAYMENT_DOCUMENT_TYPE | account_determination, accounting_reversal_link, bank_account, employee, house_bank, journal_entry, journal_entry_line, payroll_result, payroll_run, salary_payment |
| schema.ts | RECORD_VALUE_KINDS, RECORD_TYPE_ROUTE, EMPLOYEE_ROUTE, RECORD_TYPE_CAPABILITY, EMPLOYEE_CAPABILITY, RECORD_CAPABILITY, RECORD_TYPE_OBJECT_CLASS, EMPLOYEE_OBJECT_CLASS, EMPLOYEE_RECORD_OBJECT_CLASS, ORG_ROUTE, ASSIGNMENT_ROUTE, ORG_UNIT_CAPABILITY, POSITION_CAPABILITY, ASSIGNMENT_CAPABILITY, AUTHORITY_ROUTE, AUTHORITY_VIEW_CAPABILITY, ORG_UNIT_OBJECT_CLASS, JOB_OBJECT_CLASS, POSITION_OBJECT_CLASS, ORG_HIERARCHY_OBJECT_CLASS, ASSIGNMENT_OBJECT_CLASS, ORG_RELATIONS, ORG_NODE_KINDS, MAX_ORG_DEPTH, recordType, recordField, employee, employeeRecord, recordFieldValue, orgUnit, job, position, orgHierarchy, delegation, delegationScope, delegationApproval, positionAssignment, PAY_COMPONENT_KINDS, COST_RECEIVER_CATEGORIES, PAY_COMPONENT_ROUTE, PAY_COMPONENT_CAPABILITY, PAY_COMPONENT_OBJECT_CLASS, PAY_COMPONENT_CONFIG_OBJECT_CLASS, payComponent, payComponentConfig, SALARY_STRUCTURE_ROUTE, SALARY_STRUCTURE_CAPABILITY, SALARY_STRUCTURE_OBJECT_CLASS, SALARY_ASSIGNMENT_OBJECT_CLASS, AMOUNT_KINDS, salaryStructure, salaryStructureComponent, salaryStructureAssignment, PAYROLL_RUN_ROUTE, PAYROLL_RESULT_ROUTE, PAYROLL_RUN_CAPABILITY, PAYROLL_RUN_OBJECT_CLASS, PAYROLL_RESULT_OBJECT_CLASS, PAYROLL_RUN_STATUSES, PAYROLL_RESULT_ORIGINS, payrollRun, payrollRunOperation, payrollCalcStage, payrollRunException, payrollResult, payrollResultLine, SALARY_PAYMENT_CAPABILITY, SALARY_PAYMENT_DOCUMENT_TYPE, SALARY_PAYMENT_OBJECT_CLASS, salaryPayment, TIME_TYPE_KINDS, ABSENCE_STATUSES, timeType, absence, leaveQuota, timeRecording | absence, delegation, delegation_approval, delegation_scope, employee, employee_record, job, leave_quota, org_hierarchy, org_unit, pay_component, pay_component_config, payroll_calc_stage, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation, position, position_assignment, record_field, record_field_value, record_type, salary_payment, salary_structure, salary_structure_assignment, salary_structure_component, time_recording, time_type |
| time-leave.ts | TIME_LEAVE_ROUTE, TIME_ENTER_CAPABILITY, LEAVE_VIEW_CAPABILITY, TIME_TYPE_OBJECT_CLASS, ABSENCE_OBJECT_CLASS, LEAVE_QUOTA_OBJECT_CLASS, TIME_RECORDING_OBJECT_CLASS, ABSENCE_STATUSES, TimeLeaveError, defineTimeType, changeTimeType, requestAbsence, decideAbsence, cancelAbsence, recordTime, setLeaveQuota, getTimeTypeView, getAbsence, absencesOf, listAbsences, getLeaveQuota, listTimeTypes, getTimeRecording, isTimeLeaveError, openAbsenceOn, TIME_TYPE_KINDS | absence, employee, leave_quota, time_recording, time_type |
| **modules/people/jobs/** | | |
| grant-expiring.ts | GRANT_EXPIRING_JOB, grantExpiringJob | user_capability |
| payroll-run.ts | payrollCalcJob, payrollPostJob |  |

## Routes (10)
`/config/pay-components` · `/config/people-record-types` · `/people/assignments` · `/people/authority` · `/people/employees` · `/people/organization` · `/people/payroll-results` · `/people/payroll-runs` · `/people/salary-structures` · `/people/time-leave`

## Tables owned (29)
absence, delegation, delegation_approval, delegation_scope, employee, employee_record, job, leave_quota, org_hierarchy, org_unit, pay_component, pay_component_config, payroll_calc_stage, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, payroll_run_operation, position, position_assignment, record_field, record_field_value, record_type, salary_payment, salary_structure, salary_structure_assignment, salary_structure_component, time_recording, time_type

## Depends on
finance, foundation, platform/auth, platform/change, platform/db, platform/i18n, platform/job, platform/notification, platform/numbering, platform/periods, platform/posting, platform/tables, ui/kit

## Used by
dev/walkthrough-volume.ts, platform, platform/auth, platform/notification, platform/tenancy, purchasing, worker/jobs.ts

## Tests (17)
attention, authority-chart, authority-model, chain-of-command, delegation, payroll-background, payroll-followup, payroll-posting, payroll-run, payroll-structure, people-authorization, people-employee-master, people-org-assignment, people-pay-components, people-service-authorization, people-time-leave, salary-payment

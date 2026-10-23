# Tables and functions: what the app uses

Audit only. Nothing was deleted or wired. This is not an S/4HANA parity claim.

Checked on 23 October 2026 against the code. The local database was not used for this pass. A name in a comment does not count as use. A trigger counts as use, because the database runs it on a write.

## Scope

- 314 Drizzle tables. Every one has a `CREATE TABLE` in `drizzle/`.
- Three more tables exist only in SQL and are used by the planning run: `mrp_run_material`, `mrp_run_proposal`, `mrp_run_diagnostic`. They are not in the Drizzle schema. They are not unused.
- 1,482 exported functions in `src`. 1,399 are called by application code. 63 are reached only from tests or scripts. 20 have no caller.
- Seven SQL functions. Five are used. One is a trigger pair counted in those five. One is never called.

No view is defined.

## Tables the app never reads or writes

These names do not appear in a query outside the file that defines them.

| Table | What it was for | What happens instead |
| --- | --- | --- |
| `auth_org_restriction` | Limit a user to a company, plant, or similar | Authorisation does not read it |
| `sod_rule` | Segregation of duties | Role assignment does not read it |
| `message_catalog` | User-facing messages | The app uses the TypeScript dictionary in `src/platform/i18n` |
| `job_definition`, `job_run`, `job_log` | Scheduled work | Nothing queues or reads a job |
| `mail_server_config` | Mail server | Nothing sends mail from this table |
| `lock_object` | Lock definitions for the monitor | The lock screen reads `enqueue_entry`. It does not read this catalogue |
| `capability` | Capability catalogue | Migrations insert rows. Sign-in reads `role_capability` patterns and never this table |

`message_catalog` is also inserted by `scripts/seed.ts`. The application still never selects it.

## Data that is stored and never read

The application writes these. No later function selects them.

| Table | Written by | Not used for |
| --- | --- | --- |
| `client_settings` | Tenant creation. The fiscal-year variant is copied here. Display format, date format, separators, and flags stay at defaults | Nothing. Posting reads the company code's variant, not this row |
| `role` | Tenant creation inserts the system roles | Sign-in reads `user_role` and `role_capability`, not the role name or description |
| `document_status_history` | Every journal post and reversal, through `recordStatusChange` | No document display reads the history |
| `audit_access_log` | Sign-in, and a bank-data reveal | No screen lists it |
| `lock_wait_log` | A lock wait | The lock screen lists current enqueue rows, not waits |
| `gl_account_transfer_run`, `gl_account_transfer_result` | The G/L transfer | The function returns the lines in memory. Nothing reads the stored run |
| `customer_down_payment_clearing_item` | Customer down-payment clearing | The clearing header is read. The item rows are not |
| `consolidation_dimension` | Save of a consolidation data basis | The workbench reloads the basis, not the dimensions. A later consolidation step does not read them |
| `allocation_structure` | Settlement-rule save writes the structure header, including the description | Settlement reads the profile's structure code and `allocation_structure_assignment`. It does not read the header or the description |
| `partner_bank_profile_activation_audit` | `cairn_activate_partner_bank_profile`, which the activation service calls | Nothing selects the audit row |

`cost_center_plan` is the reverse. The cost-center report reads it. No application function inserts it. A browser-smoke script does. That is a reader without an application writer, not stored data without a reader.

Credit lookup tables (`credit_risk_category`, `credit_representative_group`, `customer_credit_group`, `credit_block_reason`) are read. The read is built as `select ... from ${table}` inside `credit.ts`, so a plain `from credit_risk_category` search misses it. They are not unused.

`factory_calendar` is read when a sales organisation is saved. The import is aliased, so a search for `.from(factoryCalendar)` misses it. It is not unused.

## SQL functions

| Function | Use |
| --- | --- |
| `cairn_assert_journal_balances` | Trigger on journal write |
| `cairn_assert_company_code_refs` | Trigger on company-code write |
| `coa_key_registry_exclusive` | Trigger on chart-of-accounts write |
| `cairn_config_readiness` | Workbench progress |
| `cairn_list_tenants` | Tenant list |
| `cairn_activate_partner_bank_profile` | Partner-bank activation. The audit insert it writes is not read |
| `cairn_tenant_exists` | Never called. The comment says sign-in uses it. Sign-in does not |

## Functions with no caller

These are exported and named nowhere else in `src`, `tests`, or `scripts`.

- `equalsScaled`
- `getPostingPeriodVariant`
- `tokenHashFor`, `constantTimeEquals`
- `aliasesFor` — registry "also known as" was not wired
- `currentLocks` — comment says it powers the lock monitor. The monitor calls `listEnqueue` instead
- `listChartCopies`
- `listTemplateTasks`
- `getCreditExposure` — credit master is read by other functions in the same file. This reader is not
- `listTaxReturnRuns`
- `getReturnDocument`
- `listValuationPlants`
- `validatePlantBatchStatus`
- `deliveryScheduleHistory`
- `activityCategoryLabel`, `priceIndicatorLabel`
- `listConfigurationChoices`
- `controllingAreaHasRecordedTransactions`
- `countActivityRates`
- `openDifferenceWorkflowAction`

## Functions only tests or scripts call

63 exported functions are not called by a screen or another application function. Tests or scripts call them. That is not the same as a missing table.

Left unwired on purpose, from earlier closed work. Do not connect them from this audit:

- `determineBatch`, `determineBatches`, `evaluateBatchClass`, `rankSuppliedCandidates`, `checkEnteredBatch`
- `traceBatchGenealogy`, `createBatchIdentity`
- `executeBatchStatusConversion`, `executeBatchLevelConversion`, `executePlantStatusConversion`
- `createWipBatch` — it refuses. Nothing is supposed to call it from a screen

Stale, not a second posting path: `orderSettlementPosting` still returns `posts: false`. The screen calls `settleOrder`.

The other test-only names include readers a screen does not call, such as `getQuotation`, `getCustomerDownPayments`, `getVendorDownPayments`, `getAssetTransactions`, `getAssetRetirements`, `getPostedDepreciation`, and `listReleaseEvents`. The screens that work use other functions. These exports are unused by the app. This pass did not open each screen to prove the underlying rows are also unread.

## Not done

No screen was opened. No test was run. No table or function was removed. The closed batch, WIP, and settlement decisions were not reopened.

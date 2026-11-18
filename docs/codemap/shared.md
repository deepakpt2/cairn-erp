# Shared
Cross-cutting code: `src/platform/*`, `src/ui/*`, `src/worker/*`, `src/dev/*`, app shell (`app/` root, `/config` workbench, auth, clients, registry). Paths relative to `src/`.

## Gotchas

- Jobs hold a lease epoch (`job_run.claim_epoch`, bumped by `job_claim_next` and the reaper). Business writes call `ctx.fence(tx)`; a stale owner gets `LeaseLostError`/`LEASE_LOST`. Two workers: `worker` (DEFAULT,MAIL,OUTPUT, owns scheduler) and `worker-intensive` (INTENSIVE); an empty queue list means ALL, so `src/worker/config.ts` refuses it.
- **RLS:** tenant tables are FORCE RLS (313 in the baseline) on `cairn.client`; only `withTenant`/`withTenantAs` (`SET LOCAL cairn.client` / `cairn.user`) see rows. `client.ts` refuses a superuser runtime role. Never call `withTenant` inside a `tx` (it opens a new transaction).
- **SECURITY DEFINER:** `job_claim_next`, `job_orphan_clients`, `job_all_clients`, `notification_deliver` and the payroll triggers run as their owner. Every object must be owned by `cairn_integration_migrator`; migrating as `erp_user` breaks them.
- **Jobs:** requests only `enqueue` in their own tx; the worker claims cross-tenant via `job_claim_next`, then works in `withTenant`. A handler exists only if `src/worker/jobs.ts` imports it. `tickScheduler` has no caller yet.
- **Notifications** are written in the business tx; "whoever may act" goes through the `NOTIFY.FANOUT` job. A notification is a pointer, never a permission.
- **Demo install:** refuses a non-empty DB; global phase ledger in `demo_installation*` (SQL-only tables). Phases append to `DEMO_PHASE_PLAN`; a FAILED marker blocks resume.
- Money never floats: `platform/posting/decimal.ts` scaled bigints. `platform/schema.ts` is the only Drizzle entrypoint; new tables are re-exported there.
- `ScreenArea` splits foundation into foundation/controlling/configuration; not 1:1 with modules. i18n is effectively `en` only.

## Used by
| shared unit | used by |
|---|---|
| app/command.ts | ui/shell |
| app/registry | app/command.ts |
| platform/attention | app/page.tsx, ui/attention |
| platform/auth | app/account, app/api, app/clients, app/config, app/menu, app/page.tsx, app/search, app/signin, audit, finance, foundation, inventory, output, people, platform, platform/attention, platform/job, platform/mail, platform/notification, platform/security, platform/tenancy, production, purchasing, quality, sales, ui/shell |
| platform/change | audit, finance, foundation, inventory, output, people, platform, platform/auth, platform/lock, platform/mail, platform/posting, platform/security, platform/tenancy, production, purchasing, quality, sales |
| platform/db | app/api, app/config, audit, dev/walkthrough-asset.ts, dev/walkthrough-volume.ts, finance, foundation, inventory, output, people, platform, platform/attention, platform/auth, platform/change, platform/document, platform/job, platform/lock, platform/mail, platform/notification, platform/numbering, platform/periods, platform/posting, platform/registry, platform/security, platform/tenancy, production, purchasing, quality, sales, worker/index.ts |
| platform/document | inventory, platform/posting, purchasing |
| platform/i18n | app/clients, app/config, app/layout.tsx, app/menu, app/page.tsx, app/registry, app/search, app/signin, audit, finance, foundation, inventory, people, platform, platform/attention, platform/notification, production, purchasing, sales, ui/attention, ui/fields, ui/lock, ui/shell |
| platform/job | finance, foundation, output, people, platform, platform/mail, platform/notification, production, purchasing, worker/index.ts |
| platform/lock | finance, foundation, inventory, platform, platform/job, platform/posting, production, purchasing, quality, ui/lock |
| platform/mail | output, platform, worker/jobs.ts |
| platform/notification | finance, foundation, people, platform, platform/job, production, purchasing, sales, ui/shell, worker/jobs.ts |
| platform/numbering | finance, foundation, inventory, people, platform/posting, platform/tenancy, production, purchasing, quality, sales |
| platform/periods | finance, foundation, inventory, people, platform/posting, platform/tenancy, production, purchasing, sales |
| platform/posting | finance, foundation, inventory, people, platform/tenancy, production, purchasing, sales |
| platform/registry | app/command.ts, app/registry, app/search |
| platform/schema.ts | platform/db |
| platform/security | foundation, platform/auth, platform/mail |
| platform/tables | audit, finance, foundation, inventory, people, platform, platform/attention, platform/auth, platform/change, platform/document, platform/job, platform/lock, platform/mail, platform/notification, platform/numbering, platform/posting, platform/registry, platform/security, platform/tenancy, production, purchasing, quality, sales |
| platform/tenancy | app/clients, app/config, app/page.tsx, finance, foundation, inventory, platform, production, purchasing |
| ui/attention | app/page.tsx |
| ui/fields | finance, foundation, inventory, purchasing, sales |
| ui/kit | app/dev, purchasing, sales |
| ui/lock | finance, foundation, inventory, platform, production, purchasing, quality |
| ui/output | finance, foundation, inventory, output, production, purchasing, sales |
| ui/release | finance |
| ui/shell | app/layout.tsx, app/menu, app/page.tsx, app/registry, app/search |
| worker/jobs.ts | worker/index.ts |

## Files (186)
| file | exports | tables |
|---|---|---|
| **app/** | | |
| command.ts | executeCommand |  |
| layout.tsx | viewport, RootLayout |  |
| page.tsx | LaunchpadPage |  |
| **app/account/** | | |
| actions.ts | changePasswordAction, revokeSessionAction, savePreferencesAction |  |
| mfa-actions.ts | beginEnrolmentAction, confirmEnrolmentAction, regenerateCodesAction, disableMfaAction, setMfaRequiredAction |  |
| MfaPanels.tsx | ConfirmPanel, RegeneratePanel, DisablePanel |  |
| page.tsx | AccountPage |  |
| **app/api/auth/** | | |
| redirect.ts | relativeRedirect |  |
| session-cookie.ts | setSessionCookie |  |
| **app/api/auth/mfa/** | | |
| route.ts | POST |  |
| **app/api/auth/signin/** | | |
| route.ts | POST |  |
| **app/api/auth/signout/** | | |
| route.ts | POST |  |
| **app/api/health/live/** | | |
| route.ts | GET |  |
| **app/clients/** | | |
| actions.ts | createTenantAction |  |
| page.tsx | TenantsPage |  |
| **app/clients/new/** | | |
| page.tsx | CreateTenantPage |  |
| TenantForm.tsx | TenantForm |  |
| **app/config/** | | |
| actions.ts | recheckConfigurationStatusAction |  |
| page.tsx | WorkbenchPage |  |
| WorkbenchTree.tsx | WorkbenchTree |  |
| **app/dev/kit/** | | |
| page.tsx | KitPage |  |
| **app/forgot-password/** | | |
| page.tsx | ForgotPasswordPage |  |
| **app/menu/** | | |
| page.tsx | ModulePage |  |
| **app/registry/** | | |
| actions.ts | suggestRegistryTerms |  |
| page.tsx | RegistryPage |  |
| RegistrySearch.tsx | RegistrySearch |  |
| screen-terms.ts | screenTerms, resolveScreen |  |
| **app/reset-password/** | | |
| page.tsx | ResetPasswordPage |  |
| ResetPasswordForm.tsx | ResetPasswordForm |  |
| **app/search/** | | |
| page.tsx | SearchPage |  |
| **app/signin/** | | |
| page.tsx | SignInPage |  |
| **app/signin/mfa/** | | |
| page.tsx | MfaChallengePage |  |
| **dev/** | | |
| walkthrough-asset.ts | runWalkthroughAssetProcurement | account_determination, asset_transaction, fixed_asset, journal_entry_line, material_document_line, outgoing_payment, purchase_order, purchase_order_item, supplier_invoice |
| walkthrough-volume.ts | runWalkthroughVolume | purchase_order, purchase_order_item, stock_quantity |
| **platform/** | | |
| schema.ts | *./tables, *../modules/audit/schema, *../modules/finance/schema, *../modules/foundation/schema, *../modules/foundation/output-schema, *../modules/inventory/schema, *../modules/people/schema, *../modules/production/schema, *../modules/quality/schema, *../modules/sales/schema |  |
| **platform/attention/** | | |
| panel.ts | ATTENTION_VISIBLE, attentionFor, mayAct |  |
| sources.ts | ATTENTION_QUERY_LIMIT, ATTENTION_SOURCES | app_user, document_release, parked_journal_header, payment_run_company, purchase_contract, purchase_order, purchase_requisition_item, release_strategy_step, scheduling_agreement |
| types.ts |  |  |
| **platform/auth/** | | |
| authority.ts | LEVEL_OF_KEY, ORG_LEVELS, SCOPE_KEYS, KEY_OF_LEVEL, patternsOf, withinScope, withinRestrictions, grantMatches, canWith, effectiveGrants, loadRestrictions, canUser, canTx, patternMatches | auth_org_restriction, delegation, delegation_approval, delegation_scope, employee, position_assignment, position_capability, role, role_capability, user_capability, user_capability_scope, user_role |
| capability-policy.ts | CREDIT_CONTROL_AREA_CAPABILITY, PRODUCTION_GOODS_MOVEMENT_REPROCESS_CAPABILITY, PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY, PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY, PRODUCTION_ORDER_COST_DISPLAY_CAPABILITY, INTERNAL_ORDER_COST_DISPLAY_CAPABILITY, STOCK_AGEING_DISPLAY_CAPABILITY, EXPLICIT_GRANT_ONLY_CAPABILITIES |  |
| current.ts | getSession, requireSession, requireCapability, AuthzError, can |  |
| mfa-challenge.ts | MFA_CHALLENGE_TTL_MINUTES, MFA_MAX_ATTEMPTS, createChallenge, tenantRequiresMfa | client_settings, mfa_challenge |
| mfa.ts | MFA_SECTION, MFA_CHALLENGE_ROUTE, MFA_ADMIN_CAPABILITY, MFA_POLICY_CAPABILITY, MFA_REQUIRED_FLAG, RECOVERY_CODE_COUNT, MfaError, normaliseRecoveryCode, beginEnrolment, pendingEnrolment, confirmEnrolment, disableMfa, regenerateRecoveryCodes, mfaStatus, adminResetMfa, isMfaRequired, setMfaRequired, mfaEnrolmentOutstanding, challengeView, verifyChallenge, createChallenge | app_user, audit_access_log, client, client_settings, mfa_challenge, user_mfa, user_mfa_recovery_code |
| password.ts | hashPassword, verifyPassword, checkPasswordPolicy |  |
| pattern.ts | patternGrants, hasCapability, patternMatches |  |
| service-authority.ts | verifyServiceAuthorityInTx, scopeRefusal, refusePlantOutsideScopeInTx | app_user, auth_org_restriction, capability, job_run, plant, role, role_capability, user_role, user_session |
| session.ts | SESSION_COOKIE, SESSION_TTL_MINUTES, MAX_FAILED_ATTEMPTS, AuthError, encodeSessionCookie, parseSessionCookie, attemptSignIn, signIn, createSession, logonLanguageKeyFromPreferences, resolveSession, revokeSession, revokeAllSessions, revokeSessionById, loadCapabilities, loadOrgRestrictions, hasOrgAccess, tokenHashFor, constantTimeEquals, hasCapability, patternGrants, patternMatches | app_user, audit_access_log, auth_org_restriction, enqueue_entry, user_mfa, user_session |
| totp.ts | TOTP_PERIOD_SECONDS, TOTP_DIGITS, TOTP_SKEW_STEPS, TOTP_SECRET_BYTES, base32Encode, base32Decode, generateSecret, stepAt, totpForStep, acceptTotp, otpauthUri |  |
| **platform/change/** | | |
| index.ts | recordChange, changeHistory | change_document, change_document_item |
| partner-data-history.ts | PARTNER_BANK_OBJECT_CLASS, PARTNER_CONTACT_OBJECT_CLASS, MASKED_HISTORY_VALUE, isPartnerSensitiveHistoryClass, isPartnerHistoryMaskedField, projectPartnerHistorySnapshot, projectPartnerHistoryStoredValue |  |
| **platform/db/** | | |
| client.ts | sql, db, directSql, assertApplicationRole, withTenant, withTenantAs, closeDb |  |
| migrate.ts | runMigrations |  |
| target-guard.ts | registerProtected, isProtected, validateTarget |  |
| **platform/document/** | | |
| index.ts | linkDocuments, recordStatusChange, indexDocument, documentFlow | document_flow_link, document_index, document_status_history |
| **platform/i18n/** | | |
| index.ts | LOCALES, DEFAULT_LOCALE, LOCALE_DIRECTION, t | Currency, currency |
| **platform/job/** | | |
| actor.ts | JobActorError, loadJobActor, assertActorCan | app_user |
| cron.ts | parseCron, cronMatches, nextDueAfter |  |
| execute.ts | claimNext, runClaimed | app_user, enqueue_entry, job_definition, job_run, user_session |
| index.ts | enqueue, requestCancel, retryRun, logLine, reapOrphans, purgeFinished, ensureDefinition, claimNext, runClaimed, registerJob, handlerFor, registeredJobs, clearJobRegistry, ENQUEUE_THRESHOLD_MS, DEFAULT_CHUNK_SIZE, DEFAULT_GRACE_SECONDS, DEFAULT_RETENTION_DAYS, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, BACKOFF_BASE_MS, BACKOFF_CAP_MS, LOCK_RETRY_DELAY_MS, POLL_INTERVAL_MS, JobBlockedError, backoffMs, shouldEnqueue |  |
| monitor.ts | isTerminal, listRuns, listLogs, reapFor | job_definition, job_log, job_run |
| queue.ts | enqueue, requestCancel, retryRun, logLine, reapOrphans, purgeFinished, ensureDefinition | job_definition, job_log, job_run |
| queues.ts | REGULAR_QUEUES, INTENSIVE_QUEUES, INTENSIVE_QUEUE |  |
| registry.ts | registerJob, handlerFor, registeredJobs, clearJobRegistry |  |
| scheduler.ts | tickScheduler | job_definition, job_run |
| types.ts | ENQUEUE_THRESHOLD_MS, DEFAULT_CHUNK_SIZE, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, BACKOFF_BASE_MS, BACKOFF_CAP_MS, LOCK_RETRY_DELAY_MS, DEFAULT_GRACE_SECONDS, DEFAULT_RETENTION_DAYS, POLL_INTERVAL_MS, JobBlockedError, backoffMs, shouldEnqueue, LeaseLostError |  |
| **platform/lock/** | | |
| enqueue.ts | ENQUEUE_STALE_MS, EnqueueError, openForChange, heartbeatChangeLock, releaseChangeLock, assertChangeLock, listEnqueue, deleteEnqueueEntry, openChangeForSession, assertChangeForSession, displayOnlyMessage | enqueue_entry, user_session |
| index.ts | acquireLock, acquireLocks, currentLocks, LockTimeoutError | lock_wait_log |
| **platform/mail/** | | |
| service.ts | MAIL_DEFINE_CAPABILITY, MAIL_OBJECT_CLASS, MailError, isValidMailAddress, retryDelaySeconds, getMailConfig, saveMailConfig, testMailConnection, sendTestMail, flushMailQueue, deleteMailMessage, clearUnsentMail, enqueueMail, sendOneMail, listMailQueue | mail_message, mail_server_config |
| transport.ts | MailTransportError, deliverMail, probeConnection |  |
| **platform/mail/jobs/** | | |
| send.ts | MAIL_SEND_JOB, mailSendJob | mail_message |
| **platform/notification/** | | |
| creator.ts | recipientFor, creatorOf | app_user, change_document |
| notify.ts | notifyOn, notifyAll, markSeen, markAllSeen, listInbox, unreadCount, getNotification | notification |
| recipients.ts | resolveRecipients | delegation, employee, position_assignment, position_capability, role, role_capability, user_capability, user_role |
| routing.ts | NOTIFICATION_ROUTES, routeForNotification |  |
| types.ts |  |  |
| **platform/notification/jobs/** | | |
| fanout.ts | FANOUT_JOB, fanoutJob |  |
| **platform/numbering/** | | |
| format.ts | formatNumber |  |
| index.ts | NumberRangeError, allocateNumber, rangeStatus, defineRange, formatNumber | number_range, number_range_allocation |
| **platform/periods/** | | |
| index.ts | ACCOUNT_TYPE_LABELS, PeriodError, derivePosition, periodDates, checkPostingAllowed, periodStatus, getVariant, getCompanyCode, getPostingPeriodVariant, buildPeriodRows, periodWindows | company_code, fiscal_year_period, fiscal_year_variant, posting_period_rule, posting_period_variant |
| windows.ts | periodWindows |  |
| **platform/posting/** | | |
| decimal.ts | MONEY_SCALE, toScaled, fromScaled, sumScaled, equalsScaled, multiplyScaled, DecimalError |  |
| index.ts | JOURNAL_DOCUMENT_CLASS, postJournalEntry, reverseJournalEntry, computeTotals, PostingError | document_type, gl_account, journal_entry, journal_entry_line, number_range_allocation |
| **platform/registry/** | | |
| index.ts | resolveTerm, searchRegistry, suggestRegistry, aliasesFor, coverageLabel | term_alias, term_registry |
| suggest.ts | compactCode, suggestionWords, equallyNear, exactOwnIdentifier, rankSuggestions, rankRegistry |  |
| **platform/security/** | | |
| bank-data-encryption.ts | isBankDataKeyId, BankDataEncryptionError, encryptBankData, decryptBankData, reencryptBankData, reencryptBankDataBatch, verifyBankDataBatchOnActiveKey |  |
| bank-data-keyring.ts | BANK_DATA_KEYRING_ENV, BankDataKeyringConfigError, loadBankDataKeyring, parseBankDataKeyring |  |
| bank-data-reveal.ts | PARTNER_DISPLAY_CAPABILITY, PARTNER_BANK_REVEAL_CAPABILITY, BANK_REVEAL_FIELDS, BANK_REVEAL_PURPOSES, authorizeAndRecordBankRevealAttempt, recordBankRevealOutcome | audit_access_log |
| bank-profile-gb.ts | GB_IBAN_PATTERN, validateGreatBritainBankProfile |  |
| bank-profile-in.ts | INDIA_IFSC_PATTERN, validateIndiaBankProfile |  |
| bank-profile-jp.ts | validateJapanBankProfile |  |
| bank-profile-kw.ts | KUWAIT_IBAN_PATTERN, validateKuwaitBankProfile |  |
| bank-profile-us.ts | validateUnitedStatesBankProfile |  |
| bank-record-id.ts | generateBankRecordId, isBankRecordId |  |
| partner-bank-profile-activation.ts | PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY, PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE, validatePartnerBankProfileActivationCommand |  |
| partner-bank-profile-readiness.ts | PARTNER_BANK_PROFILE_POLICIES, PARTNER_BANK_PROFILE_AUTHORING_COUNTRIES, resolvePartnerBankProfileReadiness |  |
| partner-bank-profile.ts | validatePartnerBankProfile |  |
| partner-bank-view.ts | BANK_ACCOUNT_VIEW_MASK, projectPartnerBankNormalView |  |
| **platform/tables/** | | |
| audit-trail.ts | changeDocument, changeDocumentItem, documentFlowLink, documentStatusHistory, documentIndex | change_document, change_document_item, document_flow_link, document_index, document_status_history |
| index.ts | *./tenancy, *./security, *./numbering, *./lock, *./audit-trail, *./registry, *./system, *./reference |  |
| lock.ts | lockObject, lockWaitLog, enqueueEntry | enqueue_entry, lock_object, lock_wait_log |
| numbering.ts | numberRangeObject, numberRange, numberRangeAllocation | number_range, number_range_allocation, number_range_object |
| reference.ts | country, currency, unitOfMeasure, bankMaster | bank_master, country, currency, unit_of_measure |
| registry.ts | termRegistry, termAlias, configActivity, configActivityStatus | config_activity, config_activity_status, term_alias, term_registry |
| security.ts | appUser, role, capability, roleCapability, userRole, authOrgRestriction, positionCapability, userCapability, userCapabilityScope, userSession, auditAccessLog, sodRule, passwordResetToken, userMfa, userMfaRecoveryCode, mfaChallenge | app_user, audit_access_log, auth_org_restriction, capability, mfa_challenge, password_reset_token, position_capability, role, role_capability, sod_rule, user_capability, user_capability_scope, user_mfa, user_mfa_recovery_code, user_role, user_session |
| system.ts | messageCatalog, jobDefinition, jobRun, jobLog, notification, mailServerConfig, mailMessage | job_definition, job_log, job_run, mail_message, mail_server_config, message_catalog, notification |
| tenancy.ts | auditColumns, client, clientSettings | client, client_settings |
| **platform/tenancy/** | | |
| config-activity-status.ts | recomputeActivityStatus | account_determination, activity_rate, activity_type, app_user, batch_number_assignment, batch_status_management, characteristic, chart_of_accounts, classification_class, company_code, config_activity, config_activity_status, cost_center, cost_center_hierarchy, credit_control_area, distribution_channel, division, document_type, employee_tolerance_group, exchange_rate, fiscal_year_variant, gl_account, house_bank, industry, industry_sector, material_bom, material_group, material_period_control, material_type, movement_type, number_range, pay_component, payment_method, payment_terms, plant, posting_period_variant, production_order_type, production_order_type_parameter, production_version, profit_center, profit_center_hierarchy, purchasing_group, purchasing_org, record_type, release_strategy, role, routing, sales_area, sales_condition_record, sales_org, settlement_profile, storage_location, tax_code, valuation_class, work_center |
| demo-activity-price.ts | buildDemoActivityPrice | activity_type |
| demo-assessment.ts | buildDemoAssessment | account_determination, company_code, gl_account |
| demo-audit.ts | DEMO_AUDIT_GRANT_REQUEST_KEY, demoAuditPrerequisitesMissing, buildDemoAudit | app_user, role_capability |
| demo-bom-structure.ts | buildDemoBomStructure |  |
| demo-co-plan.ts | buildDemoCoPlan | company_code, controlling_area_company, journal_entry, journal_entry_line |
| demo-cost-estimate.ts | buildDemoCostEstimate | material_valuation, routing_control_key, routing_operation, work_center_costing |
| demo-credentials.ts | DEMO_CREDENTIALS_FILENAME, DEFAULT_CREDENTIALS_DIR, generateDemoPassword, fingerprintDemoPassword, renderDemoCredentialReport, writeDemoCredentials, readDemoCredentials, dirname |  |
| demo-finance.ts | buildDemoFinance | tax_return_run |
| demo-masters.ts | STANDARD_TAX_CODE, materialUnit, PURCHASE_PRICES, buildDemoMasters | credit_risk_category |
| demo-organisation.ts | DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE, DEMO_FOUNDER_ACCOUNTS, buildDemoOrganisation, demoClientKey | purchasing_org_plant |
| demo-payroll-offcycle.ts | buildDemoPayrollOffCycle | company_code, payroll_run_exception |
| demo-payroll-pay.ts | buildDemoPayrollPay | bank_master |
| demo-payroll-post.ts | buildDemoPayrollPost | app_user, auth_org_restriction, company_code |
| demo-payroll-run.ts | ensureEmployee, buildDemoPayrollRun | company_code, employee |
| demo-payroll.ts | DEMO_PAYROLL_UNASSIGNED, buildDemoPayroll | pay_component, pay_component_config, time_type |
| demo-people.ts | buildDemoPeople, listDemoAccounts, withActingUser, setEveryPassword | app_user, capability, role, user_role |
| demo-procurement.ts | buildDemoProcurement |  |
| demo-production.ts | buildDemoProduction | account_determination, production_order, production_order_type, production_order_type_parameter |
| demo-provisioning.ts | DEMO_PROVISION_OPERATION, DEMO_ADVISORY_LOCK_KEY, DEMO_CLAIM_LOCK_KEY, DEMO_PHASE_PLAN, isDemoProvisioningEnabled, censusDemoEligibility, claimDemoInstallation, startDemoPhase, completeDemoPhase, completeDemoPhases, failDemoPhase, completeDemoInstallation, buildDemoTimeline, acquireDemoProvisioningLock, readDemoPasswordState, recordDemoPasswordIssued, readDemoInstallation |  |
| demo-quality.ts | buildDemoQuality |  |
| demo-release.ts | ensureDemoRelease, buildDemoRelease | characteristic, classification_class, company_code, document_release, payment_method, payment_run, purchase_contract, purchase_order, purchase_requisition_item, release_group, release_strategy, scheduling_agreement |
| demo-sales-availability.ts | buildDemoSalesAvailability | availability_check_scope, availability_checking_group, availability_checking_rule, delivery, delivery_line, material_plant, sales_order |
| demo-sales-quotation.ts | buildDemoSalesQuotation | sales_condition_record |
| demo-sales.ts | buildDemoSales | account_determination, billing_document, customer_invoice, delivery |
| index.ts | TenancyError, createTenant, listTenants, configReadiness, getTenant, markActivityComplete | app_user, client, client_settings, config_activity, config_activity_status, internal_order_budget_profile, internal_order_type, internal_order_type_budget_profile, number_range_object, purchasing_contract_type, role, role_capability, scheduling_agreement_type, user_role |
| provisioning.ts | ProvisioningError, assertProvisioningToken, authorizeProvisioning |  |
| standard-structure.ts | STANDARD_STRUCTURE, STRUCTURE_ACTIVITIES, applyStandardStructure, applyStandardStructureInTransaction | company_code, controlling_area, credit_control_area, plant, purchasing_org, purchasing_org_plant, sales_area, sales_org, sales_org_distribution_channel, sales_org_division, sales_org_text, storage_location |
| walkthrough-install-guard.ts | WALKTHROUGH_INSTALL_OPERATION, WALKTHROUGH_INSTALL_OBJECT_CLASS, WALKTHROUGH_INSTALL_REASON, assertFreshWalkthroughTenantInventory, assertFreshWalkthroughFirstAdmin, assertWalkthroughScopeSet, assertWalkthroughCheckpointRequest, assertWalkthroughCheckpointActor, assertWalkthroughDatabaseTarget, assertWalkthroughSeedRuntime |  |
| walkthrough-provisioning.ts | assertFreshWalkthroughTenant | app_user, auth_org_restriction, client, user_role |
| **ui/attention/** | | |
| AttentionPanel.tsx | AttentionPanel |  |
| **ui/fields/** | | |
| ConstrainedField.tsx | ConstrainedField |  |
| SearchIcon.tsx | SearchIcon |  |
| **ui/kit/** | | |
| Button.tsx | buttonVariants, Button, LinkButton |  |
| Card.tsx | Card |  |
| Chip.tsx | Chip |  |
| cn.ts | cn |  |
| Dialog.tsx | Dialog |  |
| Field.tsx | Field, FormGrid, ActionRow |  |
| index.ts | cn, Button, LinkButton, buttonVariants, Chip, Notice, Card, Page, Field, FormGrid, ActionRow, Table, Th, Td, EmptyRow, KeyValue, *./Dialog |  |
| KeyValue.tsx | KeyValue |  |
| Notice.tsx | Notice |  |
| Page.tsx | Page |  |
| Table.tsx | Table, Th, Td, EmptyRow |  |
| **ui/lock/** | | |
| ChangeLock.tsx | ChangeLock, useChangeLockClaim, useChangeLock, LockNotice, ClaimFailureNotice |  |
| claim-lifecycle.ts | observeChangeLockClaim |  |
| claim.ts | IDLE_CLAIM, claimKey, phaseOf, shouldDispatch, awaitingClaim, projectClaim, claimNotice, failureDetail, failureText, failureNoticeView, changeLockClaim |  |
| remedy.ts | displayOnlyRemedy |  |
| **ui/output/** | | |
| DocumentPrint.tsx | DocumentLetterhead, DocumentFooter, PrintButton, PrintNote, DownloadPdfButton |  |
| ReportExport.tsx | ReportExport |  |
| **ui/release/** | | |
| ReleasePanel.tsx | ReleasePanel |  |
| **ui/shell/** | | |
| CommandBar.tsx | CommandBar |  |
| CommandBarLinks.tsx | CommandBarLinks |  |
| launchpad.ts | launchpadFor |  |
| menu-access.ts | menuScreenIds |  |
| menu-path.ts | resolveMenuPath |  |
| MenuPath.tsx | MenuPath |  |
| nav-personal.ts | MAX_FAVOURITES, MAX_RECENTS, EMPTY_PERSONAL, storageKey, parsePersonal, serializePersonal, recordRecent, toggleFavourite, resolveEntries |  |
| nav-search.ts | searchNav |  |
| nav-tree.ts | categorySlug, moduleHref, buildNavTree |  |
| navigation-click.ts | isNavigationClick |  |
| NavSidebar.tsx | NavSidebar |  |
| NotificationBell.tsx | NotificationBell |  |
| PersonalMenu.tsx | PersonalMenu |  |
| RelatedScreens.tsx | RelatedScreens |  |
| RelatedScreensAccess.tsx | RelatedScreensAccess |  |
| screen-access.ts | namesReading, visibleScreenIds |  |
| screen-catalog.ts | NAV_CHILD_ROUTES, NAV_MODULES, SCREENS, SCREEN_AREAS |  |
| screen-links.ts | ALSO, screenHref, matchScreen, screensInArea, relatedLinks |  |
| ScrollToTop.tsx | ScrollToTop |  |
| SessionBar.tsx | SessionBar |  |
| SessionMenu.tsx | SessionMenu |  |
| SidebarMenu.tsx | SidebarMenu |  |
| Spinner.tsx | Spinner |  |
| StatusBar.tsx | StatusBar |  |
| SubmitButton.tsx | SubmitButton |  |
| WorkIndicator.tsx | WorkIndicator |  |
| **worker/** | | |
| config.ts | WorkerConfigError, resolveWorkerConfig |  |
| index.ts | runWorker, stopWorker, main |  |
| jobs.ts |  |  |

## Routes (17)
`/` · `/account` · `/api/auth/mfa` · `/api/auth/signin` · `/api/auth/signout` · `/api/health/live` · `/clients` · `/clients/new` · `/config` · `/dev/kit` · `/forgot-password` · `/menu` · `/registry` · `/reset-password` · `/search` · `/signin` · `/signin/mfa`

## Tables owned (44)
app_user, audit_access_log, auth_org_restriction, bank_master, capability, change_document, change_document_item, client, client_settings, config_activity, config_activity_status, country, currency, document_flow_link, document_index, document_status_history, enqueue_entry, job_definition, job_log, job_run, lock_object, lock_wait_log, mail_message, mail_server_config, message_catalog, mfa_challenge, notification, number_range, number_range_allocation, number_range_object, password_reset_token, position_capability, role, role_capability, sod_rule, term_alias, term_registry, unit_of_measure, user_capability, user_capability_scope, user_mfa, user_mfa_recovery_code, user_role, user_session

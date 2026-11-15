# Shared / Cross-cutting

Infra not owned by any business module; every module depends on some of this.

## Files

**Auth — `src/platform/auth/`**: `session.ts` (cookie encode/parse, login tracking; exports `SESSION_COOKIE`, `SESSION_TTL_MINUTES`, `MAX_FAILED_ATTEMPTS`, `encodeSessionCookie`, `parseSessionCookie`, `AuthenticatedUser`, `AuthOutcome`, `AuthError`, `revokeSessionById`; re-exports `hasCapability`,`patternGrants`,`patternMatches` from `pattern.ts`) · `current.ts` (`getSession`, `requireSession`, `requireCapability`, `AuthzError`, `can`) · `password.ts` (`hashPassword`, `verifyPassword`, `checkPasswordPolicy`) · `capability-policy.ts` (capability constants e.g. `CFG.FIN.CCA.MAINTAIN`; explicit-grant-only set) · `pattern.ts` (capability wildcard matching: `patternGrants`,`hasCapability`,`patternMatches`) · `authority.ts` (unified "may X do capability C at org O on date D": unions role→`role_capability`, position→`position_capability`, direct→`user_capability`(+`user_capability_scope`), read live, never copied; `LEVEL_OF_KEY`,`ORG_LEVELS`,`SCOPE_KEYS`,`ScopeKey`,`OrgScope`,`AuthorityGrant`,`effectiveGrants`,`loadRestrictions`,`withinScope`,`grantMatches`,`canWith`,`canUser`,`canTx`; under a live audit grant `effectiveGrants` returns only read-kind grants via `modules/audit/read-only.ts`) · `service-authority.ts` (refuses a non-read capability by name while the actor holds a live audit grant; in-tx "who is acting / holds authority / plant in reach" verdict for production/sales/inventory posting services, fails closed on missing CC/plant grant: `verifyServiceAuthorityInTx`,`scopeRefusal`,`refusePlantOutsideScopeInTx`,`ServiceAuthorityVerdict`)

**DB client — `src/platform/db/`**: `client.ts` (`Db`, `Tx`, `db()`, `withTenant()`, `withTenantAs()` (also `SET LOCAL cairn.user`), `assertApplicationRole()`, `closeDb()`) · `migrate.ts` (`runMigrations`, `db:migrate` entry) · `target-guard.ts` (`registerProtected`, `isProtected`, `validateTarget`)

**Platform tables (Drizzle) — `src/platform/tables/`**: `tenancy.ts`→`client`,`clientSettings` · `security.ts`→`appUser`,`role`,`capability`,`roleCapability`,`userRole`,`authOrgRestriction`,`positionCapability`,`userCapability`,`userCapabilityScope`,`userSession`,`auditAccessLog`,`sodRule`,`passwordResetToken` · `numbering.ts`→`numberRangeObject`,`numberRange`,`numberRangeAllocation` · `lock.ts`→`lockObject`,`lockWaitLog`,`enqueueEntry` · `audit-trail.ts`→`changeDocument`,`changeDocumentItem`,`documentFlowLink`,`documentStatusHistory`,`documentIndex` · `registry.ts`→`termRegistry`,`termAlias`,`configActivity`,`configActivityStatus` · `system.ts`→`messageCatalog`,`jobDefinition`,`jobRun` (now with idempotency key, cursor/chunks, heartbeat, blocked/dead-letter cols; `BlockedOn`),`jobLog`,`notification`,`mailServerConfig` · `reference.ts`→`country`,`currency`,`unitOfMeasure`,`bankMaster` · `index.ts` re-exports all. `src/platform/schema.ts` — the aggregate schema `drizzle.config.ts` points at; re-exports platform/tables + every module's schema.ts (now incl. `modules/foundation/output-schema`). `demo_installation`/`demo_installation_phase` exist only in raw SQL (`drizzle/9273_*`, `9274_*`), not in Drizzle.

**Tenancy — `src/platform/tenancy/`**: `index.ts` (`createTenant` — now also creates a separate tenant administrator (`tenantAdministrator` input) and runs `recomputeActivityStatus`; `listTenants`, `TenancyError`, `ConfigReadiness`) · `provisioning.ts` (owner-token check only; session gate + `PROVISION_CAPABILITY` removed) · `config-activity-status.ts` (`recomputeActivityStatus` — marks config-workbench steps complete from evidence in the tenant, one-way) · `standard-structure.ts` (`STANDARD_STRUCTURE`, `applyStandardStructure`) · `walkthrough-install-guard.ts`/`walkthrough-provisioning.ts` (fresh-tenant-only guards for demo seed) · **demo installation**: `demo-provisioning.ts` (eligibility census by row count, advisory-locked claim, global phase ledger in `demo_installation*`; `isDemoProvisioningEnabled`,`claimDemoInstallation`,`start/complete/failDemoPhase`,`DEMO_PHASE_PLAN` (10 phases, `D6_AUDIT` last),`buildDemoTimeline`,`acquireDemoProvisioningLock`; a COMPLETED record missing a later-added phase is RESUMEd with it appended) · `demo-organisation.ts` (`DEMO_ACTOR`,`DEMO_IDENTITY`,`DEMO_STRUCTURE`,`buildDemoOrganisation`) · `demo-people.ts` (`buildDemoPeople`,`listDemoAccounts`,`withActingUser`,`setEveryPassword`) · `demo-masters.ts` (`buildDemoMasters`,`STANDARD_TAX_CODE`,`PURCHASE_PRICES`) · `demo-procurement.ts`,`demo-production.ts`,`demo-sales.ts`,`demo-quality.ts`,`demo-finance.ts`,`demo-audit.ts` (`buildDemo<Area>` phase builders; `demo-audit.ts` = phase `D6_AUDIT`: grant to `demo.auditor`, findings, one answer; `demoAuditPrerequisitesMissing`) · `demo-credentials.ts` (generate/fingerprint/write `demo-credentials.txt` to `/app/credentials`)

**Locking — `src/platform/lock/` + `src/ui/lock/`**: `lock/index.ts` (`acquireLock`,`acquireLocks`,`currentLocks`,`LockTimeoutError`) · `lock/enqueue.ts` (`openForChange`,`heartbeatChangeLock`,`releaseChangeLock`,`EnqueueError`; lock view now carries `ownerSessionId`) · `ui/lock/ChangeLock.tsx` (`useChangeLockClaim`,`useChangeLock`) · `ui/lock/claim.ts`,`claim-lifecycle.ts`,`remedy.ts` (claim state machine, display-only messaging)

**Job runtime — `src/platform/job/`**: `index.ts` (barrel; queue half for requests, execute half for the worker only) · `queue.ts` (in caller's tx: `enqueue`,`requestCancel`,`retryRun`,`logLine`,`reapOrphans`,`purgeFinished`,`ensureDefinition`) · `execute.ts` (worker-only: `claimNext` via SECURITY DEFINER `job_claim_next`, `runClaimed` chunked run w/ heartbeat, lock blocking, backoff) · `registry.ts` (`registerJob`,`handlerFor`,`registeredJobs`,`clearJobRegistry`) · `scheduler.ts` (`tickScheduler` — enqueues due `job_definition.schedule` per tenant via `job_all_clients`, idempotency-keyed) · `cron.ts` (`parseCron`,`cronMatches`,`nextDueAfter`) · `monitor.ts` (`listRuns`,`listLogs`,`reapFor`,`isTerminal` — `/platform/jobs` screen) · `types.ts` (`JobHandler`,`JobContext`,`JobStatus`,`JobBlockedError`,`backoffMs`,`shouldEnqueue`, timing constants `HEARTBEAT_MS`,`POLL_INTERVAL_MS`…)

**Worker — `src/worker/`** (new top-level process, `npm run worker` = `tsx src/worker/index.ts`): `index.ts` (`runWorker`,`stopWorker`,`main`; poll/claim/run loop, SIGTERM-graceful; env `CAIRN_WORKER_ID`,`CAIRN_WORKER_POLL_MS`,`CAIRN_WORKER_QUEUES`) · `jobs.ts` (side-effect imports registering every handler: `people/jobs/grant-expiring`, `notification/jobs/fanout`)

**Notifications — `src/platform/notification/` + shell**: `notify.ts` (in caller's tx: `notifyOn`,`notifyAll`; inbox `listInbox`,`unreadCount`,`markSeen`,`markAllSeen`,`getNotification`) · `recipients.ts` (`resolveRecipients` from authority, never caller-supplied) · `creator.ts` (`recipientFor`,`creatorOf`) · `routing.ts` (`NOTIFICATION_ROUTES`,`routeForNotification` → screen link) · `types.ts` (`NotificationKind`,`NotificationObjectClass`,`NotifyInput`,`NotificationRow/View`) · `jobs/fanout.ts` (`FANOUT_JOB='NOTIFY.FANOUT'`,`fanoutJob`) · `ui/shell/NotificationBell.tsx` (unread count in SessionBar)

**Attention — `src/platform/attention/` + `src/ui/attention/`**: `panel.ts` (`attentionFor` — per-user "waiting on you" groups, skips sources the user can't act on, org-narrowed, oldest first; `mayAct`,`ATTENTION_VISIBLE`) · `sources.ts` (`ATTENTION_SOURCES` per-module queries, `ATTENTION_QUERY_LIMIT`) · `types.ts` (`AttentionRow`,`AttentionSource`,`AttentionGroup`) · `ui/attention/AttentionPanel.tsx` (`AttentionPanel`, rendered on home `/`)

**Numbering — `src/platform/numbering/`**: `index.ts` (`allocateNumber`,`defineRange`,`rangeStatus`,`NumberRangeError`) · `format.ts` (`formatNumber`)

**Posting — `src/platform/posting/`**: `index.ts` (`postJournalEntry`,`reverseJournalEntry`,`computeTotals`,`PostingError`) · `decimal.ts` (scaled-bigint money math, `MONEY_SCALE=4`: `toScaled`,`fromScaled`,`sumScaled`,`equalsScaled`,`multiplyScaled`)

**Periods — `src/platform/periods/`**: `index.ts` (`derivePosition`,`checkPostingAllowed`,`periodStatus`,`PeriodError`) · `windows.ts` (`periodWindows`)

**Change/audit — `src/platform/change/`**: `index.ts` (`recordChange`,`changeHistory`) · `partner-data-history.ts` (masks sensitive fields; `isPartnerSensitiveHistoryClass`,`isPartnerHistoryMaskedField`,`projectPartnerHistorySnapshot`)

**Document flow — `src/platform/document/index.ts`**: `linkDocuments`,`recordStatusChange`,`indexDocument`,`documentFlow`. Used only by inventory (GR, return delivery) + purchasing (invoice verification) to chain PO→GR→invoice.

**i18n — `src/platform/i18n/index.ts`**: 5,025 lines; `LOCALES`,`DEFAULT_LOCALE`,`t()`. `LOCALES=['en']` only.

**Registry — `src/platform/registry/` + `src/app/registry/`**: `registry/index.ts` (`resolveTerm`,`searchRegistry`,`suggestRegistry`,`aliasesFor`,`coverageLabel`) · `registry/suggest.ts` (ranking internals) · `app/registry/{page.tsx,actions.ts,RegistrySearch.tsx,screen-terms.ts}` (`/registry` page)

**Security — `src/platform/security/`**: `bank-data-encryption.ts`,`bank-data-keyring.ts`,`bank-data-reveal.ts`,`bank-record-id.ts` (IBAN/account encrypt/decrypt/reveal, keyring from `CAIRN_BANK_DATA_KEYRING_JSON`) · `bank-profile-{gb,in,jp,kw,us}.ts` (per-country format validators) · `partner-bank-profile.ts`,`partner-bank-profile-activation.ts`,`partner-bank-profile-readiness.ts`,`partner-bank-view.ts` (mechanism under foundation's partner-bank master data; foundation owns the data, this owns country-validation/encryption).

**UI shell — `src/ui/shell/`**: `screen-catalog.ts` (`SCREENS`,`ScreenArea`,`SCREEN_AREAS` — splits `foundation` into `foundation`/`controlling`/`configuration` areas though all live under `modules/foundation`; adds `/platform/jobs`, `/platform/notifications`, `/people/authority`, area `audit` (`/audit/workspace|grants|findings`), many sales/config screens) · `screen-links.ts` (`screenHref`,`matchScreen`,`screensInArea`,`relatedLinks`,`ALSO`) · `screen-access.ts` (`visibleScreenIds`) · `CommandBar.tsx`,`RelatedScreens.tsx`,`RelatedScreensAccess.tsx`,`SessionBar.tsx` (now hosts `NotificationBell` + `SessionMenu`),`SessionMenu.tsx`(`SessionMenu` dropdown),`NotificationBell.tsx`,`StatusBar.tsx`,`WorkIndicator.tsx`,`SubmitButton.tsx`,`Spinner.tsx`,`ScrollToTop.tsx`,`navigation-click.ts` (chrome)

**UI fields — `src/ui/fields/`**: `ConstrainedField.tsx` (bound to foundation's constrained-value lists) · `SearchIcon.tsx`

**App root — `src/app/`**: `layout.tsx`,`page.tsx` (home; renders `AttentionPanel`),`globals.css`,`command.ts`(`executeCommand`)

**Auth/health API — `src/app/api/`**: `auth/signin/route.ts`,`auth/signout/route.ts`,`auth/redirect.ts`(`relativeRedirect`),`health/live/route.ts`

**Tenant onboarding — `src/app/clients/`**: `page.tsx`,`new/page.tsx`,`new/TenantForm.tsx` (now also collects the tenant administrator),`actions.ts`(`createTenantAction`,`OnboardState`)

**Auth screens — `src/app/{signin,forgot-password,reset-password}/`**: sign-in/forgot/reset pages+form

**Config shell — `src/app/config/{page.tsx,WorkbenchTree.tsx,actions.ts}`**: nav tree for all `/config/*` (`WorkbenchActivity`,`WorkbenchTree`) · `actions.ts` (`recheckConfigurationStatusAction` → `recomputeActivityStatus`; "recheck" button on `/config`)

**Dev helpers — `src/dev/`**: `walkthrough-asset.ts`(`runWalkthroughAssetProcurement`) · `walkthrough-volume.ts`(`runWalkthroughVolume`) — used by root `walkthrough-seed.ts`

## Used by (module → shared piece)
| Piece | Used by |
|---|---|
| `platform/auth` | all 9 modules + api/clients/config |
| `platform/db` | finance,foundation,inventory,people,platform,production,purchasing,quality,sales,api |
| `platform/tenancy` | clients,config,finance,foundation,inventory,platform,production,purchasing |
| `platform/lock`+`ui/lock` | config,controlling,finance,foundation,inventory,platform,production,purchasing,quality |
| `platform/numbering` | config,finance,foundation,inventory,production,purchasing,quality,sales |
| `platform/posting` | finance,foundation,inventory,people,production,purchasing |
| `platform/periods` | config,finance,foundation,inventory,production,purchasing |
| `platform/change` | config,finance,foundation,inventory,people,platform,production,purchasing,quality,sales |
| `platform/document` | inventory, purchasing only |
| `platform/i18n` | all 9 modules |
| `platform/registry` | registry route, command bar only |
| `platform/security` | foundation only |
| `platform/tables` | all 9 modules |
| `platform/auth/authority`+`service-authority` | finance,foundation,inventory,people,production,purchasing,quality,sales + attention/notification |
| `platform/tenancy` demo-* | `scripts/demo-provision.ts`, `scripts/seed.ts` only |
| `platform/job` | finance,foundation,people,platform,production,purchasing, notification fanout, worker, seed |
| `platform/notification` | finance,foundation,people,platform,production,purchasing,sales, NotificationBell, worker |
| `platform/attention`+`ui/attention` | home page `/` only |
| `worker` | standalone process (`npm run worker`); not imported by the web app (imports platform/job, platform/db, and handlers via `jobs.ts`) |
| `ui/shell` | registry, root layout only |
| `ui/fields` | config,finance,inventory,purchasing,sales |

## Tests
**Auth/session/security:** `action-security`, `auth`, `bank-data-encryption`, `bank-data-keyring`, `bank-data-reveal`, `bank-profile-{gb,in,jp,kw,us}`, `bank-record-id`, `partner-bank-history`, `partner-bank-profile`, `partner-bank-view`, `default-privilege-audit`
**DB/migration/tenancy:** `db-client-target`, `db-credentials`, `db-target-guard`, `migration-grant-policy`, `integration-db-config`, `isolation`, `test-tenant-isolation`, `tenant-creation-service`, `tenant-provisioning`, `onboarding-admission`, `docker-provisioning-contract`, `test-db-provisioning-reference-contract`, `audit-access-log-append-only`
**Locking:** `dialog-enqueue`, `change-lock-claim`, `change-lock-claim-lifecycle`, `change-lock-configuration-browser-targets-contract`, `change-lock-ux-contract`, `lock-display-only-remedy-contract`, `session-change-lock`
**Numbering/posting/registry:** `numbering`, `posting`, `registry-suggest`
**UI shell contracts:** `screen-links`, `shell-navigation-contract`, `related-screens-access`, `work-indicator-contract`, `hidden-attribute-display-contract`, `dom-identifier-wiring`, `document-display-contract`, `scr144-screens-contract`, `browser-targets`, `server-action-exports`, `vocabulary-exception-boundary`
**Walkthrough/dev tooling:** `standard-reference-data`, `sync-db-app-role`, `walkthrough-provisioning-contract`, `walkthrough-role-capability-catalogue-contract`, `walkthrough-seed-contract`, `ip-lint-allowlist-contract`, `global-setup`, `helpers`, `health-live`
# NEW TESTS (development branch)
**Job/worker/notifications:** `job-runtime`, `job-monitor`, `job-notification`, `worker`, `notification`, `attention`
**Audit:** `audit-workspace` (helper `helpers/audit-actor.ts`)
**Demo installation/tenancy:** `demo-credentials`, `demo-organisation`, `demo-masters`, `demo-procurement`, `demo-production`, `demo-sales`, `demo-quality`, `demo-finance`, `demo-reconciliation`, `demo-safety-matrix`, `demo-provisioning-contract`, `config-activity-status`
**Python:** `backup_manifest_test.py`, `deployment_diagnostic_test.py`, `deployment_routing_test.py`
(all filenames above take `.test.ts` suffix unless otherwise shown)

**Test infrastructure:** `tests/test-env.ts` (`loadTestEnv`; side-effect import in every vitest config — loads `.env.test` over the container env, refuses any DB URL that isn't erp_test, forbids erp_dev)

## Scripts
`bootstrap.ts`, `create-dev-tenant.ts`, `reset-db.ts`, `seed-reference.ts`, `sync-db-app-role.ts`, `test-db.ts`, `test-integration.ts`, `integration-db-config.ts`, `check-registry.ts`, `lint-ip.ts`, `smoke-test.ts`, `standard-reference-data.ts`, `browser-smoke.ts`, `browser-smoke/targets.ts`, `browser-smoke/database-guards.ts`, `browser-smoke/scr144-close-the-gaps.ts`, `backup-integration-db.py`, `diagnose-docker-db.py`, `integration-cluster-identity.sql`
# NEW SCRIPTS
`demo-provision.ts` (installs the demo company into an empty DB via `tenancy/demo-*`), `demo-signin-check.ts`, `browser-smoke/actor.ts`, `with-test-env.ts` (runs a command with `tests/test-env.ts` loaded; used by `npm run test:db:migrate` / `test:db:seed`)

## Gotchas
- i18n is single-locale in practice (`LOCALES=['en']`) despite full multi-locale scaffolding.
- `platform/document` is a narrow 2-consumer utility (inventory GR/return-delivery, purchasing invoice-verification), not general infra.
- UI area taxonomy (`ScreenArea`) splits foundation into `foundation`/`controlling`/`configuration` though all code lives under `modules/foundation` — don't assume 1:1 with module split.
- `src/platform/schema.ts` is the sole Drizzle entrypoint — new tables must be re-exported there.
- Money math never floats — all currency goes through `platform/posting/decimal.ts` scaled-bigint arithmetic.
- Jobs: requests only `enqueue` (platform/job/queue) in their own tx; the `npm run worker` process claims runs through SECURITY DEFINER fns (`job_claim_next`, `job_orphan_clients`) because `cairn_app` can't see across tenants under FORCE RLS, then works via `withTenant`.
- A job handler only exists if `src/worker/jobs.ts` imports it (side-effect registration); missing import = every claimed run fails "no handler registered".
- `tickScheduler` (platform/job/scheduler.ts) has no caller in src/scripts — the worker loop doesn't invoke it, so `job_definition.schedule` jobs aren't auto-enqueued yet.
- Notifications are written in the business tx (rollback-safe); "notify whoever may act" goes via the `NOTIFY.FANOUT` job, which resolves recipients from authority in the worker. A notification is a pointer, never a permission.
- Demo installation refuses unless the DB holds no tenant (row-count census, advisory lock); progress ledger is global (`demo_installation*`), not tenant-scoped.

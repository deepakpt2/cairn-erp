# Audit
Auditor workspace: time-boxed scoped read-only grants, no-post rule, audited auditor, findings/requests. Routes: `/audit/{workspace,grants,findings}`. Paths relative to `src/`; tables are SQL names.

## Gotchas
- Period-close evidence pack (`period-evidence*.ts`, job `AUDIT.PERIOD.PACK`, table `audit_period_pack`): every request/status/download goes through `enforceAuditAccess` with company + `YYYYPP` + `FIN` all provided; the worker re-judges requester and the SAME grant (`grantStillCovers`) and holds the lease fence in one guard transaction while a second repeatable-read connection reads the snapshot. Job parameters carry only the pack id. Rules shown are CURRENT, never history; no CLOSE/REOPEN is inferred.
- Live audit grant strips every non-read capability centrally (admins too); close cockpit never opens for an auditor.
- Grant scope (company/period/module) is enforced only by audit's own reads (`assertAuditRead`, search, export); linked business screens are not scope-filtered (known gap).
- `effectiveGrants()` costs one extra query (`liveAuditGrantId`) per resolution.
- Demo phase `D6_AUDIT`; a COMPLETED install missing a later phase RESUMEs it and resets every demo password.

## Files (22)
| file | exports | tables |
|---|---|---|
| **app/api/audit/period-pack/[packId]/** | | |
| route.ts | GET |  |
| **app/audit/access-review/** | | |
| AccessReviewForm.tsx | CreateReviewForm, DecideForm, ApplyButton, CompleteButton, CancelButton |  |
| actions.ts | createAccessReviewAction, decideAccessReviewItemAction, applyAccessReviewRevocationsAction, completeAccessReviewAction, cancelAccessReviewAction |  |
| page.tsx | AccessReviewPage |  |
| **app/audit/findings/** | | |
| actions.ts | logFindingsViewAction, raiseFindingAction, respondToFindingAction, exportEvidenceAction |  |
| FindingForms.tsx | LogFindingsView, RaiseFindingForm, RespondForm, ExportEvidenceForm |  |
| page.tsx | AuditFindingsPage |  |
| **app/audit/grants/** | | |
| actions.ts | createAuditGrantAction, revokeAuditGrantAction |  |
| GrantForms.tsx | CreateGrantForm, RevokeGrantForm |  |
| page.tsx | AuditGrantsPage |  |
| **app/audit/workspace/** | | |
| actions.ts | logWorkspaceViewAction, searchHistoryAction, requestPeriodPackAction, pollPeriodPackAction, cancelPeriodPackAction |  |
| page.tsx | AuditorWorkspacePage |  |
| WorkspaceClient.tsx | LogWorkspaceView, ChangeHistorySearch, PeriodPackPanel |  |
| **modules/audit/** | | |
| access-review.ts | AUDIT_ACCESS_REVIEW_CAPABILITY, AUDIT_ACCESS_REVIEW_ROUTE, ACCESS_REVIEW_OBJECT_CLASS, AccessReviewError, createAccessReview, decideAccessReviewItem, applyAccessReviewRevocations, completeAccessReview, cancelAccessReview, getAccessReview, listAccessReviews, recordAccessReviewView, ACCESS_REVIEW_DECISIONS, ACCESS_REVIEW_STATUSES | access_review, access_review_item, app_user, role, sod_rule, user_capability, user_role, user_session |
| period-evidence-archive.ts | PACK_SCHEMA_VERSION, PACK_FILES, MANIFEST_FILE, neutraliseFormula, csvField, buildCsv, sha256Hex, HASH_NOTE, buildManifest, buildZip, packFilename |  |
| period-evidence-data.ts | ACCOUNT_TYPES, MAX_TOTAL_ROWS, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_BYTES, PeriodPackError, resolveSelection, collectEvidence | change_document, change_document_item, closing_execution_log, closing_task_event, closing_task_instance, closing_task_list, company_code, fiscal_year_period, fiscal_year_variant, journal_entry, posting_period_rule |
| period-evidence-report.ts | LIMITATIONS, limitationsText, renderPack |  |
| period-evidence.ts | AUDIT_PERIOD_EVIDENCE_CAPABILITY, AUDIT_PERIOD_PACK_JOB, PERIOD_PACK_DOWNLOAD_PREFIX, PACK_RETENTION_DAYS, packProbe, cleanupExpiredPeriodPacks, requestPeriodPack, getPeriodPackStatus, cancelPeriodPack, downloadPeriodPack, runPeriodPackChunk, listPeriodPackIds | audit_period_pack, job_run |
| read-only.ts | READ_KIND_ACTIONS, AUDIT_GRANT_EXCEPTIONS, isAuditorReadable, liveAuditGrantId, capabilityCatalogue, restrictToReadOnly, READ_SUFFIX, isAuditorReadableCapability | audit_grant, capability |
| schema.ts | AUDIT_GRANT_STATUSES, AUDIT_SCOPE_KINDS, AUDIT_SCOPE_MODULES, AUDIT_FINDING_KINDS, AUDIT_FINDING_STATUSES, auditGrant, auditGrantScope, auditFinding, ACCESS_REVIEW_STATUSES, ACCESS_REVIEW_DECISIONS, accessReview, accessReviewItem, AUDIT_PERIOD_PACK_STATUSES, auditPeriodPack | access_review, access_review_item, audit_finding, audit_grant, audit_grant_scope, audit_period_pack |
| workspace.ts | AUDIT_WORKSPACE_CAPABILITY, AUDIT_TRAIL_CAPABILITY, AUDIT_EXPORT_CAPABILITY, AUDIT_GRANT_CAPABILITY, AUDIT_RESPOND_CAPABILITY, AUDIT_WORKSPACE_ROUTE, AUDIT_GRANT_ROUTE, AUDIT_FINDING_ROUTE, AUDIT_GRANT_OBJECT_CLASS, AUDIT_FINDING_OBJECT_CLASS, AUDIT_RESPONSE_STATUSES, AUDIT_DRILL_THROUGH, AuditError, effectiveGrantStatus, scopeGap, grantCovers, logAuditAccess, refreshGrantStatus, activeGrantFor, createAuditGrant, revokeAuditGrant, listGrants, listGrantableUsers, enforceAuditAccess, grantStillCovers, assertAuditRead, recordAuditView, searchChangeHistory, exportEvidence, listFindings, listFindingsRaisedBy, raiseFinding, respondToFinding, auditWorkspaceView | app_user, audit_access_log, audit_finding, audit_grant, audit_grant_scope, company_code, fiscal_year_period |
| **modules/audit/jobs/** | | |
| period-pack.ts | periodPackJob |  |

## Routes (5)
`/api/audit/period-pack/[packId]` · `/audit/access-review` · `/audit/findings` · `/audit/grants` · `/audit/workspace`

## Tables owned (6)
access_review, access_review_item, audit_finding, audit_grant, audit_grant_scope, audit_period_pack

## Depends on
platform, platform/auth, platform/change, platform/db, platform/i18n, platform/job, platform/periods, platform/tables, ui/kit

## Used by
platform/auth, platform/tenancy, worker/jobs.ts

## Tests (2)
audit-period-evidence, audit-workspace

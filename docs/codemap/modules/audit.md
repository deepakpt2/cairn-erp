# Audit
Auditor workspace: time-boxed scoped read-only grants, no-post rule, audited auditor, findings/requests. Routes: `/audit/{workspace,grants,findings}`. Paths relative to `src/`; tables are SQL names.

## Gotchas
- Live audit grant strips every non-read capability centrally (admins too); close cockpit never opens for an auditor.
- Grant scope (company/period/module) is enforced only by audit's own reads (`assertAuditRead`, search, export); linked business screens are not scope-filtered (known gap).
- `effectiveGrants()` costs one extra query (`liveAuditGrantId`) per resolution.
- Demo phase `D6_AUDIT`; a COMPLETED install missing a later phase RESUMEs it and resets every demo password.

## Files (16)
| file | exports | tables |
|---|---|---|
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
| actions.ts | logWorkspaceViewAction, searchHistoryAction |  |
| page.tsx | AuditorWorkspacePage |  |
| WorkspaceClient.tsx | LogWorkspaceView, ChangeHistorySearch |  |
| **modules/audit/** | | |
| access-review.ts | AUDIT_ACCESS_REVIEW_CAPABILITY, AUDIT_ACCESS_REVIEW_ROUTE, ACCESS_REVIEW_OBJECT_CLASS, AccessReviewError, createAccessReview, decideAccessReviewItem, applyAccessReviewRevocations, completeAccessReview, cancelAccessReview, getAccessReview, listAccessReviews, recordAccessReviewView, ACCESS_REVIEW_DECISIONS, ACCESS_REVIEW_STATUSES | access_review, access_review_item, app_user, role, sod_rule, user_capability, user_role, user_session |
| read-only.ts | READ_KIND_ACTIONS, AUDIT_GRANT_EXCEPTIONS, isAuditorReadable, liveAuditGrantId, capabilityCatalogue, restrictToReadOnly, READ_SUFFIX, isAuditorReadableCapability | audit_grant, capability |
| schema.ts | AUDIT_GRANT_STATUSES, AUDIT_SCOPE_KINDS, AUDIT_SCOPE_MODULES, AUDIT_FINDING_KINDS, AUDIT_FINDING_STATUSES, auditGrant, auditGrantScope, auditFinding, ACCESS_REVIEW_STATUSES, ACCESS_REVIEW_DECISIONS, accessReview, accessReviewItem | access_review, access_review_item, audit_finding, audit_grant, audit_grant_scope |
| workspace.ts | AUDIT_WORKSPACE_CAPABILITY, AUDIT_TRAIL_CAPABILITY, AUDIT_EXPORT_CAPABILITY, AUDIT_GRANT_CAPABILITY, AUDIT_RESPOND_CAPABILITY, AUDIT_WORKSPACE_ROUTE, AUDIT_GRANT_ROUTE, AUDIT_FINDING_ROUTE, AUDIT_GRANT_OBJECT_CLASS, AUDIT_FINDING_OBJECT_CLASS, AUDIT_RESPONSE_STATUSES, AUDIT_DRILL_THROUGH, AuditError, effectiveGrantStatus, scopeGap, grantCovers, logAuditAccess, refreshGrantStatus, activeGrantFor, createAuditGrant, revokeAuditGrant, listGrants, listGrantableUsers, assertAuditRead, recordAuditView, searchChangeHistory, exportEvidence, listFindings, listFindingsRaisedBy, raiseFinding, respondToFinding, auditWorkspaceView | app_user, audit_access_log, audit_finding, audit_grant, audit_grant_scope, company_code, fiscal_year_period |

## Routes (4)
`/audit/access-review` · `/audit/findings` · `/audit/grants` · `/audit/workspace`

## Tables owned (5)
access_review, access_review_item, audit_finding, audit_grant, audit_grant_scope

## Depends on
platform, platform/auth, platform/change, platform/db, platform/i18n, platform/tables, ui/kit

## Used by
platform/auth, platform/tenancy

## Tests (1)
audit-workspace

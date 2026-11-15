# Platform (admin)
User/role/organisation-scope administration, job monitor, notifications inbox. Routes: `/platform/*` (incl. `jobs`, `notifications`). Paths relative to `src/`; tables are SQL names.

## Gotchas
- Three admin tiers: wildcard `ADMINISTRATOR`; `CFG.PLT.USER.*`; bootstrap-only `PLATFORM_ADMIN` (needed for `/platform/roles`).
- No self-grant/revoke/lock (service-enforced). Plant scope needs company scope first; company scope can't be revoked while plant scopes depend on it.
- Advisory locks guard cross-table invariants: `cairn/org-scope/…`, `cairn/platform-role-admin/…`, `cairn/user-create/…`.
- `PROTECTED_ROLE_CODES` and `isSystemRole` roles are never editable via UI.
- Job cancel is a request (in-hand chunk finishes). Opening a notification is a mutating GET.

## Files (25)
| file | exports | tables |
|---|---|---|
| **app/platform/jobs/** | | |
| actions.ts | cancelRun, retryRun |  |
| JobControls.tsx | JobControls |  |
| page.tsx | JobMonitorPage |  |
| **app/platform/locks/** | | |
| actions.ts | openChangeLockAction, heartbeatEnqueueAction, releaseEnqueueAction, deleteEnqueueAction |  |
| DeleteLock.tsx | DeleteLock |  |
| page.tsx | LockMonitorPage |  |
| **app/platform/notifications/** | | |
| page.tsx | NotificationsPage |  |
| **app/platform/notifications/[id]/** | | |
| page.tsx | OpenNotificationPage |  |
| **app/platform/roles/** | | |
| actions.ts | createRoleAction, updateRoleAction, setRoleActiveAction, grantCapabilityAction, revokeCapabilityAction, grantUserRoleAction, revokeUserRoleAction |  |
| capability-option.ts | WITHHELD_CAPABILITY_CODES, MAX_OPTION_LABEL_LENGTH, capabilityOptionLabel, assignableCapabilitiesFor |  |
| page.tsx | RolesPage |  |
| RoleManager.tsx | RoleManager |  |
| **app/platform/users/** | | |
| actions.ts | createUserAction, changeUserAction, setUserLockAction, initiatePasswordResetAction, requestPasswordResetAction, completePasswordResetAction, listUsersAction |  |
| constants.ts | CREATE, MAINTAIN, PASSWORD_RESET |  |
| page.tsx | UsersPage |  |
| UserDetailControls.tsx | UserDetailControls |  |
| Users.tsx | Users |  |
| **app/platform/users/[username]/** | | |
| page.tsx | UserDetailPage |  |
| **app/platform/users/access/** | | |
| actions.ts | grantCompanyScopeAction, grantPlantScopeAction, revokeOrganisationScopeAction |  |
| page.tsx | OrganisationScopeAdminPage |  |
| ScopeManager.tsx | ScopeManager |  |
| **modules/platform/** | | |
| organisation-scope-admin.ts | ORGANISATION_SCOPE_ADMIN_CAPABILITY, OrganisationScopeAdminError, provisionWalkthroughFirstAdminScopesInTransaction, getOrganisationScopeAdminOverview, getUserOrganisationScopes, grantCompanyCodeScope, grantPlantScope, revokeOrganisationScope | app_user, audit_access_log, auth_org_restriction, client, company_code, plant, role, role_capability, user_role, user_session |
| platform-admin-bootstrap.ts | PLATFORM_ADMIN_USER_CREATE_CAPABILITY, PLATFORM_ADMIN_USER_MAINTAIN_CAPABILITY, PLATFORM_ADMIN_CAPABILITIES, PLATFORM_ADMIN_BOOTSTRAP_TRANSACTION_CODE, PLATFORM_ADMIN_BOOTSTRAP_OBJECT_CLASS, bootstrapPlatformAdminInTransaction, PLATFORM_ADMIN_ROLE_CODE | audit_access_log, role, role_capability, user_role |
| role-admin.ts | PLATFORM_ADMIN_ROLE_CODE, ROLE_MAINTAIN_CAPABILITY, USER_ROLE_MAINTAIN_CAPABILITY, RoleAdminError, getRoleAdminOverview, createRole, updateRoleMetadata, setRoleActive, grantCapabilityToRole, revokeCapabilityFromRole, grantRoleToUser, revokeRoleFromUser | app_user, audit_access_log, auth_org_restriction, capability, role, role_capability, sod_rule, user_role, user_session |
| user-admin.ts | USER_ADMIN_VIEW_CAPABILITIES, canViewUserAdministration, UserAdminError, createUser, listUsers, getUserAdminDetails, changeUser, setUserLocked, initiatePasswordReset, requestPasswordReset, completePasswordReset | app_user, audit_access_log, capability, employee, password_reset_token, role, user_role, user_session |

## Routes (8)
`/platform/jobs` · `/platform/locks` · `/platform/notifications` · `/platform/notifications/[id]` · `/platform/roles` · `/platform/users` · `/platform/users/[username]` · `/platform/users/access`

## Tables owned (0)
—

## Depends on
foundation, people, platform/auth, platform/change, platform/db, platform/i18n, platform/job, platform/lock, platform/notification, platform/tables, platform/tenancy, ui/lock

## Used by
app/forgot-password, app/reset-password, platform/tenancy, ui/lock

## Tests (3)
change-lock-claim, purchasing-org-company-code-assignment-ui-contract, role-capability-select

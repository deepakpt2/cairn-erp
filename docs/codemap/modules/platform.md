# Platform (Admin)

**Purpose:** Tenant-local admin UI: user admin, role/capability admin, company/plant business-access scoping. Separate from shared auth/db/tenancy/locking infra in `src/platform/*` (see shared.md); this module is the screens/service layer using that infra. Also hosts SM12-style enqueue (lock) monitor, background-job monitor and notification inbox (screens over `src/platform/job`/`notification`).

## Files
- `src/app/platform/jobs/actions.ts` — cancel (request, worker stops after current chunk)/retry a job run; gated `PLT.JOB.CANCEL`/`PLT.JOB.RETRY`, lazy-imports `@/platform/job/queue`. Exports: `cancelRun`, `retryRun`, `JobActionState`.
- `src/app/platform/jobs/JobControls.tsx` — client: cancel/retry buttons for one run, shown only where applicable. Exports: `JobControls`.
- `src/app/platform/jobs/page.tsx` — `/platform/jobs` page: one line per run via `listRuns` (BLOCKED runs show holder); gated `PLT.JOB.DISPLAY`. Exports: `JobMonitorPage` (default).
- `src/app/platform/notifications/page.tsx` — `/platform/notifications` inbox (newest/unseen first, no archive/filter/dismiss) via `listInbox`; gated `PLT.NOTIFY.DISPLAY`. Exports: `NotificationsPage` (default).
- `src/app/platform/notifications/[id]/page.tsx` — `/platform/notifications/[id]`: marks seen then redirects to the document's screen via `platform/notification/routing` (inbox fallback for unrouted classes). Exports: `OpenNotificationPage` (default).
- `src/app/platform/locks/actions.ts` — lock monitor actions: open/heartbeat/release change lock, force-release enqueue entry. Exports: `openChangeLockAction`, `heartbeatEnqueueAction`, `releaseEnqueueAction`, `deleteEnqueueAction`, `ChangeLockState`, `LockDeleteState`.
- `src/app/platform/locks/DeleteLock.tsx` — client form (`useActionState`), force-delete enqueue entry by object/argument/reason. Exports: `DeleteLock`.
- `src/app/platform/locks/page.tsx` — `/platform/locks` page (SM12); held locks w/ staleness ("answered N s ago" vs stale badge); gated `PLT.LOCK.DISPLAY`/`PLT.LOCK.DELETE`. Exports: `LockMonitorPage` (default).
- `src/app/platform/roles/actions.ts` — wraps `role-admin.ts`: create/update/activate role, grant/revoke capability, grant/revoke user role. Exports: `createRoleAction`, `updateRoleAction`, `setRoleActiveAction`, `grantCapabilityAction`, `revokeCapabilityAction`, `grantUserRoleAction`, `revokeUserRoleAction`, `RoleAdminActionState`.
- `src/app/platform/roles/capability-option.ts` — helpers for capability-grant dropdown (keeps long descriptions out of `<option>` list). Exports: `capabilityOptionLabel`, `assignableCapabilitiesFor`, `WITHHELD_CAPABILITY_CODES`, `MAX_OPTION_LABEL_LENGTH`, `CapabilityOption`.
- `src/app/platform/roles/page.tsx` — `/platform/roles` page; loads `getRoleAdminOverview`, shows bootstrap hint on refusal. Exports: `RolesPage` (default).
- `src/app/platform/roles/RoleManager.tsx` — client: create custom role, assign role to user, per-role capability grant/revoke, user-role list, capability catalogue browser. Exports: `RoleManager` (default).
- `src/app/platform/users/access/actions.ts` — wraps `organisation-scope-admin.ts`: grant company/plant scope, revoke scope. Exports: `grantCompanyScopeAction`, `grantPlantScopeAction`, `revokeOrganisationScopeAction`, `OrganisationScopeActionState`.
- `src/app/platform/users/access/page.tsx` — `/platform/users/access` page; overview + selected user's scopes via `?query=&user=`. Exports: `OrganisationScopeAdminPage` (default).
- `src/app/platform/users/access/ScopeManager.tsx` — client: search users, grant company/plant scope (plant needs already-granted active company), revoke; self-assignment UI-disabled. Exports: `ScopeManager` (default).
- `src/app/platform/users/actions.ts` — wraps `user-admin.ts`: create/change user, lock/unlock, password-reset actions (admin-initiated paused, see gotchas), list users (server page only). Exports: `createUserAction`, `changeUserAction`, `setUserLockAction`, `initiatePasswordResetAction`, `requestPasswordResetAction`, `completePasswordResetAction`, `listUsersAction`, `UserActionState`.
- `src/app/platform/users/constants.ts` — 3 user-admin capability codes. Exports: `CREATE`, `MAINTAIN`, `PASSWORD_RESET`.
- `src/app/platform/users/page.tsx` — `/platform/users` page: directory w/ search/status filter, nav to Business access/Roles when authorized. Exports: `UsersPage` (default).
- `src/app/platform/users/UserDetailControls.tsx` — client, user-detail page: edit account (name/email/active), lock/unlock, reset notice. Exports: `UserDetailControls` (default).
- `src/app/platform/users/[username]/page.tsx` — `/platform/users/[username]` page: account facts, role assignments w/ validity, effective capabilities, org restrictions. Exports: `UserDetailPage` (default).
- `src/app/platform/users/Users.tsx` — client: create-account form + searchable/filterable table linking to user detail. Exports: `Users` (default).
- `src/modules/platform/organisation-scope-admin.ts` — service layer, company/plant business-access scope (`auth_org_restriction` rows). Validates live session + `CFG.PLT.USER.MAINTAIN`; forbids self-grant; requires company scope before plant scope in that company; blocks company revoke while dependent plant scopes exist; owns one-time walkthrough first-admin bootstrap. Exports: `getOrganisationScopeAdminOverview`, `getUserOrganisationScopes`, `grantCompanyCodeScope`, `grantPlantScope`, `revokeOrganisationScope`, `provisionWalkthroughFirstAdminScopesInTransaction`, `OrganisationScopeAdminError`, `ORGANISATION_SCOPE_ADMIN_CAPABILITY`, `ScopeCompanyChoice`, `ScopePlantChoice`, `ManagedOrganisationScope`, `ScopeAdminOverview`.
- `src/modules/platform/platform-admin-bootstrap.ts` — shared helper creating tenant `PLATFORM_ADMIN` role + capabilities + assignment, used by both trusted paths (tenant creation in `src/platform/tenancy/index.ts`, `scripts/bootstrap-platform-admin.ts`) so they can't drift. Exports: `bootstrapPlatformAdminInTransaction`, `PLATFORM_ADMIN_ROLE_CODE` (re-export), `PLATFORM_ADMIN_USER_CREATE_CAPABILITY`, `PLATFORM_ADMIN_USER_MAINTAIN_CAPABILITY`, `PLATFORM_ADMIN_CAPABILITIES`, `PLATFORM_ADMIN_BOOTSTRAP_TRANSACTION_CODE`, `PLATFORM_ADMIN_BOOTSTRAP_OBJECT_CLASS`, `PlatformAdminBootstrapInput`, `PlatformAdminBootstrapResult`.
- `src/modules/platform/role-admin.ts` — service layer, role/capability/user-role admin. Every mutation needs *live* session w/ active non-wildcard system `PLATFORM_ADMIN` role + exact `CFG.PLT.ROLE.MAINTAIN` or `CFG.PLT.USER.ROLE.MAINTAIN`; wildcard `ADMINISTRATOR` and ordinary `CFG.PLT.USER.MAINTAIN` insufficient. Enforces SoD, protected role codes, no self grant/revoke, no wildcard/protected capability assignment. Exports: `getRoleAdminOverview`, `createRole`, `updateRoleMetadata`, `setRoleActive`, `grantCapabilityToRole`, `revokeCapabilityFromRole`, `grantRoleToUser`, `revokeRoleFromUser`, `RoleAdminError`, `PLATFORM_ADMIN_ROLE_CODE`, `ROLE_MAINTAIN_CAPABILITY`, `USER_ROLE_MAINTAIN_CAPABILITY`, `RoleAdminOverview`, `RoleAdminRole`, `RoleAdminUser`.
- `src/modules/platform/user-admin.ts` — service layer, app-account admin, independent of HR employee records. Create/change/lock/unlock, admin-initiated reset (paused, D-033), self-service reset request/complete (non-enumerating, rate-limited, single-use hashed tokens). Exports: `createUser`, `changeUser`, `setUserLocked`, `listUsers`, `getUserAdminDetails`, `canViewUserAdministration`, `initiatePasswordReset`, `requestPasswordReset`, `completePasswordReset`, `UserAdminError`, `USER_ADMIN_VIEW_CAPABILITIES`, `UserStatusFilter`, `UserView`, `UserDirectoryRow`, `UserAdminDetail`, `CreateUserInput`, `ChangeUserInput`, `RequestResetInput`, `CompleteResetInput`.

## Pages & API routes
- `/platform/jobs` — background job monitor: runs, status, BLOCKED holder, cancel/retry. Gated `PLT.JOB.DISPLAY`/`CANCEL`/`RETRY`.
- `/platform/notifications` — per-user notification inbox. Gated `PLT.NOTIFY.DISPLAY`.
- `/platform/notifications/[id]` — open one notification: mark seen + redirect to its document (no render).
- `/platform/locks` — SM12-style enqueue monitor: list held change-locks (owner, object, argument, mode, transaction, since, heartbeat, staleness), force-delete entry. Gated `PLT.LOCK.DISPLAY`/`PLT.LOCK.DELETE`.
- `/platform/roles` — create/activate/deactivate custom roles, edit metadata, grant/revoke capabilities, assign/revoke roles, browse capability catalogue. Gated `CFG.PLT.ROLE.MAINTAIN` (view+most writes) / `CFG.PLT.USER.ROLE.MAINTAIN` (user-role assignment), both only via `PLATFORM_ADMIN`.
- `/platform/users` — app-account directory w/ search+status filter; create account. Gated: any of three `USER_ADMIN_VIEW_CAPABILITIES` to view; `CFG.PLT.USER.CREATE`/`MAINTAIN`/`PASSWORD_RESET` per action.
- `/platform/users/[username]` — account detail: facts, role assignments w/ validity window, effective capabilities, org restrictions; edit/lock controls.
- `/platform/users/access` — company/plant business-access scoping: search users, view/grant/revoke company+plant scopes. Gated `CFG.PLT.USER.MAINTAIN` (`ORGANISATION_SCOPE_ADMIN_CAPABILITY`).

## Database
**Owns:** No tables of its own. Persistence via shared tables in `src/platform/tables/security.ts` (`appUser`, `role`, `roleCapability`, `capability`, `userRole`, `authOrgRestriction`, `sodRule`, `auditAccessLog`, `passwordResetToken`, `userSession`) and `src/platform/tables/tenancy.ts` (`client`, read-only, walkthrough-bootstrap check).

**Reads/writes other modules'/shared tables:**
- `companyCode`, `plant` (foundation schema) — validate/label company/plant scope grants in `organisation-scope-admin.ts` (active-master, pairing checks).
- `employee` (people schema) — read-only, "has linked employee record" flag on user directory/detail (`user-admin.ts`); never written here.
- `changeDocument` (audit trail, `src/platform/tables/audit-trail.ts`) — read by `scripts/bootstrap-platform-admin.ts`, makes PLATFORM_ADMIN bootstrap non-repeatable.

## Depends on
- `src/modules/foundation` — company code/plant master data, validates/labels organisation-scope grants.
- `src/modules/people` — `employee` table, read-only, flags linked employee record (informational; never edits HR data).
- Shared/platform infra (`src/platform/*`):
  - `auth/current` (`can`, `requireSession`) — every page/action's session+capability gate.
  - `auth/session` (`hasCapability`, `loadCapabilities`, `loadOrgRestrictions`) — pattern matching, org-restriction loading, used directly by service layer.
  - `auth/password` (`hashPassword`, `checkPasswordPolicy`) — user-admin password handling.
  - `db/client` (`withTenant`, `Tx`) — every service function's tx boundary.
  - `tables/security`, `tables/tenancy` — persisted tables (see Database).
  - `change` (`recordChange`) — change-document audit trail per mutation.
  - `job/monitor` (`listRuns`), `job/queue` (`requestCancel`, `retryRun`) — job monitor screen.
  - `notification/notify` (`listInbox`, mark-seen), `notification/routing` — inbox screens.
  - `lock/enqueue` — SM12 screen's entire data source (`listEnqueue`, `openForChange`, `heartbeatChangeLock`, `releaseChangeLock`, `deleteEnqueueEntry`, `EnqueueError`, `displayOnlyMessage`).
  - `tenancy/walkthrough-install-guard` — guards walkthrough first-admin bootstrap to seed CLI only.
  - `i18n` (`t`) — locks page/DeleteLock form strings.
  - `src/ui/lock/remedy` (`displayOnlyRemedy`) — shared remedy text for display-only lock state.

## Used by
`grep -rln "@/modules/platform\|src/modules/platform" ...` outside own trees returns test files, bootstrap script and platform tenancy:
- `tests/walkthrough-provisioning-contract.test.ts`, `tests/walkthrough-seed-contract.test.ts` — read `organisation-scope-admin.ts` as text (not imported), assert walkthrough-seed-only bootstrap stays gated as expected.
- `scripts/bootstrap-platform-admin.ts` (also listed under Scripts) imports `PLATFORM_ADMIN_ROLE_CODE`, `ROLE_MAINTAIN_CAPABILITY`, `USER_ROLE_MAINTAIN_CAPABILITY` from `role-admin.ts` and `platform-admin-bootstrap.ts`.
- `src/platform/tenancy/index.ts` — dynamic-imports `bootstrapPlatformAdminInTransaction` at tenant creation (first user becomes PLATFORM_ADMIN).
- `src/platform/tenancy/demo-people.ts` — demo seeding via `createUser`/`completePasswordReset`/`initiatePasswordReset`, `createRole`/`grantCapabilityToRole`/`grantRoleToUser`, `grantCompanyCodeScope`/`grantPlantScope`.

No other business module imports this module — leaf consumer of shared infra + `foundation`/`people`. Walkthrough/seed flow and tenant creation (`src/platform/tenancy`) depend on it to provision first tenant administrator.

## Tests
- `tests/organisation-scope-admin-actions.test.ts` — grant/revoke company/plant scope actions: capability gate, self-grant refusal, error mapping.
- `tests/organisation-scope-admin-rollback.test.ts` — transaction-rollback on scope-grant failures.
- `tests/organisation-scope-admin.test.ts` — `organisation-scope-admin.ts` service tests: grant ordering, master validation, dependent-plant revoke block, walkthrough bootstrap guard.
- `tests/platform-admin-bootstrap-contract.test.ts` — `scripts/bootstrap-platform-admin.ts` contract: non-repeatable, requires live session, token comparison, self-bootstrap refusal.
- `tests/platform-role-actions-server-export-contract.test.ts` — shape/exports of `src/app/platform/roles/actions.ts` stay stable.
- `tests/platform-role-admin.test.ts` — `role-admin.ts` service tests: SoD enforcement, protected roles, wildcard refusal, PLATFORM_ADMIN-only gating.
- `tests/platform-role-live-authorization-contract.test.ts` — role-admin mutations require *live* persisted session w/ exact capability (wildcard/stale-session rejection).
- `tests/platform-user-actions-security.test.ts` — `src/app/platform/users/actions.ts` security: capability gating per action, no token leakage from reset actions.
- `tests/platform-user-admin-role-acl.test.ts` — interaction of user-admin view access with role-based capability grants.
- `tests/platform-user-admin.test.ts` — `user-admin.ts` service tests: create/change/lock, self-lock/self-deactivate refusal, reset token lifecycle, non-enumeration.

## Scripts
`scripts/bootstrap-platform-admin.ts` — one-time, interactive, deployment-owner-only CLI; creates tenant's `PLATFORM_ADMIN` system role, assigns to a nominated already-sessioned user. Not an HTTP action, not reusable (guarded by `platform_admin_bootstrap` change-document marker, needs separately configured high-entropy token via `timingSafeEqual`). One of two paths creating `PLATFORM_ADMIN` (other: tenant creation), both via `platform-admin-bootstrap.ts`; `role-admin.ts` refuses to create/assign it.

## Non-obvious behavior / gotchas
- Three non-interchangeable admin tiers: (1) wildcard `ADMINISTRATOR` role, (2) ordinary `CFG.PLT.USER.MAINTAIN`/`CFG.PLT.USER.CREATE`, (3) bootstrap-only `PLATFORM_ADMIN` holding `CFG.PLT.ROLE.MAINTAIN`/`CFG.PLT.USER.ROLE.MAINTAIN`. `/platform/roles` needs tier 3 (`requirePlatformAdministrator` checks literal role+capability; tier-1 wildcard insufficient). `/platform/users/access` needs only tier 2. Both `organisation-scope-admin.ts` and `role-admin.ts` check the literal `CFG.PLT.USER.MAINTAIN` — don't conflate "manage business scope" with "manage roles."
- No self-grant/self-revoke anywhere: `grantRoleToUser`/`revokeRoleFromUser`, `grantCompanyCodeScope`/`grantPlantScope` refuse when target===actor; `setUserLocked`/`changeUser` refuse self-lock/deactivate. Enforced in service layer, not just UI (`isSelf` in `ScopeManager.tsx` also disables controls).
- Password reset deliberately half-wired (D-033): `initiatePasswordResetAction` always returns fixed refusal, never calls real `initiatePasswordReset` (exists, tested, dead-from-UI). Self-service request/complete work end-to-end, non-enumerating.
- Plant scope needs company scope first; company can't revoke while dependents exist: `grantPlantScope` throws unless target holds `COMPANY_CODE` scope for that company; `revokeOrganisationScope` throws if it'd orphan `PLANT` scopes (checked incl. plants whose master row no longer exists).
- Protected role codes hardcoded: `PROTECTED_ROLE_CODES` in `role-admin.ts` = `PLATFORM_ADMIN`, `ADMINISTRATOR`, `CONFIGURATOR`, `ACCOUNTANT`, `CONTROLLER`, `BUYER`, `PLANNER`, `PRODUCTION_CLERK`, `WAREHOUSE_CLERK`, `SALES_CLERK`, `AUDITOR`, plus any `isSystemRole` row — never editable/assignable via `/platform/roles`, only bootstrap/migration.
- `capability-option.ts` withholds `CFG.PLT.ROLE.MAINTAIN`/`CFG.PLT.USER.ROLE.MAINTAIN` from UI grant list even for authorized admins — belt-and-suspenders atop `grantCapabilityToRole`'s service-layer check.
- `organisation-scope-admin.ts`'s `provisionWalkthroughFirstAdminScopesInTransaction` (dev walkthrough seed only) re-validates an exact tenant fingerprint (name, legal name, country AE, currency AED, timezone, exactly one user, exactly one ADMINISTRATOR-only role assignment, no pre-existing scopes) before inserting — can't be repurposed as general bootstrap.
- Job cancel is a request, not a kill: worker finishes the in-hand chunk first. Notification open is a redirecting GET that mutates (mark seen) — no rendered page.
- Advisory locks, not row locks, guard cross-table invariants: `cairn/org-scope/{client}/{userId}` (per-user scope mutations), `cairn/platform-role-admin/{client}` (tenant-wide role mutations), `cairn/user-create/{client}/{username}` (username-uniqueness ahead of DB unique index).

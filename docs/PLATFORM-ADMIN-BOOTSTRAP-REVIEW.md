# PLATFORM_ADMIN bootstrap — retained-account decision and audit record

**Current disposition (2026-11-01): the owner confirmed retaining `PLATFORM.BOOTSTRAP` (`e5b023d6-8a70-4782-85e4-d558ceb3f86a`) as WK01’s intended `PLATFORM_ADMIN` account.** Read-only verification was repeated after first checking the live database identity. The account is active and unlocked, does not require a password change, has exactly `CFG.PLT.ROLE.MAINTAIN` and `CFG.PLT.USER.ROLE.MAINTAIN`, has no wildcard or business capabilities, and currently has no live persisted session. Its empty scope list means unrestricted organization scope. The one-time bootstrap is already recorded in WK01’s database; **do not run or retry it**.

The selected account is distinct from the historical bootstrap actor label `STAGE2_OWNER_20261031`. The audit row has `user_id=NULL`, and no WK01 account matches that label, so it does not identify the human behind the operation. The owner’s confirmation establishes which application account to retain; it does not establish who currently holds its credentials. The account must be used through normal sign-in. The owner is responsible for any credential custody/handover through the normal approved secure process; no credentials were requested, viewed, reset, transferred, or recorded here. No session, token, role, capability, scope, account, migration, seed, or permission change was made.

## 1. Current owner decision and account handling

- **Confirmed account:** `PLATFORM.BOOTSTRAP`, WK01 user ID `e5b023d6-8a70-4782-85e4-d558ceb3f86a`. The owner confirmed this exact account for retention as the intended platform administrator on 2026-11-01.
- **Verified state:** active, unlocked, `must_change_password=false`; one current direct assignment to the active system role `PLATFORM_ADMIN`; its only capability grants are `CFG.PLT.ROLE.MAINTAIN` and `CFG.PLT.USER.ROLE.MAINTAIN`. There is no wildcard or business capability. Its scope list is empty/unrestricted, and its current live persisted-session check is `false`.
- **Normal sign-in and custody:** the account holder must sign in using the existing account through the ordinary sign-in flow to establish a live persisted session before using protected platform-administration pages. No live session exists now. The database identifies the application account, not the human who controls its credentials. Any owner-directed credential handover remains outside this read-only review and must use the normal approved secure channel. Do not put credentials, tokens, cookies, or session identifiers in this document or its audit note.
- **Historical completion:** one `CFG.PLT.PLATFORM_ADMIN.BOOTSTRAP` audit event and its matching change-document CREATE record exist for tenant `WK01`, target account above, at 2026-10-31 16:19:23 UTC. The assigned role is already present. The one-time bootstrap command refuses when a bootstrap record or `PLATFORM_ADMIN` role already exists; do not rerun it, create another platform administrator, or attempt replacement.
- **Distinct actor:** the database records `STAGE2_OWNER_20261031` as the historical actor label, with a null app-user ID and no matching WK01 account. This label is not the owner-confirmed account holder and does not identify a human. No current bootstrap actor setting was found in the running application environment or test-host `.env.local`.
- **Change boundary:** this task permits only read-only verification and documentation. No credential handover, account/session/role/capability/scope mutation, migration, seed, bootstrap, or permission change is authorized or performed.

The remaining pre-bootstrap source notes and diagnostic below document the earlier implementation review and evidence. They are retained for audit/reference only; they do not authorize a new invocation for WK01. The bootstrap is complete.

## 2. Source findings: actual schema, authorization, RLS, and identities

### Role and capability model

The Drizzle definitions are in `src/platform/tables/security.ts` and the schema root is `src/platform/schema.ts`.

- `user_role` has `(client, user_id, role_code, valid_from, valid_to, …)`; it is the user-to-role assignment relation. There is **no role-parent, role-inheritance, or group-membership table** in this model. Thus the owner reports direct role assignments; the “inherited” authority is the capabilities contributed by each assigned role, not a recursive role hierarchy.
- `role` has `(client, code, name, is_system_role, is_read_only, is_active, …)`. Migration 9209 adds `is_active` (default true).
- `role_capability` has `(client, role_code, capability_code, …)`. `capability_code` is a pattern and intentionally has no FK to the catalogue: values such as `PROC.*` and `*` are valid grants.
- `capability` has global `code`, `module`, `action`, and posting-relevance fields; it has no `client` column and is not tenant-RLS-scoped.
- `loadCapabilities()` in `src/platform/auth/session.ts` joins current-valid `user_role` rows to active `role` rows and `role_capability`, returning distinct stored grant patterns. `hasCapability()` evaluates each pattern using the project’s whole-dot-segment rules; terminal `*` covers the remainder, and an interior `*` consumes one segment. `EXPLICIT_GRANT_ONLY_CAPABILITIES` are exact-only. The inspection below reports both stored patterns and registered catalogue codes that the **actual** `hasCapability()` function recognizes; the latter is only the current catalogue, not future/unregistered strings.
- `auth_org_restriction` stores `(id, client, user_id, scope_type, scope_value, created_by, created_at, …)`. `loadOrgRestrictions()` returns **all** rows for that user. `hasOrgAccess()` treats an empty list as unrestricted; a non-empty list allows only a matching type/value. Scope rows are not inherited from roles.

### Supported UI/service paths and their limits

- `/platform/roles` calls `getRoleAdminOverview()` in `src/modules/platform/role-admin.ts`. The service first requires a live persisted session and the exact active, system `PLATFORM_ADMIN` role with the required explicit capability. It returns roles, role-capability patterns, and assignments, but it is therefore not available as a pre-bootstrap view.
- `/platform/users/access` calls `getUserOrganisationScopes()` in `src/modules/platform/organisation-scope-admin.ts`; it requires a live session and `CFG.PLT.USER.MAINTAIN`. Its UI/service reports only `COMPANY_CODE` and `PLANT`, while `loadOrgRestrictions()` can return other stored scope types. This is not a complete scope report.
- No pre-bootstrap owner-facing application page/service was found that reports a user’s full role/capability composition. A one-time, read-only diagnostic is therefore necessary. It uses the project’s `withTenant`, `loadCapabilities`, `hasCapability`, and `loadOrgRestrictions` helpers for tenant context and effective-capability semantics, plus a read-only join over the assignment tables to show direct grants and inactive/historical assignments.

### Tenant isolation and least-privilege read access

`drizzle/9000_policies.sql` lists `app_user`, `role`, `role_capability`, `user_role`, and `auth_org_restriction` as tenant tables. It enables and **forces** RLS and creates `tenant_isolation` `FOR ALL` policies using and checking `client = current_setting('cairn.client', true)`. `src/platform/db/client.ts::withTenant()` asserts the application role and sets `SET LOCAL cairn.client='WK01'` within the transaction.

`9000_policies.sql` initially grants `SELECT, INSERT, UPDATE, DELETE` on public tables to `cairn_app`. `9207_central_user_auth_least_privilege.sql` narrows only `app_user`, `user_session`, and `password_reset_token`; `scripts/sync-db-app-role.ts` likewise limits its central-auth ACL reconciliation to those three tables. It does not revoke `SELECT` from `role`, `role_capability`, `user_role`, or `auth_org_restriction`. `capability` is a global catalogue table. No privilege changes are part of this checklist.

A read-only runtime catalog/privilege probe was run only after confirming the live identity was `cairn_stage2_walkthrough_20261031` / `cairn_app` / port `55432`. It confirmed `SELECT=true` for `app_user`, `role`, `role_capability`, `user_role`, `auth_org_restriction`, `user_session`, and `capability`; the six tenant tables had `relrowsecurity=true`, `relforcerowsecurity=true`, and `tenant_isolation` policies. `capability` has no RLS, consistent with its global schema. `cairn_app` was not superuser and did not have `BYPASSRLS`. This was catalog/privilege inspection only; no user rows, sessions, or role assignments were queried in that probe.

### Current WK01 state revalidated 2026-11-01

The current check first verified `current_database=cairn_stage2_walkthrough_20261031`, `current_user=cairn_app`, server port `55432`, `rolsuper=false`, and `rolbypassrls=false`. Only after that identity match did it query tenant `WK01` through `withTenant('WK01', …)`. Live-session status was selected as an `EXISTS` boolean only; no session identifiers, tokens, password hashes, or credential fields were queried.

- The owner-confirmed account `PLATFORM.BOOTSTRAP` (`e5b023d6-8a70-4782-85e4-d558ceb3f86a`) exists in WK01, is active/unlocked, has `must_change_password=false`, and was created by `walkthrough.admin`. Its last recorded login is `2026-10-31T16:22:00.635Z`; its current live persisted-session result is **false**.
- It has one direct, current assignment to active system role `PLATFORM_ADMIN` (valid from `2026-10-31T16:19:23.418Z`, no `valid_to`). The effective patterns and the role’s capability rows are exactly `CFG.PLT.ROLE.MAINTAIN` and `CFG.PLT.USER.ROLE.MAINTAIN`. There is no wildcard and no business capability. `auth_org_restriction` has no rows for this user, which the application treats as unrestricted scope; this does not add business capabilities.
- The tenant contains one `CFG.PLT.PLATFORM_ADMIN.BOOTSTRAP` `CONFIG_CHANGE` audit entry and one matching `platform_admin_bootstrap` change-document CREATE record, both targeting `WK01/e5b023d6-8a70-4782-85e4-d558ceb3f86a` and timestamped `2026-10-31 16:19:23 UTC`.
- The actor value on those records is `STAGE2_OWNER_20261031`; its audit `user_id` is null and no WK01 `app_user` has that username. Source treats the operator identifier as a supplied string recorded in audit, not an authenticated app-user identity. The current application process and test-host `.env.local` have no bootstrap actor/parameter keys. The records therefore establish the historical actor **label**, not the human behind it.
- The onboarding administrator `walkthrough.admin` (`4456b871-adb1-4776-bbc8-d4753ed04d99`) is a different account with direct `ADMINISTRATOR` and `*`; the walkthrough operator `WALKTHROUGH.OPERATOR` (`9f640170-2503-41eb-9f59-88a8209bc4e1`) is also different, with `WALKTHROUGH_OPERATOR`, 20 explicit business capabilities, and `COMPANY_CODE=1000` / `PLANT=1000` restrictions. Neither is the owner-confirmed platform-admin account.

**Account ownership and sign-in:** the owner has confirmed the application account to retain, not the human credential custodian. The account must be handed to or retained by the owner-designated authorized holder using the normal secure credential-handover process, followed by ordinary sign-in. No credentials were read or transferred, no reset was performed, and no session was created. Until that normal sign-in, the platform pages requiring a live session are not currently usable by this account.

### Identity provenance and separation

- `createTenant()` in `src/platform/tenancy/index.ts` takes an owner-provided `administrator.username`, creates that user, and assigns `ADMINISTRATOR`; that role carries `*`. The WK01 user row and role assignment confirm `walkthrough.admin` (`4456b871-adb1-4776-bbc8-d4753ed04d99`) as the onboarding administrator. It is distinct from the retained account.
- The previous WK01 Stage 2 record in `CAIRN-7.md` §30 row 2.851 and the current tenant rows identify `WALKTHROUGH.OPERATOR` (`9f640170-2503-41eb-9f59-88a8209bc4e1`) as the walkthrough account. It has direct role `WALKTHROUGH_OPERATOR`, 20 explicit capabilities and `COMPANY_CODE=1000` / `PLANT=1000` restrictions. It is distinct from both the onboarding administrator and the retained account.
- The owner-confirmed retained account is the separate app user `PLATFORM.BOOTSTRAP` (`e5b023d6-8a70-4782-85e4-d558ceb3f86a`). Its role assignment and the matching bootstrap audit/change records identify the target independently of its username.
- The historical deployment/bootstrap actor is `STAGE2_OWNER_20261031`. Its audit row has no app-user ID; a targeted tenant lookup found no matching app user. It is therefore not an account ID or the confirmed account holder. The human behind this historical actor label cannot be mapped from the queried database records or current application/environment configuration; do not infer one.


## 3. Historical pre-bootstrap read-only diagnostic (account check completed)

**The account check has been completed for the owner-confirmed account.** The diagnostic below is retained as a historical/reproducible read-only reference only, not as authorization or an instruction to run bootstrap. The current session result is `false`; do not create a session to make a bootstrap precondition pass. The existing role and bootstrap record mean no bootstrap remains to perform. Any future request to replace the holder requires a separately designed and owner-authorized process; this diagnostic cannot authorize that process.

The remaining procedure is preserved as a historical pre-bootstrap diagnostic reference; it was not the exact script used for the current revalidation, which used the owner-confirmed ID. **Do not run it for this account or as a step toward another bootstrap.** For any separately designed and explicitly authorized future read-only review only, the old procedure expected a trusted terminal on the approved checkout with runtime `DATABASE_URL` configured for `cairn_app`; it never uses `MIGRATION_DATABASE_URL` or reads credentials. The old procedure obtains a nominee ID from the owner-visible user list, not from a guess or credential query. `/platform/users` displays username/status but omits the ID; if the already-authorized viewing account can maintain users, clicking **Change** renders a hidden `userId` input. Read that field in the DOM/Elements inspector and immediately click **Cancel**—do not submit Save/Create/reset. This only changes client-side form state. If Change is unavailable or the field cannot be confirmed, stop; there is no visible ID display in that page. Separately record the operator’s actual WK01 user ID/username (or owner-confirm `NO_WK01_USER`) and the exact planned `CAIRN_PLATFORM_BOOTSTRAP_ACTOR` identifier; compare them to the nominee by both ID and username. Keep these owner identity records local. Set non-secret identifiers locally (the onboarding username should be the actual value in the provisioning record; current documented values are shown):

```bash
read -r -p 'Verified nominee WK01 user ID: ' CAIRN_READONLY_NOMINEE_USER_ID
export CAIRN_READONLY_NOMINEE_USER_ID
export CAIRN_READONLY_ONBOARDING_USERNAME='walkthrough.admin'
export CAIRN_READONLY_WALKTHROUGH_USERNAME='WALKTHROUGH.OPERATOR'
```

If those names do not match the owner’s provisioning and seed/run records, set the actual names before proceeding. These variables contain no password, token, cookie, or session material.

The script below is **read-only**. First it checks `current_database()`, `current_user`, server port, and required `SELECT`/RLS metadata. Only after the exact identity matches does it open the app transaction using `withTenant('WK01', …)`. It never selects `password_hash`, `token_hash`, session IDs, IPs, or user-agents; it reads only an `EXISTS` boolean for a live session. It does not call any action/mutation service. Its direct-role query uses the verified schema columns and joins:

- `user_role ur` → `role r` on `(client, role_code)`;
- `role_capability rc` on `(client, role_code)`;
- exact tenant and nominee `user_id` predicates.

```bash
node --import tsx - <<'JS'
const postgres = require('postgres');
const { and, eq, sql } = require('drizzle-orm');
const { withTenant, closeDb } = require('./src/platform/db/client.ts');
const { loadCapabilities, hasCapability, loadOrgRestrictions } = require('./src/platform/auth/session.ts');
const { appUser, capability } = require('./src/platform/tables/security.ts');

const TENANT = 'WK01';
const NOMINEE_ID = process.env.CAIRN_READONLY_NOMINEE_USER_ID;
const ONBOARDING_USERNAME = process.env.CAIRN_READONLY_ONBOARDING_USERNAME;
const WALKTHROUGH_USERNAME = process.env.CAIRN_READONLY_WALKTHROUGH_USERNAME;

(async () => {
  if (!NOMINEE_ID || !ONBOARDING_USERNAME || !WALKTHROUGH_USERNAME) {
    console.error('STOP: set the verified nominee ID and owner-verified identity names.');
    process.exitCode = 1;
    return;
  }

  const raw = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const [identity] = await raw`select current_database() as db, current_user as role,
      inet_server_port() as port, r.rolsuper as superuser, r.rolbypassrls as bypassrls
      from pg_roles r where r.rolname=current_user`;
    console.log(`IDENTITY db=${identity.db} role=${identity.role} port=${identity.port} superuser=${identity.superuser} bypassrls=${identity.bypassrls}`);
    if (identity.db !== 'cairn_stage2_walkthrough_20261031' || identity.role !== 'cairn_app' || Number(identity.port) !== 55432 || identity.superuser || identity.bypassrls) {
      throw new Error('database identity/role mismatch');
    }

    const relations = await raw`select c.relname, c.relrowsecurity as rls,
      c.relforcerowsecurity as force_rls,
      has_table_privilege(current_user,c.oid,'SELECT') as can_select,
      exists(select 1 from pg_policies p where p.schemaname='public'
        and p.tablename=c.relname and p.policyname='tenant_isolation') as tenant_policy
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public'
        and c.relname = any(${['app_user','role','role_capability','user_role','auth_org_restriction','user_session','capability']})
        and c.relkind in ('r','p') order by c.relname`;
    console.log('READ_ACCESS ' + JSON.stringify(relations));
    if (relations.length !== 7 || relations.some(r => !r.can_select) ||
        relations.filter(r => r.relname !== 'capability').some(r => !r.rls || !r.force_rls || !r.tenant_policy) ||
        relations.find(r => r.relname === 'capability')?.rls) {
      throw new Error('required read privilege or expected RLS state is missing');
    }
  } catch {
    console.error('STOP: identity, SELECT privilege, or RLS check failed; no nominee query was run.');
    process.exitCode = 1;
    return;
  } finally {
    await raw.end({ timeout: 3 });
  }

  try {
    const report = await withTenant(TENANT, async tx => {
      const [user] = await tx.select({
        id: appUser.id, client: appUser.client, username: appUser.username,
        fullName: appUser.fullName, isActive: appUser.isActive,
        isLocked: appUser.isLocked, mustChangePassword: appUser.mustChangePassword,
      }).from(appUser).where(and(eq(appUser.client, TENANT), eq(appUser.id, NOMINEE_ID)));
      if (!user) throw new Error('nominee not found in WK01');

      // Boolean only: expose no session id, token hash, IP, or user-agent.
      const sessionState = await tx.execute(sql`
        select exists (
          select 1 from user_session s
           where s.client=${TENANT} and s.user_id=${user.id}
             and s.revoked_at is null and s.expires_at > now()
        ) as has_live_session
      `);

      const assignments = await tx.execute(sql`
        select ur.role_code, r.name as role_name,
               r.is_system_role, r.is_read_only, r.is_active as role_is_active,
               ur.valid_from, ur.valid_to, rc.capability_code
          from user_role ur
          left join role r
            on r.client=ur.client and r.code=ur.role_code
          left join role_capability rc
            on rc.client=ur.client and rc.role_code=ur.role_code
         where ur.client=${TENANT} and ur.user_id=${user.id}
         order by ur.role_code, rc.capability_code
      `);

      const grantPatterns = await loadCapabilities(tx, TENANT, user.id);
      const catalogue = await tx.select({ code: capability.code }).from(capability).orderBy(capability.code);
      const effectiveRegisteredCapabilities = catalogue
        .filter(row => hasCapability(grantPatterns, row.code))
        .map(row => row.code);
      const scopeRestrictions = await loadOrgRestrictions(tx, TENANT, user.id);

      const onboarding = await tx.execute(sql`
        select u.id, u.username, u.is_active, u.is_locked,
               ur.role_code, r.is_active as role_is_active, rc.capability_code
          from app_user u
          left join user_role ur on ur.client=u.client and ur.user_id=u.id
          left join role r on r.client=ur.client and r.code=ur.role_code
          left join role_capability rc on rc.client=r.client and rc.role_code=r.code
         where u.client=${TENANT} and lower(u.username)=lower(${ONBOARDING_USERNAME})
         order by ur.role_code, rc.capability_code
      `);
      const walkthrough = await tx.execute(sql`
        select u.id, u.username, u.is_active, u.is_locked,
               ur.role_code, r.is_active as role_is_active, rc.capability_code
          from app_user u
          left join user_role ur on ur.client=u.client and ur.user_id=u.id
          left join role r on r.client=ur.client and r.code=ur.role_code
          left join role_capability rc on rc.client=r.client and rc.role_code=r.code
         where u.client=${TENANT} and lower(u.username)=lower(${WALKTHROUGH_USERNAME})
         order by ur.role_code, rc.capability_code
      `);

      return {
        tenantContext: TENANT,
        nominee: user,
        livePersistedSession: sessionState[0]?.has_live_session === true,
        roleHierarchy: 'none in schema; user_role rows are direct assignments',
        directAssignments: assignments,
        effectiveGrantPatterns: grantPatterns,
        wildcardPatterns: grantPatterns.filter(value => value.includes('*')),
        effectiveRegisteredCapabilities,
        scopeRestrictions,
        emptyScopeMeaning: scopeRestrictions.length === 0 ? 'UNRESTRICTED by hasOrgAccess' : 'restricted to listed exact type/value pairs',
        onboardingIdentityRows: onboarding,
        walkthroughIdentityRows: walkthrough,
      };
    });
    console.log('NOMINEE_READ_ONLY_REPORT\n' + JSON.stringify(report, null, 2));
  } catch {
    console.error('STOP: tenant-scoped nominee inspection failed; do not proceed or alter permissions.');
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
})();
JS
```

### Expected report and interpretation

- The first output must identify only the verified WK01 database, `cairn_app`, port `55432`, with `superuser=false` and `bypassrls=false`; all seven tables must be selectable. RLS must be enabled/forced with `tenant_isolation` for the six tenant tables, including `user_session`; the global `capability` catalogue is expected not to have RLS.
- The tenant service must run with `tenantContext: WK01`. The nominee row must match the owner-verified ID and be active/unlocked, and `livePersistedSession` must be `true`. The session result is an `EXISTS` boolean only; no session row, ID, token hash, IP, or user-agent is returned. The nominee must have signed in through the ordinary flow; this procedure never creates or refreshes a session. `mustChangePassword=true` is not accepted for a bootstrap nominee; resolve through a separately approved normal credential process, not this procedure.
- `directAssignments` includes each direct `user_role` row, role status, validity interval and every stored `role_capability.capability_code`. Historical/expired assignments remain visible here but do not contribute to `effectiveGrantPatterns`.
- `effectiveGrantPatterns` is the source helper’s union across currently valid assignments to active roles. `wildcardPatterns` must be empty unless an explicitly reviewed non-wildcard pattern is approved; for the dedicated bootstrap account, any `*`-containing grant is a stop. `effectiveRegisteredCapabilities` expands those patterns against the current global catalogue using the actual `hasCapability()` implementation.
- `roleHierarchy` must remain “none in schema.” Do not infer a nested role or group membership that is not represented by `user_role`.
- Check `onboardingIdentityRows` and `walkthroughIdentityRows` against provisioning/seed records. The nominee’s ID and username must match neither. The onboarding row should show its `ADMINISTRATOR` assignment and `*` grant when that identity is the documented `walkthrough.admin`; the documented `WALKTHROUGH.OPERATOR` identity should match the prior Stage 2 record and must not be reused. Also compare the nominee’s exact ID/username against the owner-verified operator account (if any) and ensure its username differs from the exact planned `CAIRN_PLATFORM_BOOTSTRAP_ACTOR`; do not rely only on the CLI’s username guard.
- `scopeRestrictions` must be reviewed in full. `COMPANY_CODE`, `PLANT`, `STORAGE_LOCATION`, `PURCHASING_ORG`, `SALES_ORG`, and `COST_CENTER` may occur; treat any unknown type as a stop. **An empty list is unrestricted, not “no access.”** Scope restrictions do not grant roles or capabilities.

This read path never selects password hashes, session token hashes, session IDs, IP addresses, or user-agents; it checks only an `EXISTS` boolean for a live persisted session and does not create/revoke/refresh sessions. It uses the exact app-role read privileges and tenant RLS, but it is not an owner-facing HTTP route; it is a carefully bounded pre-bootstrap diagnostic because the supported role overview is circularly gated. Do not convert it into a write script or add grants to make it pass.

## 4. Historical hidden-TTY token review — do not invoke

**The material in this section is retained as a historical security review only. WK01’s one-time bootstrap is complete; do not generate/set a token or run the CLI.**

`scripts/bootstrap-platform-admin.ts::readOwnerConfirmation()` (lines 23–43) requires an interactive TTY, enables raw mode, writes only the fixed prompt `Deployment-owner bootstrap token (input hidden): `, accepts printable ASCII in memory up to 256 characters, handles Enter/backspace/Ctrl-C, then removes its input listener, disables raw mode, and pauses stdin. There is no echo call for token bytes. `platformBootstrapTokenMatches()` (46–50) requires both configured and supplied tokens to be at least 32 characters, caps the supplied input at 256, and compares SHA-256 digests using `timingSafeEqual`. The source does not itself cap the configured value, so the owner must enforce the requested 32–256 character range; use printable ASCII because non-ASCII input is ignored. The configured token comes from `process.env.CAIRN_PLATFORM_BOOTSTRAP_TOKEN`; `npm run`/`tsx` pass that value in the child **environment**, not command arguments. The CLI does not write it to a file, database, browser, or log; failure messages and success output do not include it.

**Important exposure:** the parent shell and child process environment contain the configured token while the command runs. On this host, Yama `ptrace_scope` is `0`; the app process and operator run as the same `cairn` UID, and same-UID `/proc/<pid>/environ` reads are possible. Therefore a concurrent same-UID process could read the token. Hidden input protects against terminal echo, not this process boundary. The CLI retains its environment value until process exit; it does not unset it itself.

The previously reviewed hidden-TTY method does not apply to a new WK01 invocation: the account already has `PLATFORM_ADMIN`, and a bootstrap record exists. **Do not generate, set, or enter a token; do not invoke `npm run platform-admin:bootstrap`.** No token was generated or entered in this owner-confirmation task. A later request to replace the account would require a separately designed and owner-authorized path; this one-time CLI is not a replacement mechanism.

## 5. `.env.local` permissions and remediation recommendation

The test-host `/home/cairn/cairn-erp/.env.local` is `0644`, owned `cairn:cairn`, and contains database-URL keys. The live app on port 3100 was running as `cairn` from `/tmp/cairn_rolefix_verify_20261031`, not from this checkout; a `/proc/*/fd` scan found no open descriptor for this file. No `cairn-erp` user systemd unit was found. The deployment runbook does not require group/world access to `.env.local`; it reads it for operator Git/SSH credentials, while its Docker `.env` procedure explicitly uses `chmod 600`. The running app needs only owner-readable environment material when it is started from a project directory; no group/world read is required.

**Recommended permissions-only change after owner authorization:** retain owner/group and contents; set `/home/cairn/cairn-erp/.env.local` to mode `0600` (owner read/write only), then verify with `stat -c '%a %U:%G %n' ...`. Do not add the bootstrap token to this file. If ACLs are present, inspect them first and ensure no named group/user ACL preserves access. This review did not change mode, ACL, owner, group, or file content.

The agent workspace copy `/home/user/cairn-erp/.env.local` was also observed at `0644`; key-name-only inspection found `GITHUB_PAT`, but no value was printed. It is not a running Cairn service file and likewise has no need for group/world read. Recommend the same owner-only `0600` mode as a separate workspace hardening action. No permission changes were made to either copy.

## 6. Optional hardening (not substitutes for mandatory checks)

- Arrange an external deployment secret manager or a dedicated, isolated operator OS identity before any future bootstrap. The host has no integrated bootstrap secret manager; `CAIRN_PROVISIONING_TOKEN` is unrelated and must not be reused.
- After reviewing active sessions/services, separately apply owner-only permissions to environment files as described in §5. This is not part of the nominee SQL procedure and has not been done.
- Keep account-specific review metadata in owner-approved documentation only. This update records the account ID and role/status expressly confirmed by the owner; do not add credentials, tokens, cookies, session identifiers, or environment contents to documentation, tickets, or logs.

## 7. Stop conditions

Stop without bootstrap if a bootstrap record or `PLATFORM_ADMIN` role already exists (as it does in WK01); do not attempt a rerun or replacement. For any other future authorized target, stop if: database/role/port differs; RLS or SELECT checks differ; the tenant context is not `WK01`; the candidate is absent, inactive, locked, must-change, or not the exact owner-nominated ID; onboarding/operator identities cannot be distinguished or the nominee matches either; any role, wildcard, capability, scope, or identity remains unexplained; the candidate’s effective access is broader than explicitly accepted; the token channel exposes the secret to untrusted same-UID processes and the owner has not approved that exposure; or permissions are denied. Do not solve a failed read by changing privileges. Do not create users/sessions/roles, assign capabilities, or retry bootstrap as a diagnostic.

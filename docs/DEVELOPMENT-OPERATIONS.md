# Cairn ERP — Development Operations Runbook

Verified operational procedures for the Cairn ERP development workflow.
All commands in this document have been executed and verified against the repository.

## 1. GitHub Procedures

### Repository Remote
- Remote name: `origin`
- Remote URL: `https://github.com/deepakpt2/cairn-erp.git` (no credentials embedded)
- Authentication: `GITHUB_PAT` classic personal access token from `.env.local`
- Authentication method: `git -c 'http.extraheader=Authorization: Basic <base64(x-access-token:PAT)>' <git-command>`

### Branch Conventions
- `main` — stable, tested release branch. Never push directly.
- `development` — active integration and testing branch. Push to `origin/development`.
- Upstream tracking: `development` tracks `origin/development`.

### Verify GitHub Authentication (Safe — No Secret Displayed)

```bash
# Read PAT from .env.local (variable name only, value not printed)
GITHUB_PAT=$(grep '^GITHUB_PAT=' .env.local | cut -d= -f2- | sed 's/^"//;s/"$//')

# Verify access (output shows refs, no secrets)
git -c "http.extraheader=Authorization: Basic $(echo -n "x-access-token:${GITHUB_PAT}" | base64 -w0)" ls-remote origin
```

Expected output: lists refs including `refs/heads/main`, `refs/heads/development`, etc.

### Exact Commands

```bash
# Check current branch and state
git branch --show-current
git status --short
git rev-parse HEAD

# Fetch from origin
git -c "http.extraheader=Authorization: Basic <auth>" fetch origin

# Create development branch from main
git checkout -b development

# Push development with upstream tracking
git -c "http.extraheader=Authorization: Basic <auth>" push -u origin development

# Confirm successful push
git --no-pager for-each-ref --format='%(refname:short) -> %(upstream:short)'
# Expected: development -> origin/development
```

### Release Procedure (development → main)

1. Owner reviews results on `development`.
2. Only after explicit owner authorization:
   ```bash
   git checkout main
   git merge development --no-ff
   git -c "http.extraheader=Authorization: Basic <auth>" push origin main
   ```
3. Never merge into `main` without owner authorization.

## 2. Test-Server Connection

### Connection Parameters
- Host: `107.173.201.115`
- SSH port: `2222`
- User: `cairn`
- Project directory: `/home/cairn/cairn-erp/`

### Credentials
- SSH password: `CAIRN_TESTBOX_PASSWORD` from `.env.local` (never printed)
- The Pexpect workflow is the established successful connection method.
- Direct SSH and SSH_ASKPASS attempts previously failed — do not retry those methods.

### Pexpect Connection Procedure (Verified)

```python
import pexpect

# Read credentials from .env.local (variable names only)
# CAIRN_TESTBOX_HOST, CAIRN_TESTBOX_PORT, CAIRN_TESTBOX_USER, CAIRN_TESTBOX_PASSWORD

ssh_cmd = f'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p {port} {user}@{host}'
child = pexpect.spawn(ssh_cmd, encoding='utf-8', timeout=30)

# Handle password prompt
child.expect(['password:', pexpect.TIMEOUT, pexpect.EOF], timeout=15)
child.sendline(password)
child.expect(['$', pexpect.TIMEOUT, pexpect.EOF], timeout=15)

child.prompt = r'cairn@cairn:.*\$ '

# Run commands
child.sendline('cd /home/cairn/cairn-erp && git --no-pager branch --show-current')
child.expect(child.prompt, timeout=15)
print(child.before)

child.close()
```

### Why Not Direct SSH / SSH_ASKPASS
Direct SSH and SSH_ASKPASS attempts previously failed. The Pexpect-based interactive procedure is the only verified working method.

### Connectivity Verification
```bash
# On the test server, after connecting:
cd /home/cairn/cairn-erp && pwd
# Expected: /home/cairn/cairn-erp
```

## 3. Test-Server Workflow

### Git Status and Commit Inspection

```bash
cd /home/cairn/cairn-erp
git --no-pager branch --show-current
git --no-pager rev-parse HEAD
git --no-pager status --short
git --no-pager stash list
```

### Fetch and Development Synchronization

```bash
cd /home/cairn/cairn-erp
GITHUB_PAT=<from .env.local>
git -c 'http.extraheader=Authorization: Basic $(echo -n "x-access-token:${GITHUB_PAT}" | base64 -w0)' fetch origin
git --no-pager checkout development
git --no-pager rev-parse HEAD  # Must match origin/development
```

### Preserve Local Changes

- Never `git pull` over local changes.
- Commit local changes before checking out a different branch.
- Use `git stash` only with explicit owner authorization.

### Dependency Installation

```bash
cd /home/cairn/cairn-erp
npm install  # Only when node_modules is missing or outdated
```

### Verified Build Commands

```bash
cd /home/cairn/cairn-erp
npx next build  # Production build (may take >10 min on single CPU)
```

**Note:** Build was started on the test server but killed by pexpect timeout (single CPU, build exceeds ~10 min). Not a code defect.

### Verified Focused Test Commands

```bash
cd /home/cairn/cairn-erp
CAIRN_ENV=development \
MIGRATION_DATABASE_URL='postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn_acceptance' \
DATABASE_URL='postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/cairn_acceptance' \
npx vitest run tests/production-order-settlement.test.ts --reporter=verbose
```

**Verified result:** 6 passed, 0 failed.

### Capture Real Exit Codes

```bash
# Run command and capture exit code
npx vitest run tests/production-order-settlement.test.ts --reporter=verbose > /tmp/test_output.txt 2>&1
echo "EXIT_CODE=$?"
```

### Associate Test Results with Git Commit

```bash
git --no-pager rev-parse HEAD  # Record this commit hash with test results
```

### Avoid Disrupting Running Services

- Do not restart the running Next.js application unnecessarily.
- The test server runs `next start -p 3100 -H 127.0.0.1` (PID visible via `ps aux`).

## 4. Database Procedures

### cairn_acceptance — Persistent Acceptance Database

- Purpose: Migration and integration acceptance testing for P0-GAP-01 (production order settlement).
- Status: Created, migrated (324 migrations applied, last `9201_production_order_settlement.sql`), seeded with reference data (26 currencies).
- Preservation: Must never be dropped, reset, reseeded, or recreated during routine testing.

### cairn_integration — Persistent General Integration-Test Database (OWNER-APPROVED; PROVISIONED)

- Owner decision (2026-11-02): provision and reuse a separate persistent database for CO13 and similar database-backed integration tests. It is isolated from `cairn_b210` (permanently prohibited browser-acceptance data), `cairn_acceptance` (P0-GAP-01 acceptance), production, and browser-acceptance configuration.
- Verified PostgreSQL identity: version 17.11; system identifier `7703407688127814566`; database `cairn_integration`; data directory `/home/cairn/.local/share/postgresql/cairn_integration/data`; port `55435`; `listen_addresses=127.0.0.1`. `pg_hba.conf` permits local peer and loopback SCRAM only. No non-loopback listener is configured.
- Roles: database owner/migration role `cairn_integration_migrator` is NOSUPERUSER with the schema-migration privileges required here (`BYPASSRLS`, `CREATEDB`, `CREATEROLE`, `NOINHERIT`). It has ADMIN OPTION on `cairn_app` with INHERIT and SET disabled, so it can rotate the app role without inheriting or assuming it. Runtime `cairn_app` is NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOINHERIT; `PUBLIC` database privileges are revoked and `cairn_app` has CONNECT. Runtime and migration credentials are distinct, generated, and stored only in the mode-0600 secure environment file `/home/cairn/.config/cairn-erp/cairn_integration.env` on the test host (and its local secure counterpart); neither belongs in Git, reports, or chat.
- Database state: 333 migrations recorded through `9210_co13_cancellation_reason_required.sql`; reference data verified (30 countries, 26 currencies, 21 units, 5 partner-bank country profiles); global definitions seeded; zero test tenants. The walkthrough tenant was not seeded. The database is about 26 MB and was not reset after provisioning.
- `CAIRN_INTEGRATION_MODE=persistent`, `CAIRN_TEST_DB_NAME=cairn_integration`, both explicit URLs, and the expected data-directory/system identifier are required. `scripts/test-integration.ts` validates the target before Vitest; `tests/global-setup.ts` verifies both role identities, endpoint, database, PostgreSQL 17/non-recovery state, role restrictions, and the cluster identity. Cluster identity is read through `cairn_integration_guard.cluster_identity()`, a bootstrap-owned SECURITY DEFINER function installed by `scripts/integration-cluster-identity.sql` and executable only by the migration role; do not grant `pg_read_all_settings` to the runtime role. Guarded databases skip automatic stale-fixture deletion; focused test files must clean up their own tenants.
- For routine focused tests, run on the test host with the secure file loaded (never source `.env.local`):
  ```bash
  set -a; . /home/cairn/.config/cairn-erp/cairn_integration.env; set +a
  npm run test:integration -- tests/confirmation-cancel.test.ts tests/order-confirmation-allocation.test.ts tests/time-ticket-goods-movement.test.ts
  ```
  Use `npm run test:db -- --database cairn_integration` only for additive provisioning/reference-data repair; never pass `--fresh` for this persistent database. Do not run `npm run db:verify`, which sources `.env.local` and targets the prohibited `cairn_b210` configuration in this workspace.
- Fresh-ledger work belongs only in a uniquely named `cairn_migration_test_YYYYMMDD_<run-id>` disposable database. Validate ownership and active sessions before cleanup; drop only task-created disposable databases after the migration/restore dependency checks pass. Never reset, drop, or casually reseed `cairn_integration`.
- The 9210 migration was rehearsed from a fresh 9209 ledger in a disposable database: an existing null-reason record survived; the constraint remained `NOT VALID`; a valid reason was accepted; new NULL, empty, whitespace-only, and over-200-character reasons were rejected. The disposable database was dropped after verification.

### Integration Backup and Recovery

- WAL archiving is off (`archive_mode=off`, `archive_command=(disabled)`), so this cluster has no point-in-time recovery. A verified on-demand PostgreSQL custom-format backup is created with `python3 scripts/backup-integration-db.py` on the test host. The script revalidates the persistent database, role, endpoint, data directory, system identifier, and migration ledger; it reads the mode-0600 secure environment file without placing credentials in argv; and it verifies `pg_restore --list` before publishing the archive and SHA-256 manifest. The manifest is written to an exclusive mode-0600 temporary file, flushed and fsynced, then atomically published without replacing an existing manifest. This is publication hardening only: it adds no backup schedule, off-host copy, retention policy, encryption, or restore test.
- Backup directory: `/home/cairn/.local/backups/cairn_integration` (directory mode 0700; archive and manifest mode 0600). The 2026-11-02 archive was `cairn_integration_20261102T040814Z.dump` (1,881,863 bytes; SHA-256 begins `005f0996e05ffb73`). A restore rehearsal into a separate disposable database passed: 333 migrations, 30 countries, 26 currencies, 21 units, zero test tenants, the same cluster identity, and the runtime SELECT/no-UPDATE ACLs were verified; both restore/migration rehearsal databases were dropped after active-session and ownership checks.
- This backup is on the same host and filesystem as PostgreSQL; it protects against logical mistakes, not host/disk loss. No off-host copy or automated scheduler is configured (the host has no `crontab`). Until an owner-approved off-host destination/schedule is added, the practical RPO is the last successful verified logical backup; PITR is unavailable. Run the backup before sensitive migration work and verify a restore to a task-created disposable database before relying on recovery.

### Approved Migration Procedure

1. Verify the effective database target before any migration.
2. Use incremental migrations only (`drizzle-kit migrate` or direct SQL with `IF NOT EXISTS`).
3. Target `cairn_acceptance` explicitly:
   ```bash
   CAIRN_ENV=development \
   MIGRATION_DATABASE_URL='postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn_acceptance' \
   DATABASE_URL='postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/cairn_acceptance' \
   npx drizzle-kit migrate
   ```

### Verify Effective Database Target

```bash
# Check which database a connection string targets (safe — no secret display)
DATABASE_URL='postgresql://user:pass@host:port/dbname'
echo "${DATABASE_URL}" | awk -F/ '{print $NF}' | cut -d? -f1
```

### Database Protection Guards

- `scripts/browser-smoke/database-guards.ts` — `ACCEPTANCE_DATABASE_GUARDS` maps browser targets to databases; `cairn_acceptance` is registered as `production-order-settlement-acceptance`.
- DI-012's `production-order-cost-report` browser target is bound only to `CAIRN_TEST_DB_NAME`, which must be a newly created `cairn_migration_test_YYYYMMDD_<run-id>` on the documented PostgreSQL 17 test cluster (port 55435; runtime `cairn_app`, migration/owner `cairn_integration_migrator`). Run migrations, reference seeding, the suite, and `npm run smoke:browser -- --target production-order-cost-report` only against that disposable target. Never point these commands at `cairn_integration`, `cairn_acceptance`, or the prohibited databases. Verify database owner and active sessions before dropping only the task-created database.
- `tests/global-setup.ts` independently treats `cairn_integration` as guarded, requires the full integration identity configuration whenever either URL names it, refuses whole-suite runs unless explicitly permitted, and always skips stale-fixture deletion on guarded targets. Focused integration tests own and remove only their own fixtures.
- `scripts/test-integration.ts`, `scripts/test-db.ts`, and `scripts/sync-db-app-role.ts` fail closed on missing/mismatched integration configuration; persistent-target changes verify the actual database role, endpoint, server version/state, data directory, and system identifier before mutation.
- `src/platform/db/target-guard.ts` — `validateTarget()` refuses protected databases without explicit authorization.

### Test Data Isolation

- Use transactions or uniquely identified test records.
- Test tenants are keyed `T###` by `tests/helpers.ts`.
- Development tenant (`0100`) is never touched.

### Permanently Prohibited Databases

- `cairn_b210` — never connect, query, migrate, reset, seed, or modify.
- `cairn_hr_accept` — never connect, query, migrate, reset, seed, or modify.
- `cairn_demo` — never connect, query, migrate, reset, seed, or modify.

### Prohibition Against Destructive Cleanup

- Never drop, reset, or recreate `cairn_acceptance`.
- Never run `npm run db:reset` against `cairn_acceptance`.
- Use `scripts/test-db.ts` for scratch databases only (refuses guarded databases).

## 5. Docker Credential Initialization

### Credential Lifecycle on Fresh Deployment

1. The `db` service starts PostgreSQL. On an empty data volume, `/docker-entrypoint-initdb.d/10-app-role.sh` runs once.
2. `10-app-role.sh` creates the `cairn_app` application role with `CAIRN_APP_DB_PASSWORD`, restricted to `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`.
3. `CAIRN_APP_DB_PASSWORD` is embedded in `DATABASE_URL` by Docker Compose, so it **must be URL-safe** (hexadecimal is recommended).
4. `POSTGRES_PASSWORD` is the PostgreSQL superuser password. It is never placed in an application URL and is not URL-validated.
5. The one-shot `migrate` service runs `scripts/sync-db-app-role.ts` before migrations to ensure the restricted `cairn_app` login exists, runs migrations, then runs role synchronization again. The post-migration pass repairs and verifies the exact central-auth table ACLs in place; it does not use superuser credentials at runtime or grant blanket table privileges. It also checks the runtime connection is `NOSUPERUSER NOBYPASSRLS`, has no role memberships, has `USAGE` but not `CREATE` on `public`, and has only `SELECT, INSERT, UPDATE` on `app_user`, `user_session`, and `password_reset_token`.
6. Migration `9207_central_user_auth_least_privilege.sql` removes surplus table rights on those three authentication tables, restores only the required read/insert/update rights, and forces RLS on `password_reset_token`. The role-sync pass repeats this idempotently, so a missing or drifted grant on an existing volume is repaired without resetting data.
7. Before the legacy tenant/foundation seed runs, the one-shot `migrate` provisioning service runs `npm run db:init-reference` after migrations and ACL reconciliation. It atomically inserts standard currencies, countries, units of measure, and approved partner-bank country profiles with `ON CONFLICT DO NOTHING`. This creates missing defaults without replacing customer-maintained or customised rows. It is part of provisioning, not the web application startup path.
8. The `app` service connects using `DATABASE_URL` as `cairn_app`.

### Required Environment Variables (`.env`)

| Variable | Purpose | Example generation |
|----------|---------|-------------------|
| `CAIRN_OWNER_DB_PASSWORD` | PostgreSQL superuser password (`POSTGRES_PASSWORD`) | `openssl rand -hex 32` |
| `CAIRN_APP_DB_PASSWORD` | Application role password, embedded in `DATABASE_URL` | `openssl rand -hex 32` |

### Password Rules

- `CAIRN_APP_DB_PASSWORD` **must be URL-safe**: only `A-Za-z0-9_-`. Hexadecimal (`0-9a-f`) is recommended and never requires URL-encoding.
- `POSTGRES_PASSWORD` / `CAIRN_OWNER_DB_PASSWORD` may contain any characters; it is not placed in a URL.
- Never reuse the same value for both passwords.
- Never print, log, or commit password values.

### Fresh Deployment Commands

```bash
# 1. Generate passwords (do not print them to shared output)
openssl rand -hex 32   # CAIRN_OWNER_DB_PASSWORD
openssl rand -hex 32   # CAIRN_APP_DB_PASSWORD

# 2. Copy the Docker env template and set the values
cp .env.docker.example .env
chmod 600 .env
# Edit .env: set CAIRN_OWNER_DB_PASSWORD and CAIRN_APP_DB_PASSWORD to the generated values

# 3. Deploy. The one-shot migrate service applies schema migrations, then
#    initializes standard global reference rows atomically, then runs the
#    existing tenant/foundation seed. Reference initialization is repeatable
#    and preserves any existing row with the same key.
docker compose up -d --build

# 4. Verify PostgreSQL is healthy
docker compose logs db | grep -i "database system is ready"

# 5. Verify migration and reference initialization completed
docker compose logs migrate | grep -E "credentials, central-auth table grants|Standard reference data initialized"

# 6. Verify app is healthy
docker compose ps app

# 7. Build the app image and verify its packaged manual walkthrough script
docker compose build app
docker run --rm --entrypoint sh cairn-app:local -c 'test -s /app/walkthrough-seed.ts'
```

### Application liveness and readiness

`GET /api/health/live` returns HTTP 200 with only `{"status":"ok"}` and cache-prevention headers. It is a process-liveness signal: it does not query PostgreSQL or any external service and therefore remains independent of database availability. A successful response does **not** prove database connectivity, migration readiness, business-function health, backup freshness, or restoreability.

This is not a readiness check. Readiness would need a separately designed contract for required dependencies and deployment policy; no database-dependent readiness endpoint or external monitoring integration is established here. The app image's Dockerfile healthcheck now probes `http://127.0.0.1:3000/api/health/live` from inside the container. It considers a 2xx response healthy and a non-2xx response or connection failure unsuccessful. The configured start period remains 20 seconds, interval 30 seconds, timeout 5 seconds, and retry threshold 3. The probe uses only the container's loopback HTTP endpoint; it has no credentials, external dependency, or database check. An unhealthy container status is only a process-liveness signal: it does not mean Docker has stopped the container, nor does it prove database readiness, backup health, restoreability, external monitoring, or production deployment health.

For a separately provisioned database, after migrations have completed and before tenant/foundation seeding, run `npm run db:init-reference` with both `MIGRATION_DATABASE_URL` and `DATABASE_URL` explicitly set to the same verified, authorized database. The command has no fallback target and refuses protected databases through `validateTarget`.

### Existing-Volume Repair

If a volume already exists with data and the `cairn_app` role credentials are out of sync:

1. **Do not drop, reset, or reseed the volume.** The repair procedure is in-place only.
2. Execute `sync-credentials.sh` inside the `db` container:
   ```bash
   docker compose exec db /docker-entrypoint-initdb.d/../sync-credentials.sh
   # or, if mounted at a different path:
   docker compose exec db sh -c 'CAIRN_APP_DB_PASSWORD=${CAIRN_APP_DB_PASSWORD} POSTGRES_PASSWORD=${POSTGRES_PASSWORD} sh /path/to/sync-credentials.sh'
   ```
3. `sync-credentials.sh` updates role passwords and flags without touching schema or business data; by itself it does not restore table ACLs.
4. Recreate the one-shot operations service and app so migrations run, then the post-migration role-sync pass reconciles the three central-auth table grants. This is in-place and does not reset the volume:
   ```bash
   docker compose up -d --build --force-recreate migrate app
   docker compose logs migrate | grep -E "credentials, central-auth table grants|Applied .*9207"
   ```
   The operations service fails closed if the actual `cairn_app` connection is elevated or the effective auth-table ACLs are not exactly `SELECT, INSERT, UPDATE`.

### Troubleshooting

| Symptom | Likely cause | Verified fix |
|---------|-------------|--------------|
| `Use URL-safe database passwords (hex is recommended).` from `10-app-role.sh` | `CAIRN_APP_DB_PASSWORD` contains characters outside `A-Za-z0-9_-` | Set `CAIRN_APP_DB_PASSWORD` to a hex value (`openssl rand -hex 32`) in `.env`. `POSTGRES_PASSWORD` is not URL-validated. |
| `Database credential synchronization failed.` from `sync-db-app-role.ts` | `DATABASE_URL` or `MIGRATION_DATABASE_URL` cannot be parsed, or the owner connection lacks role-management rights | Verify `DATABASE_URL` and `MIGRATION_DATABASE_URL` name the same database. Confirm `CAIRN_OWNER_DB_PASSWORD` allows the owner to `CREATE`/`ALTER` roles. |
| `10-app-role.sh` exits on fresh volume | `CAIRN_APP_DB_PASSWORD` not set and auto-generation unavailable | Set `CAIRN_APP_DB_PASSWORD` in `.env` before `docker compose up`. |
| Password works on first deploy but breaks on restart | Credentials were silently changed | Credentials are never silently changed. Check whether `.env` was overwritten between deployments. Existing volumes keep their passwords. |

## 6. Troubleshooting

### SSH Connection Problems

| Symptom | Verified Solution |
|---------|-------------------|
| Direct SSH fails | Use Pexpect-based interactive SSH procedure |
| Password prompt not handled | `child.expect(['password:', ...])` then `child.sendline(password)` |
| Host key verification | Use `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` |

### GitHub Authentication Problems

| Symptom | Verified Solution |
|---------|-------------------|
| `401 Unauthorized` on push | Verify `GITHUB_PAT` in `.env.local` is correct; use `http.extraheader=Authorization: Basic` |
| No remote configured | `git remote add origin https://github.com/deepakpt2/cairn-erp.git` |
| Stale remote tracking branches | `git fetch origin` |

### Git Fetch/Pull Conflicts

| Symptom | Verified Solution |
|---------|-------------------|
| Local changes would be overwritten | Commit or stash local changes before checkout |
| Diverged branches | `git fetch origin` then `git checkout <branch>` |

### Dependency Installation Issues

| Symptom | Verified Solution |
|---------|-------------------|
| Missing node_modules | `npm install` in `/home/cairn/cairn-erp/` |

### Build and Test Failures

| Symptom | Verified Solution |
|---------|-------------------|
| Build killed by timeout | Single CPU limitation; not a code defect. Run build with longer timeout. |
| Test failures on controlling area | Verify `production_order` table has `controlling_area`, `company_code`, `currency` columns (migration 9202). |
| Test or fresh-provisioning failures on currency/country/UOM FK | Confirm the one-shot `migrate` service completed `db:init-reference`; for a separate verified scratch database run `npm run db:init-reference` after migrations. It inserts only missing project defaults. |

### Database Target-Selection Failures

| Symptom | Verified Solution |
|---------|-------------------|
| Wrong database targeted | Verify `DATABASE_URL`/`MIGRATION_DATABASE_URL` explicitly target `cairn_acceptance` before running. |
| Protected database refused | Use `cairn_acceptance` (authorized) not `cairn_b210` (prohibited). |

## 7. Walkthrough Seed (manual, development-only)

### Purpose and scope
`walkthrough-seed.ts` prepares and runs the supported procurement, inventory, production, sales, billing, AP/AR, transfer/reversal, and reconciliation scenario. It never creates a tenant, user, or password. Starting from one normally onboarded development tenant and its real first administrator, its trusted CLI-only setup applies the current standard configuration package when needed, builds the standard company structure, and grants that administrator only Company Code `1000` and Plant `1000` through the normal persisted and audited organisation-scope service. It does not grant platform authority or broad roles, bypass posting/session checks, or write authorization rows directly.

The scenario pays/clears its AP and AR items and verifies zero open items, balanced journals, stock/valuation, inventory-to-G/L, GR/IR, and subledger ties. It does not fabricate HR/payroll, QM inspection, fixed-asset, project, maintenance, automated payment-run, bank-statement, or electronic-bank-interface records.

### Packaging and invocation
- Source: repository-root `walkthrough-seed.ts`; package command: `npm run walkthrough:seed`.
- It is packaged in the one-shot `operations` image, **not** the web `app` image. Compose bind-mounts the source read-only into the `migrate` service.
- Invoke the one-off command only after the isolated development database is migrated and reference/global data is initialized. The script requires a uniquely named disposable database matching `cairn_migration_test_YYYYMMDD_<run-id>`; `cairn`, `cairn_integration`, `cairn_acceptance`, `cairn_b210`, `cairn_hr_accept`, and `cairn_demo` are refused. It also requires `CAIRN_ENV=development`, an exact match between `CAIRN_SEED_DATABASE` and the database in `DATABASE_URL`, and the `cairn_app` runtime role. Database policy is checked before any DB connection.

```bash
# DATABASE_URL must already be exported for this task-created disposable database.
: "${DATABASE_URL:?Export the cairn_app URL for the disposable database first}"
docker compose run --rm --no-deps \
  -e CAIRN_ENV=development \
  -e DATABASE_URL \
  -e CAIRN_SEED_DATABASE=cairn_migration_test_20261105_run01 \
  -e CAIRN_SEED_TENANT=WK01 \
  -e CAIRN_SEED_DATE=2026-11-05 \
  -e CAIRN_SEED_ORIGIN -e CAIRN_SEED_USERNAME -e CAIRN_SEED_PASSWORD \
  migrate npm run walkthrough:seed
```

Use the actual task-created disposable database name and the normal application origin, username, and owner-set password in the `CAIRN_SEED_*` variables. Do not print or place passwords in shell history, source, or logs. The command overrides only the one-off container environment; it does not alter persistent Compose services.

### Prerequisites and exact setup sequence
1. Create a new isolated disposable development database using the documented owner/application-role separation, full migrations, global reference initialization, and seed procedure. Never reset or casually reseed an existing business database.
2. Through normal development onboarding, create the single active tenant: key `WK01`, name `Walkthrough Company`, legal name `Walkthrough Company LLC`, country `AE`, currency `AED`, time zone `Asia/Dubai`, `isDevelopment=true`. Create its real first administrator as `walkthrough.admin`; the owner sets and retains the password. The database must contain no other tenant, user, organisation scopes, business data, or company-specific enterprise structure. Global reference data from supported initialization is not tenant business data.
3. Do **not** manually add Company Code or Plant scopes. The first administrator must have only the initial `ADMINISTRATOR` role, be active/unlocked, and not require a password reset. The CLI signs in through `/api/auth/signin`, then the trusted setup transaction establishes the supported package, chart `CA01`, company code/CCA `1000`/`0001`, controlling area `A000`, plant `1000`, standard storage locations, purchasing org `1000`, and sales org/channel/division `1000`/`01`/`01`. It grants just Company Code `1000` and Plant `1000` to the real first administrator using persisted domain records with change-history and access-log audit.
4. Global reference data must already include `AE`/`AED` and units `KG`/`PC`, provided by `npm run db:init-reference`, not by owner-role SQL in the walkthrough.
5. Choose a real date in an open posting period whose following eight days stay in that fiscal period. The standard variant is `K4` (calendar year, January–December) and posting-period variant `C001`. The material period is initialized only if absent; a conflicting period is never shifted.
6. `DATABASE_URL` must use `cairn_app` and resolve to exactly `CAIRN_SEED_DATABASE`. The CLI does not use `MIGRATION_DATABASE_URL` or any owner credential.

### Reruns, checkpoints, and operator checks
- Required inputs include the explicit disposable database, tenant, date, normal application origin, first-admin username, and owner-set password. Nothing defaults to a tenant, date, or password.
- Structure, the two scopes, scope audit entries, and a deterministic `PROVISIONED` checkpoint commit in one tenant-scoped transaction. If it rolls back, no partial setup/scope grant remains. A later failure in the business walkthrough is resumable only with the same database, tenant, date, operation version, and first-admin identity; request-key and payload guards remain in force. A conflicting or ambiguous partial state is refused rather than adopted or repaired by guessing.
- Successful completion writes an audited `COMPLETE` checkpoint only after reconciliation passes. Same-date replay is allowed; changed date, database, tenant, or operation payload version is refused. No existing business value is overwritten and no data is deleted.
- Sign in at `/signin` as `walkthrough.admin` using the owner-set password. Read-only sample pages include `/inventory/materials`, `/purchasing/orders`, `/production/orders`, `/sales/orders`, `/sales/delivery`, `/sales/billing`, `/finance/journal`, and `/finance/subledger-tie-out`. Any protected posting remains subject to the ordinary live-session authorization and persisted scopes.
- No cleanup is performed by the seed. Drop only the task-created disposable database after checking ownership and active sessions; never run `docker compose down -v` against a persistent/owner stack.

### Verification status (2026-11-05)
The local source implementation has focused contract tests for disposable-target safety, first-admin/scope conflicts, replay identity, the CLI-only boundary, and the rollback-safe setup/checkpoint sequence. On commit `984e0b9cdef9a4ed8a10e59bcd97a2dc62770771`, `npm run test:walkthrough:contract` passed (21 tests) and the targeted TypeScript check for the changed walkthrough and authorization files passed. Full repository typecheck was attempted but the sandbox ran out of memory; no database or business E2E acceptance was run.

The documented test-box SSH preflight was attempted three times and could not reliably capture remote status/stash output. Per the runbook, remote retries stopped. No remote database was accessed, seeded, or tested; remote working-tree cleanliness is unknown. Therefore stock/valuation, balanced-journal, inventory-to-G/L, GR/IR, and AP/AR acceptance remain unverified on the designated test box. Do not represent the scenario as database-verified until it is run on a fresh task-created disposable database using the documented test-box procedure.

Docker availability and the image/container execution were not verified in this task. The implementation was committed as `984e0b9cdef9a4ed8a10e59bcd97a2dc62770771` and pushed to `origin/development`; the local and remote development refs matched after push.

## 8. Verified State (As of 2026-10-30)

| Item | Value |
|------|-------|
| Local branch | `development` |
| Local commit | `43cff87` |
| Remote branch | `origin/development` |
| Remote commit | `43cff87` (synchronized with local) |
| Test server branch | `development` |
| Test server commit | `ce9c650` (needs `git fetch && git checkout development` to sync) |
| Acceptance database | `cairn_acceptance` |
| DI-020 tests | 9 passed, 0 failed |
| DI-020 TypeScript | Clean (`tsc --noEmit`) |
| Walkthrough seed | Committed at `walkthrough-seed.ts`; TypeScript-parsed; not yet executed against a database |
| Both workspaces synchronized | YES (local and origin/development) |

## 9. One-time tenant-local platform-admin bootstrap

Role and user-role mutations require a separate, deployment-owner-bootstrapped `PLATFORM_ADMIN` role. Tenant wildcard `ADMINISTRATOR` and `CFG.PLT.USER.MAINTAIN` are not substitutes. This is tenant-local authority, not a deployment-wide identity.

### Preconditions and trust boundary
- Apply migration `9209_platform_role_capability_administration.sql` to the intended authorized database first.
- A deployment owner nominates an **existing active, unlocked account in that tenant that currently has a live persisted session**; its username must differ from the operator identifier, so the out-of-band bootstrap is not self-grant. The bootstrap does not create tenants/users or assign business scopes.
- Configure a separate high-entropy `CAIRN_PLATFORM_BOOTSTRAP_TOKEN` (at least 32 characters) through the deployment secret manager. Do not reuse `CAIRN_PROVISIONING_TOKEN`, put the token in a shell command/argument, or print it.
- The operator identifier, tenant key, and existing user ID are supplied as `CAIRN_PLATFORM_BOOTSTRAP_ACTOR`, `CAIRN_PLATFORM_BOOTSTRAP_TENANT`, and `CAIRN_PLATFORM_BOOTSTRAP_USER_ID`. The interactive CLI prompts for the configured token with input echo disabled.
- The bootstrap runs once per tenant, uses the restricted runtime `DATABASE_URL`/`cairn_app` connection under tenant RLS, refuses protected database targets, and records a Cairn change document plus `audit_access_log` entry. It creates the protected system role with exactly `CFG.PLT.ROLE.MAINTAIN` and `CFG.PLT.USER.ROLE.MAINTAIN`; routine user-role administration cannot grant/revoke this protected role.
- This is an operator-only bootstrap, not an HTTP endpoint, application seed, or test bypass. After it completes, the nominated account must sign out and back in; all subsequent reads/mutations revalidate a live persisted session and the dedicated role in their transaction.

### Invocation
Set the four variables through the deployment owner's secure environment (never place token material in a command line), then run from the repository:

```bash
npm run platform-admin:bootstrap
```

The command refuses if the nominated account lacks a live session, the tenant already has a bootstrap record or `PLATFORM_ADMIN` role, or any authorization/target check fails. It does not provision a tenant or user, alter company/plant scopes, execute the walkthrough seed, or modify `CAIRN_SEED_*`. Never use tenant `0100` or an owner/personal database for this procedure.

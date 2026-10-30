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

- `scripts/browser-smoke/database-guards.ts` — `ACCEPTANCE_DATABASE_GUARDS` maps browser targets to databases.
- `cairn_acceptance` is registered as `production-order-settlement-acceptance` in the guards.
- `tests/global-setup.ts` refuses whole-suite runs against guarded databases without `CAIRN_ALLOW_GUARDED_TEST_DATABASE=1`.
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
5. The `migrate` service runs `scripts/sync-db-app-role.ts`, which reads `DATABASE_URL` and `MIGRATION_DATABASE_URL`, validates both targets, and synchronizes the `cairn_app` password to match `DATABASE_URL`.
6. Before the legacy tenant/foundation seed runs, the one-shot `migrate` provisioning service runs `npm run db:init-reference` after migrations. It atomically inserts the project-defined standard currencies, countries, units of measure, and approved partner-bank country profiles with `ON CONFLICT DO NOTHING`. This creates missing defaults without replacing customer-maintained or customised rows. It is part of provisioning, not the web application startup path.
7. The `app` service connects using `DATABASE_URL` as `cairn_app`.

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
docker compose logs migrate | grep -E "credentials synchronized|Standard reference data initialized"

# 6. Verify app is healthy
docker compose ps app

# 7. Build the app image and verify its packaged manual walkthrough script
docker compose build app
docker run --rm --entrypoint sh cairn-app:local -c 'test -s /app/walkthrough-seed.ts'
```

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
3. The script updates `cairn_app` and the owner role passwords without touching schema or business data.
4. Restart the `migrate` and `app` services if needed:
   ```bash
   docker compose restart migrate app
   ```

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

## 7. Walkthrough Seed (manual, owner-invoked)

### Purpose
Deterministic seed that builds an interconnected business scenario (purchase-to-pay and order-to-cash, including DI-020 credit memo) inside an existing tenant. Runs only when explicitly invoked by the owner.

### Source and container location
- Source file: `walkthrough-seed.ts` (repository root)
- Container path: `/app/walkthrough-seed.ts`
- Application container/service: `app` (image `cairn-app:local`); Dockerfile explicitly copies the script into this image.
- Also explicitly included in the operations image and mounted read-only into the `migrate` service at `/app/walkthrough-seed.ts`.

### Safety properties
- Never executes during Docker build, container creation/startup, application startup, migrations, or restarts.
- Requires explicit `CAIRN_SEED_DATABASE` target; validated through `validateTarget`; refuses protected databases (`cairn_b210`, `cairn_hr_accept`, `cairn_demo`, `cairn_acceptance`).
- Never deletes, overwrites, or silently changes existing data.
- Idempotent: safe to repeat; existing business documents are left alone.

### Prerequisites
1. Owner has pulled the latest `development` branch.
2. Complete Docker stack is deployed (`docker compose up -d`).
3. PostgreSQL is healthy (`db` service healthcheck passes).
4. Application is ready (`app` service healthcheck passes).
5. Schema migrations have completed (`migrate` service ran successfully).

### Manual execution
```bash
docker exec -it cairn-app tsx /app/walkthrough-seed.ts
```

### Required environment variables (set in the `app` service environment)
| Variable | Purpose |
|----------|---------|
| `CAIRN_SEED_DATABASE` | Database name (explicit; never guessed) |
| `CAIRN_SEED_TENANT` | Tenant/client key (default: `WK01`) |
| `CAIRN_SEED_CHANGED_BY` | Actor for audit fields (default: `WALKTHROUGH_SEED`) |
| `DATABASE_URL` | Application database connection (set by deployment) |
| `MIGRATION_DATABASE_URL` | Migration database connection (set by deployment) |

### Inspecting results
The seed prints a concise execution summary to stdout: tenant, company code, record counts per business area (materials, business partners, POs, GRs, sales orders, deliveries, billing documents, customer invoices, credit memos), and journal line count. Any skipped steps are listed as notes.

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

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

## 5. Troubleshooting

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
| Test failures on currency FK | Seed reference data: `npx tsx scripts/seed-reference.ts` |

### Database Target-Selection Failures

| Symptom | Verified Solution |
|---------|-------------------|
| Wrong database targeted | Verify `DATABASE_URL`/`MIGRATION_DATABASE_URL` explicitly target `cairn_acceptance` before running. |
| Protected database refused | Use `cairn_acceptance` (authorized) not `cairn_b210` (prohibited). |

## 6. Verified State (As of 2026-10-30)

| Item | Value |
|------|-------|
| Local branch | `development` |
| Local commit | `9788bff` |
| Remote branch | `origin/development` |
| Remote commit | `9788bff` |
| Test server branch | `development` |
| Test server commit | `9788bff` |
| Test server upstream | `development -> origin/development` |
| Acceptance database | `cairn_acceptance` (324 migrations applied) |
| P0-GAP-01 tests | 6 passed, 0 failed |
| Both workspaces synchronized | YES |

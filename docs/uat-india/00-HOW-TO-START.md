# How to start — the five commands

Everything a tester needs before opening `05-uat-guide.md`. Assumes a disposable database and
`CAIRN_ENV=development`.

---

## 0. Set the environment once

```bash
# A DISPOSABLE database. Never cairn_b210, cairn_hr_accept, cairn_demo,
# cairn_acceptance or cairn_integration.
export DB=cairn_in01_work

export DATABASE_URL="postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/$DB"
export MIGRATION_DATABASE_URL="postgresql://cairn_integration_migrator:cairn_migrator_dev@127.0.0.1:5432/$DB"
export CAIRN_ENV=development
export CAIRN_DEMO_LOGIN_URL=http://localhost:3000
```

---

## 1. Create and prepare the database (first time only)

```bash
psql 'postgresql://cairn_integration_migrator:cairn_migrator_dev@127.0.0.1:5432/postgres' \
     -c "create database $DB owner cairn_integration_migrator"

npm run db:migrate
npm run db:init-reference
```

The reference seed is **not optional**: without it the company has no currency, country or unit
of measure and the first phase fails on a foreign key.

---

## 2. Reset (every re-run after a first install)

```bash
npx tsx scripts/in01-install.ts --reset-demo IN01 --confirm IN01
```

Notes:

- Both `IN01`s matter. The first names the company; the second is the confirmation you type.
- It refuses — and deletes nothing — if a tester has written anything, if a founder account has
  changed anything since the install completed, or if any document stands. That is the guard
  working, not a failure. The message says which row and which account.
- It is disabled outside `CAIRN_ENV=development`.
- If it refuses and you want to start over regardless, **drop the database and go back to step 1**.
  A reset is not the tool for that, deliberately.

---

## 3. Install to Phase 2

```bash
npx tsx scripts/in01-install.ts --until=phase2
```

Takes about a minute. It prints the account list as it finishes. To stop at an earlier phase:

```bash
npx tsx scripts/in01-install.ts --until=phase0    # organisation only
npx tsx scripts/in01-install.ts --until=phase1    # + people and accounts
```

Re-running the same `--until` is safe: every phase adopts what already stands and reports 0 new
objects.

---

## 4. Get the credentials

Two ways, same rows:

**The file** (mode 0600, the single source of truth for passwords):

```bash
cat credentials/demo-credentials.txt
```

**In the app** — start it and open the test-only view:

```bash
npm run dev            # http://localhost:3000
```

Then sign in as `in01.admin` and open:

```
http://localhost:3000/platform/users/test-credentials
```

That page returns **404 outside a development build**, by design. The ordinary user directory at
`/platform/users` never shows a password.

> **If the file is lost**, the passwords cannot be recovered — the database holds only a hash.
> Reset (step 2) and reinstall (step 3) to issue new ones.

---

## 5. Run the Phase 3 scenarios, in this order

The chains share stock, so the order matters. Later steps read what earlier ones left.

| # | Chain | Sign in as | Guide |
|---|---|---|---|
| 1 | **Procure to pay** — PR → PO → GR → invoice → payment | `in01.buyer`, then `in01.storekeeper`, then `in01.ap` | 3.1.1 → 3.1.6 |
| 2 | **Production** — MRP → order → issue → confirm → receipt | `in01.planner`, `in01.supervisor`, `in01.qc` | 3.2.1 → 3.2.5 |
| 3 | **Order to cash** — quotation → order → delivery → billing → payment | `in01.sales`, `in01.dispatch`, `in01.ar` | 3.3.1 → 3.3.6 |
| 4 | **Import** — USD purchase and export sale | `in01.buyer`, `in01.storekeeper`, `in01.ap` | 3.4 |
| 5 | **HR and payroll** — attendance, leave, run, post, pay | `in01.hr`, `in01.admin` | 3.5 |
| 6 | **Month-end close** — GR/IR, depreciation, accruals, allocation, statements, GST | `in01.controller`, `in01.ap` | 4.1 → 4.8 |
| 7 | **Reconciliation checklist** — the eleven checks | `in01.auditor` (read-only) | the checklist at the end |

### Why this order

- **P2P before production** so the raw-material receipt from 3.1.3 feeds the component issue in
  3.2.2. There is opening stock too, so production will not fail without it — but the numbers the
  guide quotes assume the receipt happened.
- **Production before O2C** so 3.2.4's finished goods are what 3.3.3 delivers. The distribution
  centre also has opening stock of finished racks, so a delivery works either way; the guide's
  figures assume the production receipt.
- **HR and payroll after the operational chains** so the cost centres carry the month's activity
  before payroll posts against them.
- **Close last**, and only when the checklist passes.

### Quick sanity check before you start

After step 3, sign in as `in01.admin` and confirm:

| Screen | Should show |
|---|---|
| `/config/company-codes` | Company code **`IN01`**, currency INR, fiscal year `A4` |
| `/config/plants` | Plants `1000` and `2000`, both assigned to `IN01` |
| `/people/employees` | **52** employees |
| `/inventory/materials` | **13** materials |
| `/platform/users` | **15** accounts |

If the company code is anything other than `IN01`, the fixtures and the installer are out of
step — that is a bug, not a setup problem.

---

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `Company code IN01 already exists` | Re-running Phase 0 without a reset | Expected; the phase adopts it. Ignore. |
| `Tenant IN01 does not exist` on reset | Already reset, or never installed | Nothing to reset. Go to step 3. |
| Reset refuses naming `IN01.BUYER` or similar | A tester signed in and changed data | Correct behaviour. Drop the database and go to step 1 if you want a clean slate. |
| Reset refuses naming `in01.admin` **after** the install | An administrator edited data by hand after setup | Same: drop and rebuild, or keep the data. |
| `relation ... does not exist` | Migrations not run | Step 1. |
| `Currency INR does not exist` | Reference seed not run | `npm run db:init-reference`. |
| Installer refuses `--with-transactions` | Phase 3 has no dataset yet (GAP D1) | Expected. Follow the guide by hand. |

---

# Self-hosted install (Docker, on your own server)

For running Phase 3 on a fresh machine, separate from the workbench. This section is **not**
a repeat of `docs/fresh-server-installation.md` — read that for the product's own install. This is
what is **different** when the purpose is the India UAT, and where the shipped Compose file does not
give you what you need out of the box.

> **Read §B before you plan the work.** Three things in the shipped `docker-compose.yml` prevent the
> credentials view and the demo reset from working at all, and one of them is a security decision
> you must make deliberately. I have not changed the Compose file — that is an application
> configuration change and needs your approval.

---

## A. Prerequisites, from an empty machine

| Requirement | Why | Check |
|---|---|---|
| Linux host, Docker Engine + Compose **v2** | `docker compose` (space, not `docker-compose`) | `docker compose version` |
| 2 CPU / 4 GB RAM / 20 GB disk | The Next.js build is the peak; PostgreSQL needs room | `nproc`, `free -g`, `df -h` |
| A DNS name and a reverse proxy on an external network named `proxy` | `docker-compose.yml` declares `proxy` as **external**; Compose refuses to start without it | `docker network inspect proxy` |
| Git + outbound internet | The images are built on the host | `git --version` |
| A TLS-terminating proxy | The app listens on `:3000` inside the network and is reached only through it | — |

```bash
docker compose version                     # must print v2.x
docker network inspect proxy >/dev/null 2>&1 \
  && echo "proxy network found" \
  || echo "STOP: create it, and attach a reverse proxy, before continuing"
```

If `proxy` is missing, `docker network create proxy` lets Compose start — it does **not** make the
site reachable. That needs a proxy attached to it.

## B. Three blockers in the shipped Compose file

These are facts about the code as it stands, not preferences. Each is verified below.

### B1 — `CAIRN_ENV=production` disables both features, and setting it to `development` is unsafe on a public host

`docker-compose.yml` sets `CAIRN_ENV: production` on **every** service (lines 47, 79, 126, 154).
Both features you want require `development`:

- `src/app/platform/users/test-credentials/page.tsx:73` — `if ((process.env.CAIRN_ENV ?? 'development') !== 'development') notFound();`
- `src/platform/tenancy/in01-reset.ts:84` — refuses when `CAIRN_ENV !== 'development'`

**The obvious fix is the dangerous one.** `CAIRN_ENV=development` does four more things, and two of
them remove authentication from pages that list every tenant on the host:

| File | Effect in `development` |
|---|---|
| `src/app/page.tsx:20` | `session = null` — the launchpad requires no sign-in |
| `src/app/clients/page.tsx:11` | `session = null` — the tenant list requires no sign-in |
| `src/app/clients/new/page.tsx:14` + `src/platform/tenancy/provisioning.ts:28,46` | Tenant creation is **not token-gated at all** — the form hides the token field *and* `assertProvisioningToken` returns early, server-side. Anyone who can reach the page can create a tenant. |
| `src/app/dev/kit/page.tsx:11` | The dev kit is reachable (404 in production) |

There is **no middleware** (`src/middleware.ts` absent; `src/app/layout.tsx` has no session gate),
so nothing else catches an anonymous request. `cairn_list_tenants()` is `SECURITY DEFINER` and
granted to `cairn_app` (`drizzle/0000_baseline.sql:31492`), so it returns every tenant to whoever
asks.

**Consequence: `CAIRN_ENV=development` on a publicly reachable host publishes your tenant list
anonymously.** For a test box on a private network that is acceptable; on a name the internet can
reach, it is not.

### B2 — the app container cannot see the credential file

`DEFAULT_CREDENTIALS_DIR = '/app/credentials'` (`src/platform/tenancy/demo-credentials.ts:29`). The
`migrate` service bind-mounts `./credentials:/app/credentials` (line 45). The **`app` service does
not** — its only volume is `payment_files` at `/app/payment-files`.

So even with `CAIRN_ENV=development`, `/platform/users/test-credentials` would render its "credential
file could not be read" panel. The passwords are in the file; the app cannot open it.

### B3 — `tsx` is a devDependency, so the installer may not be runnable inside the image

`scripts/in01-install.ts` is TypeScript and needs `tsx`, which is in **`devDependencies`**
(`package.json`). The `operations` image runs `npm ci` in the `dependencies` stage with no
`NODE_ENV`, so devDependencies are installed **there** — `npm run db:migrate` and `npm run seed`
already depend on that and work. But this is a fragile place to stand: if anyone adds
`ENV NODE_ENV=production` to the `dependencies` stage, `npm ci` omits devDependencies and every
`tsx` script breaks at once, including the migrations the deployment cannot start without.

**The `app` image cannot run the installer at all.** It contains only `.next/standalone`, `.next/static`,
`public` and `docs` (Dockerfile lines 36–39) — no `scripts/`, no `fixtures/`, no `tsx`.

**Therefore: run the installer in the `migrate`/operations container, never in `app`.**

## C. The install, step by step

This uses the shipped Compose file **plus a small override** that fixes B2 without touching the
shipped file. B1 you must decide on; B3 is handled by running in the right container.

### C1. Get the exact commit

```bash
git clone <repository-url> cairn-erp
cd cairn-erp
git checkout <deploy-commit>        # see below
git rev-parse HEAD
```

> **Which commit to deploy.** Use the tip of `development` at the time you clone. Every commit from
> **`0262c5d5` onward** carries an identical installer, fixture set, schema, Dockerfile and Compose
> file; the only file that changed after `0262c5d5` is this document. Verified:
>
> ```
> git diff --stat 0262c5d5..development -- src scripts fixtures \
>     package.json docker-compose.yml Dockerfile      # → empty
> ```
>
> So `0262c5d5`, `d0edbf59`, `b824bde1` and anything later on `development` are interchangeable
> **for the application**. Deploy the newest, and confirm the diff above is empty against whichever
> you picked. If it is not empty, read what changed before you deploy it.
>
> **Nothing here is pushed yet.** `development` on the workbench is ahead of `origin/development`;
> push it, or `git checkout` will fail on your server.

### C2. Environment file

```bash
cp .env.docker.example .env && chmod 600 .env
# Generate FOUR different values. The three DB passwords must be URL-safe (hex).
openssl rand -hex 32   # CAIRN_OWNER_DB_PASSWORD
openssl rand -hex 32   # CAIRN_APP_DB_PASSWORD
openssl rand -hex 32   # CAIRN_MIGRATOR_DB_PASSWORD
openssl rand -hex 32   # SESSION_SECRET
```

Then in `.env`:

| Key | Value for this install | Why |
|---|---|---|
| `CAIRN_DATABASE_NAME` | `cairn_in01_uat` — the new, empty database | See C3 |
| `CAIRN_OWNER_DB_PASSWORD` / `CAIRN_APP_DB_PASSWORD` / `CAIRN_MIGRATOR_DB_PASSWORD` | the three generated hex values | Required; `cairn_app` and the migrator must differ |
| `SESSION_SECRET` | the fourth generated value | Required |
| `CAIRN_PROVISIONING_TOKEN` | a fifth generated value | Disables web tenant creation **only when the app is in `production`**. With `CAIRN_ENV=development` (C4) the token is bypassed server-side — see B1. Set it anyway, so the `production` fallback in §E is safe. |
| `ENABLE_DUMMY_DATA` | **`false`** | The Gulf demo dataset must not be created; this install uses IN01 |
| `CAIRN_HOST` | your DNS name | The proxy rule and the printed login URL |
| `CAIRN_DEMO_CREDENTIALS_UID` / `_GID` | `$(id -u):$(id -g)` | So you can read the credential file without sudo |

`ENABLE_DUMMY_DATA=false` matters: with it `true` the deployment also provisions the Vantage Foods
dataset from `docs/DEVELOPMENT-OPERATIONS.md` §10, which is not what this UAT is for.

### C3. The new, empty database

The shipped Compose file creates the database **inside the container's own volume**, named by
`CAIRN_DATABASE_NAME`. There are two ways to get an empty database; pick one.

**Option 1 — let Compose create it (simplest).** Set `CAIRN_DATABASE_NAME=cairn_in01_uat` in `.env`
*before the first* `docker compose up`. The `db` service creates that name on an empty volume, and
the app and migration URLs are composed from the same variable, so they cannot disagree.

**Option 2 — an existing PostgreSQL you manage.** This needs a larger override than it looks:
`migrate` declares `depends_on: db: condition: service_healthy`, so the `db` service must be
neutralised as well as the four URLs replaced.

```yaml
# docker-compose.external-db.yml  — NOT shipped; you would write this
services:
  # Neutralise the bundled database. `deploy.replicas: 0` is not honoured by
  # `docker compose up` for a service in depends_on, so point it at your own
  # server via a profile instead, and run with --profile external.
  db:
    profiles: ["bundled-db"]        # so it can be left out
  migrate:
    depends_on: !reset []           # Compose v2.24+; otherwise remove via a YAML merge
    environment:
      DATABASE_URL: postgresql://cairn_app:PASS@db.example:5432/cairn_in01_uat
      MIGRATION_DATABASE_URL: postgresql://cairn_integration_migrator:PASS@db.example:5432/cairn_in01_uat
  app:
    environment:
      DATABASE_URL: postgresql://cairn_app:PASS@db.example:5432/cairn_in01_uat
  worker:
    environment:
      DATABASE_URL: postgresql://cairn_app:PASS@db.example:5432/cairn_in01_uat
  worker-intensive:
    environment:
      DATABASE_URL: postgresql://cairn_app:PASS@db.example:5432/cairn_in01_uat
```

**I have not tested this override** — there is no Docker here, and `depends_on` cannot be cleared
by a plain map merge in older Compose versions. **Option 1 is strongly preferred.** If you must use
an external server, treat the YAML above as a starting point and confirm with
`docker compose config` that `db` is absent and no service still waits on it.

The target must be **empty** and owned by `cairn_integration_migrator`, with `cairn_app` already
created — on a machine you manage, `db:ensure-migrator` creates or repairs that role, but only if
`CAIRN_DB_OWNER_PASSWORD`/`CAIRN_DB_OWNER_USER` point at a superuser on that server. Never
`cairn_b210`, `cairn_hr_accept`, `cairn_demo`, `cairn_acceptance` or `cairn_integration`.

### C4. Override for the credentials file (B2)

Write `docker-compose.uat.yml` in the repository root:

```yaml
# UAT override. Makes the credential file readable by the app so
# /platform/users/test-credentials can render it, and pins CAIRN_ENV for the
# two services that need development mode. Read §B1 before using the CAIRN_ENV lines.
services:
  app:
    environment:
      # B1: required for the credentials page. ONLY on a private network — see §B1.
      CAIRN_ENV: development
      CAIRN_DEMO_CREDENTIALS_DIR: /app/credentials
    volumes:
      - ./credentials:/app/credentials:ro
  migrate:
    environment:
      CAIRN_ENV: development
```

`CAIRN_DEMO_CREDENTIALS_DIR` is read by the page (`demo-credentials.ts:183,245`), so setting it
explicitly means the path is not an assumption. `:ro` is enough: the app only reads.

> **On the merge:** Compose merges `volumes` by mount **target**, so this `/app/credentials` entry
> is appended to the base file's `/app/payment-files` and both remain. (That is also why
> `docker-compose.payment-files-bind.yml`, which *reuses* the `/app/payment-files` target, replaces
> the named volume rather than adding a second mount.) If you use both overrides together, order
> them `-f docker-compose.yml -f docker-compose.uat.yml -f docker-compose.payment-files-bind.yml`.

### C5. First start

```bash
# The commands below use $CAIRN_HOST; the value lives in .env for Compose, so
# source it here too rather than retyping the name.
set -a; . ./.env; set +a
echo "host: $CAIRN_HOST"     # must print your DNS name

mkdir -p credentials        # the migrate service writes here
docker compose -f docker-compose.yml -f docker-compose.uat.yml up -d --build
docker compose logs -f migrate      # wait for it to exit 0
```

The one-shot `migrate` service runs, in order:
`db:ensure-migrator → db:sync-role → db:migrate → db:sync-role → db:init-reference → seed → demo:provision`.
With `ENABLE_DUMMY_DATA=false` the last step prints "not enabled; nothing to do" and exits 0. **The
India dataset is not installed by Compose** — that is C6.

`app` and `worker` wait for `migrate` to complete successfully, so the site will not come up over a
failed migration.

### C6. Install IN01 to Phase 2

Run it in the **operations** container — the one that has `tsx`, `scripts/` and `fixtures/` (see B3).
`DATABASE_URL` and `MIGRATION_DATABASE_URL` are already supplied by the `migrate` service definition,
so only the two `-e` values below are needed:

```bash
docker compose -f docker-compose.yml -f docker-compose.uat.yml \
  run --rm --no-deps \
  -e CAIRN_ENV=development \
  -e CAIRN_DEMO_CREDENTIALS_DIR=/app/credentials \
  -e CAIRN_DEMO_LOGIN_URL="https://$CAIRN_HOST" \
  migrate npx tsx scripts/in01-install.ts --until=phase2
```

> If that fails with `MODULE_NOT_FOUND` or `tsx: not found`, B3 has come true on your build — the
> `dependencies` stage installed without devDependencies. Confirm with
> `docker run --rm cairn-operations:local npx tsx --version` and check that the Dockerfile's
> `dependencies` stage has no `ENV NODE_ENV=production`.

Expected output ends with the account table and:

```
India install complete (phase2).
  Phase 0   chart additions 20, tax codes 6, cost centres 11, work centres 3, holiday days 8
  Phase 1   52 employees, 28 positions, 14 users, 156 leave quotas
  Phase 2   13 materials, 4 BOMs, 3 routings, 6 vendors, 6 customers
```

The credential file lands at `./credentials/demo-credentials.txt` on the host (the `migrate`
service bind-mounts `./credentials`). The `app` service sees the same directory through the
override in C4, so `/platform/users/test-credentials` renders it.

### C7. Confirm the two test-only features are on

**The credentials view:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://$CAIRN_HOST/platform/users/test-credentials"
```

- `404` — `CAIRN_ENV` is not `development` in the **app** container. Check
  `docker compose exec app printenv CAIRN_ENV`.
- `307`/`302` to `/signin` — correct. The page is gated by a session, so sign in first.
- `200` after signing in as `in01.admin` and re-requesting — working.

Then open it in a browser and confirm **15 rows with 15 distinct passwords**.

**The reset** (must refuse, not succeed, when misused):

```bash
# 1. A wrong confirmation — must refuse, and delete nothing
docker compose run --rm --no-deps -e CAIRN_ENV=development migrate \
  npx tsx scripts/in01-install.ts --reset-demo IN01 --confirm WRONG

# 2. Production mode, correct confirmation — must refuse (proves the gate is real)
docker compose run --rm --no-deps -e CAIRN_ENV=production migrate \
  npx tsx scripts/in01-install.ts --reset-demo IN01 --confirm IN01
```

Both must print `India installer refused the reset:` and leave the data intact. Only
`--reset-demo IN01 --confirm IN01` with `CAIRN_ENV=development` proceeds.

> **Not** a refusal test: running `scripts/in01-install.ts` with **no** flags does not refuse —
> it *installs* to `--until`'s default of `phase2`. A second run is safe (every phase adopts what
> stands), but do not mistake it for a guard.

### C8. Snapshot after Phase 2

Take this **before** any Phase 3 posting, so a failed scenario is one restore away.

```bash
# Custom format (-Fc), compressed, named with the deploy commit so a restore
# months later still says what it belongs to.
COMMIT=$(git rev-parse --short HEAD)   # the commit you deployed (C1)
STAMP=$(date +%Y%m%dT%H%M%SZ)
docker compose exec -T db pg_dump -U cairn -d cairn_in01_uat -Fc \
  > "in01-phase2-$STAMP-$COMMIT.dump"

# Record what it should contain, so a restore can be checked rather than assumed.
docker compose exec -T db psql -U cairn -d cairn_in01_uat -tAc \
  "select 'employees='||count(*) from employee where client='IN01'" \
  > "in01-phase2-$STAMP-$COMMIT.manifest.txt"

ls -l in01-phase2-$STAMP-$COMMIT.*
```

Keep the dump **off the database host** as well as on it — a snapshot on the same disk protects
against a bad restore, not against losing the disk.

**Optional:** if you want this as a *consistent* dump rather than one taken while the app is
writing, either stop the writers first (`docker compose stop app worker worker-intensive`) or use
`pg_dump`'s own snapshot. For a master-data-only install with no user traffic, a plain `pg_dump`
is fine.

### C9. Restore

```bash
DUMP=in01-phase2-<timestamp>-<commit>.dump    # the file you wrote in C8

# 1. Stop the writers so nothing reconnects mid-restore.
docker compose stop app worker worker-intensive

# 2. Copy the dump INTO the container. Streaming it through stdin works with
#    `exec -T`, but a file is easier to reason about and to retry.
docker compose cp "$DUMP" db:/tmp/restore.dump

# 3. Drop and recreate, owned by the migrator (the baseline assigns every object to it).
docker compose exec -T db psql -U cairn -d postgres -c \
  "drop database if exists cairn_in01_uat"
docker compose exec -T db psql -U cairn -d postgres -c \
  "create database cairn_in01_uat owner cairn_integration_migrator"

# 4. Restore. --no-owner because the roles are created by the init script, not the dump.
#    DO NOT add --no-privileges: it strips cairn_app's table grants and db:sync-role
#    does not put them back (it reconciles three auth tables only — see the trap below).
docker compose exec -T db pg_restore -U cairn -d cairn_in01_uat \
  --no-owner /tmp/restore.dump
docker compose exec -T db rm -f /tmp/restore.dump

# 5. Bring the application back.
docker compose start app worker worker-intensive
```

`pg_restore` exits non-zero on any error; check `echo $?` after step 4 before starting the app.

Then re-run the C7 checks. The **sanity table** in the section above this one is the fastest way to
confirm the restore landed intact: company code `IN01`/INR/`A4`, 52 employees, 13 materials, 15
accounts.

> **Trap — `--no-privileges` looks right and is wrong.** I measured it on a local round-trip:
> `pg_restore --no-privileges` leaves `has_table_privilege('cairn_app','public.material','SELECT')`
> **false**, and `npm run db:sync-role` does **not** fix it — that script reconciles exactly three
> tables (`app_user`, `user_session`, `password_reset_token`) plus CONNECT/USAGE, by design. The
> result is a restore that "worked" and then fails on the first query.
>
> `--no-owner` alone is correct: measured `material=true journal=true` after restore, RLS still
> `relrowsecurity = relforcerowsecurity = true`, tables still owned by
> `cairn_integration_migrator`, and `cairn_app` reading 52 employees with the tenant context set.

## D. What I could not verify

No Docker on this machine (`docker: not found`), so the container layer is verified **statically**
against `docker-compose.yml`, `Dockerfile`, `.dockerignore`, `package.json` and the source.

**Verified at runtime, without Docker** (on PostgreSQL directly — same server, same commands):

| Claim | Evidence |
|---|---|
| `pg_dump -Fc` + `pg_restore --no-owner` round-trips a phase-2 dataset | Installed, dumped (2.9 MB), dropped, recreated, restored, then read back as `cairn_app`: **52 employees, 13 materials, 15 users, 156 quotas**, company code `IN01` |
| `--no-privileges` breaks the runtime role | `has_table_privilege('cairn_app','public.material','SELECT')` = **false** after a `--no-privileges` restore, and `db:sync-role` does not repair it (it touches 3 auth tables) |
| RLS survives a `--no-owner` restore | `relrowsecurity` and `relforcerowsecurity` both **true** on `material`; tables still owned by `cairn_integration_migrator` |
| The dump carries the credentials-free schema + data the installer writes | restore contained all 52 employees and the 15 accounts |

**Not verified — container layer only:**

| Claim | How to confirm on your host |
|---|---|
| `npm ci` installs devDependencies in the `dependencies` stage | `docker run --rm cairn-operations:local npx tsx --version` |
| The installer runs in the operations image | the C6 command exits 0 |
| The app can read the mounted credential file | the C7 page lists 15 rows |
| `CAIRN_ENV=development` behaves as §B1 says | `curl` the launchpad anonymously; it should serve without redirect |
| The `docker-compose.uat.yml` override merges as described | `docker compose -f docker-compose.yml -f docker-compose.uat.yml config` |

If any of those disagrees with this page, **the host is right and this page is wrong** — the same
rule the runbook states for itself.

## E. The security decision you need to make

`CAIRN_ENV=development` in the `app` container is what turns the credentials page on. It also turns
off sign-in on the launchpad and the tenant list, and removes the owner token from tenant creation.

| Situation | Recommendation |
|---|---|
| Test box on a private network / VPN / IP-allowlisted | Accept it. Use C4 as written. |
| Reachable from the internet | **Do not** set `CAIRN_ENV=development` on `app`. Either (a) keep `production` and read passwords from `credentials/demo-credentials.txt` on the host instead of the page, or (b) ask for a change that gates the credentials page on its own flag rather than on `CAIRN_ENV`. |

Option (b) is the right long-term answer and is a small application change — a separate
`CAIRN_UAT_CREDENTIALS=1` read only by that one page, leaving `CAIRN_ENV` alone. I have not made it.

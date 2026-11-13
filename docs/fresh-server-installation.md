# Installing Cairn on a fresh server

This guide takes a clean Linux host to a running Cairn deployment. It covers both
outcomes: an empty system you onboard yourself, and a system that comes up holding a
complete fictional company for demonstration.

Read it once before you start. The order matters in two places — the Docker network has
to exist before the first `up`, and the database passwords cannot be changed afterwards
without a deliberate repair.

---

## 1. What you need on the host

| Requirement | Why |
|---|---|
| Docker Engine with Compose v2 | `docker compose version` must print a v2 version. |
| A DNS name pointing at the host | Cairn is served behind a reverse proxy on that name. |
| A reverse proxy on an external Docker network named `proxy` | `docker-compose.yml` declares `proxy` as **external**. If it is missing, Compose refuses to start. |
| Git, and outbound internet | The images are built on the host from this repository. |
| Roughly 2 CPU, 4 GB RAM, 20 GB disk | The Next.js build and PostgreSQL both need room; the build is the peak. |

Nothing publishes Cairn's own port. The `app` container listens on 3000 inside the
`cairn_internal` network and is reachable only through the proxy, which the Compose
labels configure for `Host(\`your-name\`)` on the `web` entrypoint.

Check the network first:

```bash
docker network inspect proxy >/dev/null 2>&1 && echo "proxy network found" || echo "STOP: proxy network is missing"
```

If it is missing, create it — but understand what that does and does not give you:

```bash
docker network create proxy
```

Creating the network lets Compose start. It does **not** make the site reachable: a
network with no proxy attached to it routes nothing. If there is no reverse proxy on
this host yet, stop and have that set up first.

---

## 2. Get the code

```bash
git clone <repository-url> cairn-erp
cd cairn-erp
git checkout development      # or the release tag you were told to deploy
```

Everything below runs from the repository root — the folder holding
`docker-compose.yml`.

---

## 3. Create the credentials directory (only if you want the demo dataset)

```bash
mkdir -p credentials
chmod 700 credentials
```

The one-shot provisioning step writes `demo-credentials.txt` here, through a bind
mount. It is harmless to create it even on an empty deployment, and it is much less
convenient to add later: the directory is mounted at container start, so adding it
afterwards means recreating the `migrate` service. The directory is listed in
`.dockerignore`, so nothing in it is ever copied into an image.

To have the file owned by your own account rather than by the container's root user,
note your ids now and put them in `.env` at the next step:

```bash
echo "$(id -u):$(id -g)"
```

---

## 4. Create the environment file

```bash
cp .env.docker.example .env
chmod 600 .env
```

Generate each secret separately and paste it in. Do not reuse a value, and do not
commit the file:

```bash
openssl rand -hex 32     # run once per secret below
```

| Variable | Required | What it is |
|---|---|---|
| `CAIRN_OWNER_DB_PASSWORD` | **Yes** | PostgreSQL superuser password. Never placed in a URL, so any characters are allowed. |
| `CAIRN_APP_DB_PASSWORD` | **Yes** | The application role's password. **Must be URL-safe** — `A-Za-z0-9_-` only; hexadecimal is recommended. It is embedded in `DATABASE_URL`. |
| `SESSION_SECRET` | **Yes** | Signs session cookies. |
| `CAIRN_PROVISIONING_TOKEN` | Recommended | Gates tenant creation. Every tenant, the first one included, needs it. Leave blank and web provisioning is disabled. |
| `CAIRN_HOST` | **Yes** for a real host | Your DNS name, without `https://`. Defaults to `cairn.deepakpt.com`, which is not yours. |
| `CAIRN_DATABASE_NAME` | Optional | Defaults to `cairn`. See the warning below. |
| `ENABLE_DUMMY_DATA` | Optional | `false` by default. See §5. |
| `CAIRN_DEMO_CREDENTIALS_UID` / `_GID` | Optional | Your `uid:gid` from §3, so the credential file is readable without `sudo`. |
| `CAIRN_DEMO_LOGIN_URL` | Optional | The sign-in address printed at the top of the credential file. |
| `CAIRN_DEMO_TENANT_NAME` | Optional | The tenant name printed in the credential file. |
| `CAIRN_BANK_DATA_KEYRING_JSON` | Optional | Deployment secret, supplied to the app only — never to the migration job. |
| `CAIRN_WORKER_ID`, `CAIRN_JOB_QUEUES`, `CAIRN_JOB_POLL_MS` | Optional | Worker identity and polling. Defaults are `worker-1`, `DEFAULT`, `2000`. |

Two traps worth stating plainly:

- **`CAIRN_APP_DB_PASSWORD` must be URL-safe.** If it contains anything outside
  `A-Za-z0-9_-`, the database's initialisation script refuses to start and says so.
  Hexadecimal never needs encoding, which is why it is recommended.
- **Changing `CAIRN_DATABASE_NAME` after the volume exists does nothing.** It is read
  when PostgreSQL initialises an empty data volume. On an existing volume it renames
  nothing and creates nothing; the app and migration URLs would simply point at a
  database that is not there.

---

## 5. Decide whether you want the demo dataset

`ENABLE_DUMMY_DATA=false` (the default, and the effect of leaving it unset) gives you
an empty system. You create the first tenant yourself and Cairn behaves exactly as it
does in production.

`ENABLE_DUMMY_DATA=true` provisions a complete fictional company — one company code,
two plants, three open posting periods, and roughly 150 connected documents across
purchasing, inventory, production, sales, finance and quality, plus nine accounts to
work it with.

Three things you should know before choosing it:

1. **It runs once, on the first start.** A second start finds the installation complete
   and leaves it alone.
2. **It refuses rather than overwrites.** If the database holds *any* business data — a
   tenant, a user, a document, a posting — provisioning refuses, and because `app` and
   `worker` are gated on the `migrate` job succeeding, **the application does not
   start**. That is deliberate: it is better to be stopped and told than to be running
   over a database you did not mean to touch. To provision a demo, point the deployment
   at a genuinely fresh volume.
3. **The data is fictional and disposable.** The credential file says so at the top, and
   the accounts in it all share one password. Do not put real business data into a demo
   tenant, and do not back it up as though it mattered.

Only an exact affirmative enables it: `true`, `1`, `yes` or `on`, with surrounding
space trimmed. A misspelling produces an empty deployment, never a populated one.

---

## 6. Start it

```bash
docker compose up -d --build
```

The first build takes several minutes. What happens, in order:

1. **`db`** — PostgreSQL 17 starts. On an empty volume it runs
   `docker/postgres/10-app-role.sh` once, which creates the `cairn_app` login as
   `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`.
2. **`migrate`** — a one-shot container that runs
   `db:sync-role && db:migrate && db:sync-role && db:init-reference && seed && demo:provision`.
   It applies schema migrations, reconciles the least-privilege grants on the central
   authentication tables, inserts the standard reference data idempotently, runs the
   existing seed, and — last — provisions the demo dataset if you asked for it. It exits
   with a non-zero code if any step is refused or fails.
3. **`app`** and **`worker`** — start only after `migrate` has completed successfully.
   They connect as `cairn_app`, inside row-level security.

---

## 7. Verify

```bash
docker compose ps
docker compose logs db      | grep -i "database system is ready"
docker compose logs migrate
docker compose logs app --tail=100
curl -fsS http://127.0.0.1:3000/api/health/live
```

Carry on only when the database is healthy, `migrate` has exited successfully, and
`app` is running.

Be clear about what the last command proves. `/api/health/live` is a **process-liveness**
signal: it does not query PostgreSQL or anything else. A 200 means the Node process is
answering. It does not prove database connectivity, migration readiness, backup
freshness or restoreability.

If `migrate` failed, `docker compose ps` shows it exited non-zero and `app` shows as
never started. That is the gate working. Read `docker compose logs migrate` — it names
the reason.

---

## 8. Sign in

**With the demo dataset**, read the credential file the provisioner wrote:

```bash
cat ./credentials/demo-credentials.txt
```

It lists the sign-in address, the shared password, and every account with its role.
Note the file is mode `0600`; if you did not set `CAIRN_DEMO_CREDENTIALS_UID`/`_GID`,
it belongs to the container's user and you may need `sudo` to read it.

**On an empty deployment**, open `https://<your-name>` and create the first tenant.
The form asks for the provisioning token from `.env` and names two accounts:

- the **platform administrator** — creates users and roles and grants capabilities. It
  cannot post or configure.
- the **tenant administrator** — holds the day-to-day authority and does the work.

Both are created in one transaction, because the tenant administrator's role is a
protected system role that routine administration cannot assign. A tenant created
without one can never be given one afterwards.

---

## 9. Routine operations

| You want to | Do this |
|---|---|
| Restart the web app | `docker compose restart app` — migrations are **not** re-run. |
| Deploy a code change | `docker compose up -d --build app worker` |
| Re-run migrations deliberately | `docker compose up -d --build --force-recreate migrate app` |
| Stop without losing data | `docker compose down` — the volume survives. |
| Read the logs | `docker compose logs -f app` (or `worker`, `db`, `migrate`) |
| Back up the database | `docker compose exec db pg_dump -U cairn -d "$CAIRN_DATABASE_NAME" > backup.sql` |

**Never type `docker compose down -v` while troubleshooting.** The `-v` deletes the
database volume, and there is no undo. It is the right command only when you
deliberately want to throw the database away and start again.

There is no scheduled backup in this Compose file. If the data matters, back it up
yourself.

---

## 10. Removing the deployment

```bash
docker compose down -v          # stops everything AND deletes the database volume
rm -f ./credentials/demo-credentials.txt
sudo rm -rf ./postgres_data 2>/dev/null   # only if it was ever a bind mount, not a named volume
```

The credential file holds a password, so delete it with the deployment rather than
leaving it on the host.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `network proxy declared as external, but could not be found` | No `proxy` network | `docker network create proxy`, then set up a reverse proxy on it. See §1. |
| `CAIRN_APP_DB_PASSWORD must be URL-safe` from `10-app-role.sh` | The password contains characters outside `A-Za-z0-9_-` | Set a hex value: `openssl rand -hex 32`. |
| `migrate` exits 1: *"This database already contains business data"* | `ENABLE_DUMMY_DATA=true` on a volume that already holds a tenant, user, document or posting | Point the deployment at a fresh volume, or set `ENABLE_DUMMY_DATA=false` and onboard the existing system. Nothing was written or deleted. |
| `app` never starts, `migrate` exited non-zero | A migration, seed or provisioning step failed | `docker compose logs migrate`. The application is held back by design until the one-shot job succeeds. |
| Site resolves but the proxy returns 502 | The `proxy` network exists but no proxy is attached to it, or `CAIRN_HOST` does not match the proxy's host rule | Check the proxy configuration and that `CAIRN_HOST` is your DNS name. |
| `demo-credentials.txt` is owned by root | `CAIRN_DEMO_CREDENTIALS_UID`/`_GID` were not set | Set them to your `uid:gid` and re-run `docker compose up -d --force-recreate migrate`. The file is rewritten. |
| Credentials worked on first deploy and break after a restart | `.env` was overwritten between deployments | Credentials are never changed silently. Existing volumes keep their passwords. Compare the current `.env` with what the volume was created with. |
| `Database credential synchronization failed` | `DATABASE_URL` and `MIGRATION_DATABASE_URL` disagree, or the owner login cannot manage roles | Confirm both URLs name the same database and that `CAIRN_OWNER_DB_PASSWORD` is the real superuser password. |
| Drifted grants on the central authentication tables after an upgrade | Normal on an existing volume | `docker compose up -d --build --force-recreate migrate app`. The post-migration role sync repairs them in place; it does not reset data. |

---

## 12. What this deployment does not do

Stated so that nobody discovers it later:

- **No backups.** Nothing in the Compose file copies your data anywhere.
- **No readiness probe.** `/api/health/live` is liveness only. An "unhealthy"
  container status means a process-liveness check failed; it does not mean Docker
  stopped the container, and it says nothing about the database.
- **No mail relay, object storage or external monitoring.**
- **No automatic recovery from a failed demo installation.** A interrupted
  provisioning run is left exactly as it was found and marked failed, for a person to
  look at. There is no force flag and no cleanup command.

---

## 13. A safe rehearsal

If this is the first time you are installing it, rehearse once on a throwaway host or
with a throwaway database name, with `ENABLE_DUMMY_DATA=true`, so you can see the whole
sequence — database, migrations, provisioning, credential file, first sign-in — before
you do it somewhere that matters. Then `docker compose down -v`, set the flags you
actually want, and start again on a clean volume.

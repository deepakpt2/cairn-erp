# Cairn — Claude Code Notes

## Codebase map
A persistent, index-only map of this repo lives in `docs/codemap/` (tables, no prose). Check it first when unsure where something lives or what depends on what — it's cheaper than rescanning the tree.

- `docs/codemap/README.md` — index: every module, one-line purpose, entry points, query recipes
- `docs/codemap/import-graph.json` — raw `madge` import graph (`src/`)
- `docs/codemap/modules/{audit,finance,foundation,inventory,people,platform,production,purchasing,quality,sales}.md` — per-module: Gotchas, then tables `file | exports | tables`, routes, owned tables, dependencies, tests
- `docs/codemap/shared.md` — cross-cutting infra (`src/platform/*`, `src/ui/*`, `src/worker/*`, app shell), RLS / SECURITY DEFINER / job / demo gotchas, shared unit → users
- `docs/codemap/database.md` — tables per schema file, cross-module table access
- `docs/codemap/unassigned.md` — everything else (config, docker, drizzle migrations, scripts, pre-existing docs/notes)

How to read it without loading whole files: see **Token & Context Optimization Rules** below.

**Keep it current:** when you add/move/delete files, change a module's dependencies, or add/change a DB table, run `node scripts/codemap-index.mjs` in the same change (after `npx madge --json --ts-config tsconfig.json --extensions ts,tsx src > docs/codemap/import-graph.json` if imports changed); `--check` reports a stale map. It rewrites only the generated tables and keeps each file's title, purpose line and `## Gotchas`. Edit Gotchas by hand: one short bullet per non-obvious rule, no narrative prose. Stale map entries are worse than no map.

## Token & Context Optimization Rules
These are standing rules for every session. Follow them even when a task seems to need an exception; ask the user instead.

1. **Migration history isolation.** Never read, grep or search `./drizzle/history/` (386 superseded migrations, 2.4 MB).
   - Always exclude it from searches: `grep -r --exclude-dir=history …`, `rg --glob '!drizzle/history/**' …`, `find … -path ./drizzle/history -prune -o …`. Never `cat`/`head`/`sed` a file under it.
   - `.claude/settings.json` denies `Read(./drizzle/history/**)` for the file tools; that rule does not cover shell commands, so the exclusions above are required.
   - Current schema lives in `src/**/schema*.ts`, `src/platform/tables/*.ts`, `drizzle/0000_baseline.sql` and `drizzle/9*.sql`. To check a historical migration use `git log -S '<name>' -- drizzle/`, or ask the user.
   - Never delete or move the folder, or add it to `.gitignore`: schema-contract tests and `scripts/lint-ip.ts` read it.
2. **Import graph querying.** Never read `docs/codemap/import-graph.json` (280 KB) whole into context: not with Read, `cat`, `head` or a large line range. Always query it with `jq`; keys are paths relative to `src/`.
   - Imports of a file: `jq '."modules/quality/lot.ts"' docs/codemap/import-graph.json`
   - Importers of a file: `jq -r 'to_entries[] | select(.value | index("platform/db/client.ts")) | .key' docs/codemap/import-graph.json`
3. **Codemap usage.** Treat `docs/codemap/*` as index tables (`file | exports | tables`), not documents. Never load a whole codemap file into context; read only the row or block you need.
   - One row: `grep -n '<file or table>' docs/codemap/modules/<m>.md` or `grep -rn '<name>' docs/codemap/*.md docs/codemap/modules/`
   - Gotchas only (read before changing a module): `awk '/^## Gotchas/{p=1;next} /^## /{p=0} p' docs/codemap/modules/<m>.md`

## End-user documentation (`docs/`)
Beginner-friendly user guide, one folder per module (`docs/README.md` is the index). **It must never go stale:** when a change alters a screen, menu name, URL, button label, field (mandatory/optional), validation message, posting effect or business rule, update the matching page under `docs/` in the same change, including its "What Happens in the Background?" callout. Add pages for new screens and link them from `docs/README.md`.
- Run `npm run docs:check` (`scripts/docs-check.mjs`): fails on dead relative links, missing anchors, and backticked `/routes` that have no `page.tsx`.
- Every page: Table of Contents, Prerequisites callout, numbered steps with sample data, background callout, Previous/Next links. Take names and fields from the code, never from memory.

## Environment & commands
Claude runs in the **workbench** container. The repo is shared with the **app** container, which runs `npm run dev` permanently on http://app:3000.

- **You cannot restart the app or run docker.** `next dev` reloads code and `next.config.ts` by itself. After dependency changes (`package.json`/lockfile, `npm install`) ask the user to run `docker compose restart app`.
- **Dev server log:** `.logs/next-dev.log` (read it after changes; it's gitignored).
- **PostgreSQL 17** at `postgres:5432` (required: `drizzle/0000_baseline.sql` is a PG 17 `pg_dump` and uses PG17-only settings such as `transaction_timeout`; it fails on 15). `DATABASE_URL` and `PGHOST/PGUSER/PGPASSWORD/PGDATABASE` are preset in the workbench and point at **erp_dev**, so plain `psql` hits erp_dev.
- **Check the server version first** (`psql -tAc 'show server_version'`). If it is not 17, stop and tell the user; don't work around the baseline.

| Database | Purpose | Roles |
|---|---|---|
| `erp_dev` | dev data behind http://app:3000; migrated + demo tenant `DMO1` (Vantage Foods, 9 accounts — password in gitignored `credentials/demo-credentials.txt`) | `cairn_integration_migrator` (owner of the database and every object; migrations), `cairn_app` (`LOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS`, password `cairn_app_dev`). The app container should use `cairn_app` for `DATABASE_URL` — `src/platform/db/client.ts` refuses a superuser runtime connection. `erp_user` (superuser) is for `psql` admin only, never for migrations |
| `erp_test` | test suites only — tests must **never** run against erp_dev | same roles; configured in `.env.test` |

**`cairn_integration_migrator` role:** the migration role, as on the project's integration cluster. `LOGIN CREATEROLE CREATEDB BYPASSRLS NOSUPERUSER`, password `cairn_migrator_dev`, holds `cairn_app` WITH ADMIN (so `db:sync-role` can manage it on PG 16+). It owns both databases, and must own every object: the `SECURITY DEFINER` functions (`notification_deliver`, `job_claim_next`, …) run as it. **Always migrate as this role** (`MIGRATION_DATABASE_URL` in `.env` / `.env.test`). Migrating as `erp_user` leaves post-baseline tables owned by `erp_user`, and notifications and jobs then fail with "permission denied". Rebuilt this way 2026-11-14 with the user's approval. Deployments get the role from `docker/postgres/10-app-role.sh` (fresh volume) or `scripts/ensure-migrator-role.ts` (`db:ensure-migrator`, existing volume; skips without `CAIRN_DB_OWNER_PASSWORD`). To recreate a database: `CREATE DATABASE <db> OWNER cairn_integration_migrator TEMPLATE template0`, `GRANT CONNECT ON DATABASE <db> TO cairn_app`, then run the pipeline.

Commands (run from the repo root in the workbench):
| Task | Command | Notes |
|---|---|---|
| Typecheck | `npm run typecheck` | needs the 4 GB heap baked into the script (~2 min); default heap OOMs |
| Lint | `npm run lint:ip` | only lint in the repo (no ESLint config; `next build` skips ESLint) |
| Build | `npm run build:check` | writes to `.next-build/` via `NEXT_DIST_DIR`. **Never run `npm run build` / `next build` here** — it writes into `.next`, which the dev server owns. Uses a 3 GB heap: 2.5 GB ran out of V8 heap in the type-check step once the audit module landed, and 4 GB gets the build OOM-killed by the system (exit 137) while the dev server runs. Passes (~3 min) when nothing else heavy is running. Next.js may rewrite `tsconfig.json` formatting during a build — keep only the `.next-build/types/**/*.ts` include |
| Tests | `npm test` (or `npx vitest run tests/<file>.test.ts`) | every vitest config imports `tests/test-env.ts`, which loads `.env.test` and refuses any DB but erp_test |
| Migrate erp_dev | `set -a; . ./.env; set +a; CAIRN_ENV=production npm run db:migrate` | scripts don't load `.env` themselves. The full pipeline (as the compose `migrate` service) is `db:ensure-migrator → db:sync-role → db:migrate → db:sync-role → db:init-reference → seed → demo:provision`. `.env` (gitignored, mode 600) holds `DATABASE_URL`=cairn_app, `MIGRATION_DATABASE_URL`=cairn_integration_migrator, `ENABLE_DUMMY_DATA=true`, `CAIRN_DEMO_CREDENTIALS_DIR=./credentials`. Demo provisioning runs once and refuses a non-empty DB |
| Migrate / seed erp_test | `npm run test:db:migrate` · `npm run test:db:seed` | via `scripts/with-test-env.ts` (same erp_dev refusal). Also run `npx tsx scripts/with-test-env.ts npx tsx scripts/sync-db-app-role.ts` before and after migrating, as the pipeline does |
| Native server (verification) | `NEXT_DIST_DIR=.next-build CAIRN_ENV=production DATABASE_URL=postgresql://cairn_app:cairn_app_dev@postgres:5432/erp_dev npx next start -H 127.0.0.1 -p 3100` (after `build:check`) | user-approved way to test the built app natively (the app container still connects as superuser, so sign-in there fails). Stop it right after use — `next start` leaves a `next-server` child: find it with `pgrep -af next-server`, check `/proc/<pid>/environ` has `NEXT_DIST_DIR=.next-build`, then `kill` it |
| Browser tests | Playwright (`node_modules/playwright`, Chromium headless shell in `~/.cache/ms-playwright`; system libs installed 2026-11-14) | Run against the native server on :3100. Memory is tight: launch with `--disable-gpu --disable-dev-shm-usage --renderer-process-limit=1 --js-flags=--max-old-space-size=256`, one user/browser at a time, no parallel workers. The sign-in page also holds the shell's search form, so target `form[action="/api/auth/signin"] …` and never a bare `button[type=submit]`. Reference script: `check.mjs` in the session scratchpad (sign-in, wrong password, 24 module pages, sign-out) |
| Smoke the app | `curl -s -o /dev/null -w '%{http_code}\n' http://app:3000/api/health/live` | `/` → 307 to `/signin` when signed out is expected |

Rules:
- **Ask before** any destructive migration (dropping/renaming columns or tables, deleting rows) and before anything that drops, truncates or bulk-deletes data in **erp_dev** (`db:reset`, `bootstrap:reset`, `test:db --fresh`, `DROP`/`TRUNCATE`/`DELETE` via psql). erp_test is disposable, but say what you're doing.
- Never point `.env.test` at erp_dev; recreate erp_test with `createdb -h postgres erp_test && npm run test:db:migrate && npm run test:db:seed`.
- The full suite (`npm test`, 580 files, serial) takes ~17 min; run it in the background with `NODE_OPTIONS=--max-old-space-size=2048`. Result 2026-11-14 after the ownership fix: only 2 known failures, a stale string check in `batch-determination-contract` (the code now builds `#<line>.<pick>` request keys) and `action-security` "posts in the session tenant…" (journal post returns `ok: false`, not yet diagnosed).
- Run heavy commands (typecheck, build, test suite) one at a time — the machine has limited memory. Use `ulimit -c 0` so a crash doesn't leave multi-GB `core.*` files in the repo.
- **Never leave dangling Next.js processes in the workbench.** Don't start `next dev` here — the app container already serves http://app:3000. `next start` only for the native verification row above. For `build:check` and any other `next` command, let it finish or kill it before ending your turn (including after a timeout, interrupt or background run), then confirm with `pgrep -af next` that nothing is left. The app container's dev server is not yours to kill.
- **Stop Playwright, Chromium and the native server as soon as a test run ends** (including after a failure, timeout or exit 137). Don't keep a browser or server idle between runs. Afterwards confirm with `pgrep -af "chrom|playwright|next-server"` that nothing is left. Two Playwright runs here were OOM-killed (exit 137) with the dev server, the native server and Chromium all running.

## Project status
This project is under active development. **No production data exists in any deployment** — every environment (including the acceptance/test server referenced in `AGENTS.md`) holds disposable test data only. This means:
- Future changes are allowed to break compatibility with old deployments (schema, API shapes, data formats). Don't hold back a better design to preserve backward compatibility with existing deployed state — there is none worth preserving yet.
- This does not override `AGENTS.md`'s specific database-safety rules (prohibited databases, acceptance-DB reset restrictions) — those are about *access discipline*, not data preservation. Still follow them.

## Dummy/seed data
The app ships with seed/walkthrough data (`walkthrough-seed.ts`, `scripts/seed.ts`, `scripts/seed-reference.ts`) used to manually verify functionality end-to-end. **Every new feature or significant change should extend this seed data** to cover the new functionality, so the user can exercise it through the UI without hand-crafting test data each time.

## Business logic placement
Business logic must be built as **service functions in `src/modules/<module>/*.ts`**, not inline in `src/app/*`. This is the existing pattern across every module — follow it for all new work:
- `src/modules/<module>/<feature>.ts` — the real logic: validation, DB reads/writes (via `withTenant`/`Tx`), posting, capability constants, typed errors (`class XError extends Error`). This is what gets imported and reused (by other modules, tests, scripts).
- `src/app/<module>/<feature>/actions.ts` — a thin `'use server'` wrapper: parses `FormData`/args, calls the service function, maps its typed error to UI state (`{ ok, message, remedy }`), calls `revalidatePath`. No business logic here — it's just presentation glue around the service call.
- `src/app/<module>/<feature>/page.tsx` / `*.tsx` — reads via the service function, renders, delegates writes to `actions.ts`.

Keep this split even for small features. When a new module/feature doc is needed, reflect it in `docs/codemap/modules/<module>.md`.

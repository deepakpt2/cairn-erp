# Unassigned
Everything outside `src/` modules and `shared.md`. Not dead code by default.

## Root config
`package.json` (scripts `db:*`, `test:*`, `typecheck`, `build:check`, `lint:ip`) · `tsconfig.json` (`@/*`→`src/*`; excludes `notes/walk-*.ts`) · `next.config.ts` · `drizzle.config.ts` (→ `src/platform/schema.ts`) · `tailwind.config.ts`, `postcss.config.js` · `vitest.config.ts` + `vitest.{browser-harness,stage3,stage3-db,ui-contract,walkthrough}.config.ts` · `.env.example`, `.env.development.example`, `.env.docker.example`, `.env.test` (tracked, erp_test only) · `.gitignore`, `.dockerignore`, `LICENSE`

## Docker
Postgres roles: `10-app-role.sh` creates `cairn_app` + `cairn_integration_migrator` on a fresh volume; `migrate` runs as the migrator.
`docker/`: `docker-compose.yml`, `Dockerfile`, `entrypoint.sh`, `bootstrap-db.mjs`, `sshd_config`, `postgres/10-app-role.sh`, `postgres/sync-credentials.sh` · root `docker-compose.yml`, `Dockerfile`
Volumes: `postgres_data` (DB), `./credentials` → `/app/credentials` (rw, demo passwords), `walkthrough-seed.ts` (ro).

## Migrations — `drizzle/`
| path | note |
|---|---|
| `0000_baseline.sql` | PG 17 `pg_dump`; marks the 386 old files applied; PG17-only settings |
| `9267_*.sql` … `9285_*.sql` | post-baseline migrations; new ones are `9xxx_<name>.sql`, applied in name order by `src/platform/db/migrate.ts` |
| `history/` | 386 superseded files; never applied; read by schema-contract tests and `scripts/lint-ip.ts`. **Do not read or grep** (see CLAUDE.md) |
| `meta/*_snapshot.json` | drizzle-kit snapshots |

## Scripts and seeds
`scripts/codemap-index.mjs` (regenerates `docs/codemap/` tables) · `scripts/ensure-migrator-role.ts` (`db:ensure-migrator`: creates/repairs `cairn_integration_migrator` before migrating) · `scripts/*.ts` (see `package.json`; demo: `demo-provision.ts`, `demo-signin-check.ts`; test DB: `with-test-env.ts`, `test-db.ts`) · `walkthrough-seed.ts` (115 KB, cross-module seed) + `walkthrough-run.md`

## Project docs (not maintained here)
Root: `AGENTS.md`, `CAIRN.md`, `CAIRN-2.md`…`CAIRN-7.md` (R-/D-/§ refs in comments), `implementation-status.md`, `IMPLEMENTATION-STATUS.md` (case-only name clash), `implemented-functions.md`, `onboarding-manual.md`, `inventory-architecture-audit.md`, `INCIDENT-QM-MIGRATION-TARGET.md`
`docs/`: `OPEN-GAPS.md` (deferred gaps, items 4–8), `DEFERRED_ISSUES.md`, `DEVELOPMENT-OPERATIONS.md`, `demo-restart-and-safety.md`, `fresh-server-installation.md`, `migration-authoring.md`, `operational-readiness.md`, `PROJECT-STATUS.md`, `*-audit.md` (t-code audits), `PHASE1-DIAGNOSTIC-INVENTORY.{csv,md}`, `PLATFORM-ADMIN-BOOTSTRAP-REVIEW.md`, `production-*.md`, `screen-link-audit.md`, `usage-audit.md`
`notes/`: dev notes; `walk-{a..e}.ts` are doc snippets excluded from tsconfig.

## Misc
`.logs/next-dev.log` (dev server log, gitignored) · `.claude/settings.json` (shared permissions) · `.claude/settings.local.json` (local)

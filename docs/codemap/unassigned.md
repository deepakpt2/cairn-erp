# Unassigned

Repo content outside the 9 business modules (`modules/*.md`) and cross-cutting runtime code (`shared.md`): build/deploy config, pre-existing project docs, dev notes, migration history. Not dead code by default.

## Build/tooling config (root)
`package.json`,`package-lock.json` (deps + scripts: `dev`,`build`,`db:*`,`smoke:*`,`walkthrough:*`,etc.) · `tsconfig.json` (`@/*→src/*`; excludes `notes/walk-{a..e}.ts`) · `next.config.ts`,`next-env.d.ts` · `drizzle.config.ts`(→`src/platform/schema.ts`) · `tailwind.config.ts`,`postcss.config.js` · `vitest.config.ts` + 5 tier-specific vitest configs (`browser-harness`,`stage3`,`stage3-db`,`ui-contract`,`walkthrough`) · `.env.example`,`.env.development.example`,`.env.docker.example` · `.env.test` (workbench test env, no secrets, tracked; loaded by `tests/test-env.ts` — see `shared.md`) · `.gitignore`,`.dockerignore`,`LICENSE`

## Docker — `docker/`
`docker-compose.yml`,`Dockerfile`,`entrypoint.sh`,`bootstrap-db.mjs`,`sshd_config`,`postgres/10-app-role.sh`,`postgres/sync-credentials.sh` (+ root-level `docker-compose.yml`/`Dockerfile` equivalents for local dev)

## Migrations — `drizzle/`
- `0000_baseline.sql` — schema-only `pg_dump` (PG 17.11) replacing the old chain; inserts the 386 old filenames into `cairn_migration` as applied, and carries seed rows four old migrations inserted (`capability`,`config_activity`,`term_registry`,`term_alias`). Known issues: emits `SET transaction_timeout` (PG17-only) and 445 `OWNER TO cairn_integration_migrator` (role exists only on the integration cluster).
- `9267_authority_model.sql` … `9275_initial_stock_entry.sql` — post-baseline migrations (authority model, job runtime, delegation, notification, job scheduler, production order company code not stored, demo installation, demo password fingerprint, initial stock entry). New schema changes go here as `9xxx_<name>.sql`.
- `history/` — 386 superseded migrations (`0000_init` … `9266_*`); never applied by the migrator, read by tests that cross-check migrations against Drizzle schema.
- `meta/*_snapshot.json` — Drizzle Kit snapshots.
Not catalogued per-file — see `database.md` for table ownership; grep `drizzle/history/*.sql` for a table's history.

## Root cross-module script
`walkthrough-seed.ts` (115KB) — demo/e2e seed touching most modules (`npm run walkthrough:seed`); depends on `src/dev/walkthrough-{asset,volume}.ts` (`shared.md`). `walkthrough-run.md` — accompanying notes.

## Pre-existing project docs (not maintained by this codemap)
**Root:** `AGENTS.md` (contributor/agent instructions), `CAIRN.md`+`CAIRN-2.md`…`CAIRN-7.md` (design/decision log; `R-`/`D-`/`§` refs cited in code comments point here), `implementation-status.md` (status of built screens), `IMPLEMENTATION-STATUS.md` (DI-020 commit/test status — separate file, differs only by case: avoid case-insensitive checkouts), `implemented-functions.md`, `onboarding-manual.md`, `inventory-architecture-audit.md`, `INCIDENT-QM-MIGRATION-TARGET.md`

**`docs/`** (27 files): `OPEN-GAPS.md` (deferred gaps from payroll item 4 / phases 1–5b, cost centre planning item 5 and activity prices item 6, with the two diagnosed pre-existing test failures), `demo-restart-and-safety.md` (operator reference for interrupted demo-data installs), `fresh-server-installation.md` (clean host → running deployment, empty or with demo company), `co09-availability-audit.md`,`DEFERRED_ISSUES.md`,`DEVELOPMENT-OPERATIONS.md`,`ko01-audit.md`,`ko22-audit.md`,`ko88-audit.md`,`kop1-audit.md`,`mb5m-audit.md`,`me31k-audit.md`,`me31l-audit.md`,`me32k-me33k-audit.md`,`me38-audit.md`,`me84-audit.md`,`migration-authoring.md`,`operational-readiness.md`,`PHASE1-DIAGNOSTIC-INVENTORY.{csv,md}`,`PLATFORM-ADMIN-BOOTSTRAP-REVIEW.md`,`production-goods-movement-failure-persistence.md`,`production-order-cost-basis-proposal.md`,`production-tcode-order.md`,`PROJECT-STATUS.md`,`screen-link-audit.md`,`usage-audit.md`

**`notes/`** (13 files): `coverage-reconciliation.md`,`people-increment-{1,2,3}.md`,`statement-version-browser-acceptance.md`,`statement-version-gap.md` (dev progress) · `module-api.txt`,`seed-api-inventory.txt` (scratch) · `walk-{a,b,c,d,e}.ts` — **excluded from `tsconfig.json` include** (doc snippets, not executable; keep out of module file lists)

## Misc
`.logs/` (1 file, runtime log dir) · `.claude/` (1 file, assistant project settings)

## Coverage
Everything under `src/`, `tests/`, `scripts/` is in the 9 module docs or `shared.md`. This file covers the rest: root config, `docker/`, `drizzle/`, pre-existing docs/notes.

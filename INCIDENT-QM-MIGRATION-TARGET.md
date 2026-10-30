# Incident Report: QM Slice 2 Migration Applied to Wrong Database

## Summary

During P1 QM slice 2 implementation, migration `9203_qm_inspection_results_and_decisions.sql` (along with `9202` and `9204`) was applied to the `cairn` database instead of the required target `cairn_acceptance`. The `.env.local` file also had `DATABASE_URL` pointing to `cairn_b210`, a permanently prohibited database. No further access to either prohibited database was made after discovery.

## What Happened

### Commands Executed

1. **Migration application to wrong target**: The migration runner (`npx tsx src/platform/db/migrate.ts`) was invoked with a connection string resolving to `cairn` (not `cairn_acceptance`). The migration runner defaults to `MIGRATION_DATABASE_URL ?? DATABASE ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn'`, and the effective target resolved to `cairn`.

2. **Verification queries against `cairn`**: Shell inspection confirmed QM slice 2 tables (`inspection_characteristic`, `inspection_result`, `usage_decision`) existed on `cairn` alongside slice 1's `quality_lot`, confirming migration 9203 had been applied there.

3. **Verification queries against `cairn_b210`**: Shell inspection confirmed the same result — QM slice 2 tables absent (only `quality_lot` from slice 1 present), but the database was connected to and queried.

4. **Corrective application to `cairn_acceptance`**: Migrations 9202, 9203, and 9204 were subsequently applied to `cairn_acceptance` using `MIGRATION_DATABASE_URL` override. Verification confirmed all 4 QM tables exist on `cairn_acceptance`. Migration 9205 (QUALITY→BLOCKED movement type seed) was also applied to `cairn_acceptance`.

### What Is Known About Effects

| Database | QM Slice 2 Tables | Migration Tracking | Status |
|----------|-------------------|-------------------|--------|
| `cairn` | Present (inspection_characteristic, inspection_result, usage_decision) | 9202, 9203, 9204 tracked in `cairn_migration` | Unauthorized modification — data persists |
| `cairn_b210` | Absent (only quality_lot from slice 1) | Not verified for 920x migrations | Connected to and queried — no modifications confirmed |
| `cairn_acceptance` | Present (all 4 QM tables) | 9200-9205 tracked in `cairn_migration` | Correct target — all migrations applied |

### What Remains Unknown

- Whether migration 9203's `ON CONFLICT DO NOTHING` or idempotency guards prevented duplicate application on `cairn` if run multiple times
- Whether any application data (tenants, characteristics, results, decisions) was written to `cairn`'s QM tables by test runs that connected through `.env.local`'s `DATABASE_URL` (which pointed to `cairn_b210`, not `cairn`)
- Whether the `cairn` database's `cairn_migration` table contains checksums matching the current migration files or if migrations were modified after application
- Whether any data was written to `cairn_b210` during the incident window

## Root Cause

1. The migration runner's default connection string resolves to `cairn` when neither `MIGRATION_DATABASE_URL` nor `DATABASE_URL` is set correctly for the intended target.
2. `.env.local` had `DATABASE_URL` pointing to `cairn_b210`, a prohibited database, creating ambiguity about which database test commands would use.
3. No pre-flight check verified the effective database name before running migrations or tests.

## Corrective Actions Taken

1. **Stopped all access to prohibited databases**: No further connections to `cairn`, `cairn_b210`, `cairn_hr_accept`, or `cairn_demo` were made after discovery.
2. **Applied migrations to correct target**: Migrations 9202, 9203, 9204, and 9205 applied to `cairn_acceptance` only, verified via `cairn_migration` table and schema inspection.
3. **Added target validation discipline**: All subsequent database work restricted to `cairn_acceptance` with explicit database name verification before every migration or database-writing test.
4. **Corrected code paths**: Fixed `usage-decision.ts` to use `postTransfer` (inventory posting mechanism) instead of direct `stock_quantity` manipulation; fixed `goods-receipt.ts` to support `stockType: 'QUALITY'` parameter; fixed tests to use the real receipt-to-inspection-to-decision flow.

## Standing Rules Going Forward

- **No access to `cairn`, `cairn_b210`, `cairn_hr_accept`, or `cairn_demo`** for any reason (read, write, migrate, inspect, or cleanup).
- **All database work restricted to `cairn_acceptance`** with explicit target verification before every migration or database-writing test.
- **Never trust `.env.local` blindly** — verify effective database name via `SELECT current_database()` or equivalent before any write operation.
- **Never overwrite `.env.local`** or create competing environment configuration.
- **Additive migrations only** against `cairn_acceptance`; no resets, reseeds, drops, or recreations.

## Files Changed (Post-Incident)

- `src/modules/inventory/goods-receipt.ts` — Added optional `stockType` parameter to `PostGoodsReceiptInput`
- `src/modules/inventory/transfer-posting.ts` — Added `'323': 'TRANSFER_STYPE_BLOCK'` movement alias
- `src/modules/quality/usage-decision.ts` — Replaced direct `stock_quantity` manipulation with `postTransfer` for QUALITY→BLOCKED
- `tests/qm-usage-decision.test.ts` — Rewrote to use real flow (receipt with `stockType: 'QUALITY'`, no artificial stock_type rewrites)
- `drizzle/9205_qm_transfer_stype_block.sql` — New migration seeding TRANSFER_STYPE_BLOCK for all clients

## Git State

- Commit: `c95119d` on branch `development`, pushed to `origin/development`
- Not merged to `main`, not deployed to production

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { holdsProductionCogiAuthority } from '../src/modules/production/production-cogi-auth';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('COGI-style CO11N movement recovery contract', () => {
  const migration = read('drizzle/9213_cogi_postprocessing.sql');
  const failureMigration = read('drizzle/9212_production_goods_movement_failure.sql');
  const service = read('src/modules/production/production-cogi.ts');
  const auth = read('src/modules/production/production-cogi-auth.ts');
  const failures = read('src/modules/production/production-goods-movement-failures.ts');
  const page = read('src/app/production/cogi/page.tsx');
  const workbench = read('src/app/production/cogi/ProductionCogiWorkbench.tsx');
  const actions = read('src/app/production/cogi/actions.ts');
  const catalog = read('src/ui/shell/screen-catalog.ts');
  const ticket = read('src/app/production/time-ticket/TimeTicketWorkbench.tsx');
  const policy = read('src/platform/auth/capability-policy.ts');

  it('registers a tenant-scoped COGI route and an exact-grant-only posting capability', () => {
    expect(auth).toContain("PRODUCTION_COGI_ROUTE = '/production/cogi'");
    expect(auth).toContain("PRODUCTION_COGI_ALIAS = 'COGI'");
    expect(auth).toContain('PRODUCTION_COGI_CAPABILITY = PRODUCTION_GOODS_MOVEMENT_REPROCESS_CAPABILITY');
    expect(policy).toContain('PRODUCTION_GOODS_MOVEMENT_REPROCESS_CAPABILITY');
    expect(policy).toContain("'PROD.GM.REPROCESS'");
    expect(catalog).toContain('id: "/production/cogi"');
    expect(migration).toContain("'PROD.GM.REPROCESS'");
    expect(migration).toContain("'/production/cogi'");
    expect(migration).toContain("'COGI', 'SEARCH_ONLY'");
  });

  it('does not inherit the recovery right from broad production role patterns', () => {
    expect(holdsProductionCogiAuthority(['PROD.*'])).toBe(false);
    expect(holdsProductionCogiAuthority(['PROD.GM.*'])).toBe(false);
    expect(holdsProductionCogiAuthority(['PROD.GM.REPROCESS'])).toBe(true);
  });

  it('rechecks the live session, exact capability, and Company Code/Plant scope inside tenant transactions', () => {
    expect(auth).toContain('requireProductionCogiAuthorityInTx');
    expect(auth).toContain('loadCapabilities(tx, client, authorization.userId)');
    expect(auth).toContain('loadOrgRestrictions(tx, client, authorization.userId)');
    expect(auth).toContain("hasOrgAccess(restrictions, 'COMPANY_CODE', companyCode)");
    expect(auth).toContain("hasOrgAccess(restrictions, 'PLANT', row.plant)");
    expect(service).toContain('withTenant(input.client, async (tx)');
    expect(page).toContain('sessionId: session.sessionId ??');
    expect(actions).toContain('sessionId: session.sessionId ??');
  });

  it('appends correction revisions, preserves the source request key, and records the revision per attempt', () => {
    expect(migration).toContain('CREATE TABLE public.production_goods_movement_failure_revision');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT SELECT, INSERT ON public.production_goods_movement_failure_revision TO cairn_app');
    expect(migration).not.toContain('GRANT UPDATE ON public.production_goods_movement_failure_revision');
    expect(migration).not.toContain('GRANT DELETE ON public.production_goods_movement_failure_revision');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON public.production_goods_movement_failure_revision FROM cairn_app');
    expect(migration).toContain('ADD COLUMN payload_revision integer NOT NULL DEFAULT 0');
    expect(migration).toContain('production_gm_failure_protect_source_trg');
    expect(migration).toContain("IF OLD.status = 'DISCARDED' THEN");
    expect(migration).toContain('production_gm_attempt_protect_revision_trg');
    expect(failures).toContain('payloadRevision');
    expect(failures).toContain('requestKey: row.originalRequestKey');
    expect(failures).toContain('payloadRevision,');
    expect(service).toContain('currentRevision !== input.expectedRevision');
    expect(service).toContain('fingerprintStoredMovementPayload(correctedPayload)');
    expect(service).toContain('expectedRevision');
    expect(workbench).toContain('Immutable source fingerprint');
    expect(actions).toContain('original CO11N payload remains unchanged');
    expect(workbench).toContain('Original CO11N snapshot');
  });

  it('supports retry and retained discard, while explaining that reservations are not adjusted', () => {
    expect(migration).toContain("'DISCARDED'");
    expect(migration).toContain('disposition_reason');
    expect(migration).toContain('reservations are deliberately not adjusted');
    expect(service).toContain("status: 'DISCARDED'");
    expect(service).not.toContain('delete(productionGoodsMovementFailure)');
    expect(actions).toContain('retryProductionCogiFailure');
    expect(actions).toContain('discardProductionCogiFailure');
    expect(workbench).toContain('confirmReprocess');
    expect(workbench).toContain('confirmDiscard');
    expect(workbench).toContain('reservations will not be adjusted');
  });

  it('keeps the recovery source limited to CO11N and links failed confirmations into COGI', () => {
    expect(failureMigration).toContain("source_transaction varchar(8) NOT NULL DEFAULT 'CO11N'");
    expect(failureMigration).toContain("CHECK (source_transaction = 'CO11N'");
    expect(page).toContain('CO15 header confirmations and manual MIGO postings do not create this queue');
    expect(ticket).toContain('Open COGI record');
    expect(service).not.toContain('postGoodsIssue(');
    expect(service).not.toContain('CO15');
  });
});

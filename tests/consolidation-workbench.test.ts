/**
 * SCR-116 / R-164 stage 5 — consolidation workbench (UCWB).
 *
 * Configuration only: dimensions judge standing journal
 * characteristics, parents judge acyclic, assignments refuse
 * overlaps, tasks refuse unconfigured references, activation
 * refuses incomplete areas. A reason is mandatory; nothing
 * posts.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  activateArea, assignUnit, getConsolidationWorkbench, saveArea,
  saveDataBasis, saveGroup, saveGroupAccount, saveMapping, saveMethod,
  saveTask, saveUnit, saveVersion,
} from '../src/modules/finance/consolidation-workbench';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR116-TEST';
const REASON = 'SCR-116 automated backend test';
let tenant: TestTenant | undefined;
let client = '';
let variant = 'K4';

const actor = { changedBy: ACTOR, reason: REASON };

beforeAll(async () => {
  tenant = await createTenant('scr116-ucwb');
  client = tenant.client;
  await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select fiscal_year_variant from company_code where client = ${client} and company_code = '1000'
    `) as unknown as Array<{ fiscal_year_variant: string }>;
    variant = rows[0]?.fiscal_year_variant ?? 'K4';
  });
  await saveDataBasis({
    client, ...actor, basis: 'BASIS1', title: 'Journal basis',
    dimensions: [{ dimension: 'COMPANY_CODE' }, { dimension: 'GL_ACCOUNT' }],
  });
  await saveArea({
    client, ...actor, area: 'C100', title: 'Group consolidation',
    dataBasis: 'BASIS1', consChart: 'GC01', fiscalYearVariant: variant,
  });
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
}, 180_000);

describe('SCR-116 consolidation workbench (R-164)', () => {
  it('refuses unknown dimensions, missing reasons and unconfigured references', async () => {
    await expect(saveDataBasis({
      client, ...actor, basis: 'BASIS2', title: 'Bad', dimensions: [{ dimension: 'INFOCUBE' }],
    })).rejects.toThrow(/standing journal characteristic/);
    await expect(saveUnit({
      client, changedBy: ACTOR, reason: '', area: 'C100', unit: 'U1000', title: 'Unit', companyCode: '1000',
    })).rejects.toThrow(/reason is required/);
    await expect(saveTask({
      client, ...actor, area: 'C100', version: '100', task: 'T1', sequence: 10,
      taskType: 'ELIMINATION', method: 'NOPE', validFrom: '2026-01-01', validTo: '2026-12-31',
    })).rejects.toThrow(/Version 100 does not stand|Method NOPE/);
  });

  it('builds master data with acyclic groups and non-overlapping assignments', async () => {
    await saveUnit({ client, ...actor, area: 'C100', unit: 'U1000', title: 'Unit one', companyCode: '1000' });
    await saveGroup({ client, ...actor, area: 'C100', group: 'GRP1', title: 'Group' });
    await saveGroup({ client, ...actor, area: 'C100', group: 'GRP2', title: 'Subgroup', parentGroup: 'GRP1' });
    await expect(saveGroup({ client, ...actor, area: 'C100', group: 'GRP1', title: 'Group', parentGroup: 'GRP2' }))
      .rejects.toThrow(/would cycle/);
    await assignUnit({
      client, ...actor, area: 'C100', group: 'GRP1', unit: 'U1000',
      validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    await expect(assignUnit({
      client, ...actor, area: 'C100', group: 'GRP2', unit: 'U1000',
      validFrom: '2026-06-01', validTo: '2027-05-31',
    })).rejects.toThrow(/overlapping assignments are refused/);
  });

  it('maps accounts, refuses activation while incomplete, then activates', async () => {
    await expect(activateArea({ client, ...actor, area: 'C100' }))
      .rejects.toThrow(/cannot activate/);
    await saveGroupAccount({ client, ...actor, consChart: 'GC01', account: '100000', title: 'Group assets' });
    await saveMapping({
      client, ...actor, consChart: 'GC01', sourceChart: 'CA01',
      sourceFrom: '110000', sourceTo: '110000', groupAccount: '100000',
    });
    await saveMethod({ client, ...actor, area: 'C100', method: 'FX01', kind: 'CURRENCY_TRANSLATION', title: 'Translate' });
    await saveVersion({ client, ...actor, area: 'C100', version: '100', title: 'Actual' });
    await saveTask({
      client, ...actor, area: 'C100', version: '100', task: 'T1', sequence: 10,
      taskType: 'CURRENCY_TRANSLATION', method: 'FX01', unit: 'U1000',
      validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    await activateArea({ client, ...actor, area: 'C100' });

    const view = await getConsolidationWorkbench(client, 'C100');
    expect(view?.area.status).toBe('ACTIVE');
    expect(view?.units.map((u) => u.unit)).toEqual(['U1000']);
    expect(view?.assignments).toHaveLength(1);
    expect(view?.mappings).toHaveLength(1);
    expect(view?.tasks.map((t) => t.task)).toEqual(['T1']);

    const postings = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      return rows[0]!.n;
    });
    expect(postings).toBe(0); // configuration never posts
  });
});

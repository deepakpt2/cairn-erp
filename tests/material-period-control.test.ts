import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import {
  getMaterialPeriodControl,
  initializeMaterialPeriodControl,
  listMaterialPeriodControl,
  materialPeriodAllows,
  setMaterialPeriodIndicators,
  shiftMaterialPeriod,
} from '../src/modules/inventory/material-period-control';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR054_OMSY_TEST';

/**
 * SCR-054 / OMSY acceptance: the control record initialized once
 * against the fiscal-year variant, the indicators maintained
 * separately, the shift advancing exactly one period (clearing the
 * backposting allowance where disallowed), and the posting judge.
 */
describe('SCR-054 material period control (OMSY)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr054-material-period');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, 'CFG.INV.MATPERIOD.DEFINE', 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
        await tx.execute(sql`
          insert into company_code (client, company_code, name, currency, country, language, created_by)
          values (${client}, '2000', 'Variantless company', 'USD', 'US', 'EN', ${ACTOR})
          on conflict do nothing
        `);
      });
    }
    return client;
  }

  const init = (patch: Partial<Parameters<typeof initializeMaterialPeriodControl>[0]> = {}) => ({
    client,
    changedBy: ACTOR,
    companyCode: '1000',
    fiscalYear: 2026,
    period: 10,
    reason: 'Stage 5 acceptance',
    ...patch,
  });

  it('initializes once, judged against the fiscal-year variant', async () => {
    const c = await standingClient();
    const before = await listMaterialPeriodControl(c);
    expect(before.find((r) => r.companyCode === '1000')?.initialized).toBe(false);
    expect(await getMaterialPeriodControl(c, '1000')).toBeNull();
    expect(materialPeriodAllows(null, 2026, 10)).toBe(false);

    await expect(
      initializeMaterialPeriodControl(init({ companyCode: '2000' })),
    ).rejects.toThrow('no fiscal year variant assigned');
    await expect(initializeMaterialPeriodControl(init({ period: 13 }))).rejects.toThrow(
      'must stand between 1 and 12',
    );
    const created = await initializeMaterialPeriodControl(init());
    expect(created.changed).toBe(true);
    await expect(initializeMaterialPeriodControl(init({ period: 11 }))).rejects.toThrow(
      'already initialized',
    );
    const record = await getMaterialPeriodControl(c, '1000');
    expect(record).toMatchObject({
      currentFiscalYear: 2026, currentPeriod: 10,
      previousFiscalYear: 2026, previousPeriod: 9,
      allowBackposting: false,
    });
    expect(materialPeriodAllows(record, 2026, 10)).toBe(true);
    expect(materialPeriodAllows(record, 2026, 9)).toBe(false);
    expect(materialPeriodAllows(record, 2026, 8)).toBe(false);
  });

  it('maintains the indicators separately and the judge follows them', async () => {
    const c = await standingClient();
    void c;
    const saved = await setMaterialPeriodIndicators({
      client, changedBy: ACTOR, companyCode: '1000',
      allowBackposting: true, disallowBackpostingAfterChange: false,
      reason: 'Stage 5 acceptance',
    });
    expect(saved.changed).toBe(true);
    const noop = await setMaterialPeriodIndicators({
      client, changedBy: ACTOR, companyCode: '1000',
      allowBackposting: true, disallowBackpostingAfterChange: false,
      reason: 'Stage 5 acceptance',
    });
    expect(noop.changed).toBe(false);
    const record = await getMaterialPeriodControl(client, '1000');
    expect(materialPeriodAllows(record, 2026, 9)).toBe(true);
  });

  it('shifts exactly one period and honours the disallow indicator', async () => {
    const c = await standingClient();
    void c;
    const first = await shiftMaterialPeriod({
      client, changedBy: ACTOR, companyCode: '1000', reason: 'Stage 5 acceptance',
    });
    expect(first).toMatchObject({ currentFiscalYear: 2026, currentPeriod: 11, previousPeriod: 10 });
    await setMaterialPeriodIndicators({
      client, changedBy: ACTOR, companyCode: '1000',
      allowBackposting: true, disallowBackpostingAfterChange: true,
      reason: 'Stage 5 acceptance',
    });
    const second = await shiftMaterialPeriod({
      client, changedBy: ACTOR, companyCode: '1000', reason: 'Stage 5 acceptance',
    });
    expect(second).toMatchObject({ currentFiscalYear: 2026, currentPeriod: 12 });
    let record = await getMaterialPeriodControl(client, '1000');
    // The shift cleared the allowance because disallow stands.
    expect(record?.allowBackposting).toBe(false);
    expect(materialPeriodAllows(record, 2026, 11)).toBe(false);
    const third = await shiftMaterialPeriod({
      client, changedBy: ACTOR, companyCode: '1000', reason: 'Year boundary',
    });
    expect(third).toMatchObject({
      currentFiscalYear: 2027, currentPeriod: 1,
      previousFiscalYear: 2026, previousPeriod: 12,
    });
    record = await getMaterialPeriodControl(client, '1000');
    const rows = await listMaterialPeriodControl(client);
    expect(rows.find((r) => r.companyCode === '1000')).toMatchObject({
      previousYearRefYear: 2026, previousYearRefPeriod: 12,
    });
    const history = await withTenant(client, (tx) =>
      changeHistory(tx, client, 'material_period_control', '1000'),
    );
    expect(history.length).toBeGreaterThanOrEqual(5);
  });
});

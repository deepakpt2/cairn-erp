import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import { maintainNumberRange, type NumberRangeInput } from '../src/modules/foundation/number-ranges';
import {
  deleteMaterialNumberRangeGroup,
  listMaterialNumberRangeGroups,
  saveMaterialNumberRangeGroup,
} from '../src/modules/inventory/material-number-range-groups';
import { listMaterialTypes, saveMaterialType } from '../src/modules/inventory/material-type-definition';
import { saveMaterialView, type MaterialInput } from '../src/modules/inventory/materials';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR051_MMNR_TEST';

/**
 * SCR-051 / MMNR acceptance: the group maintenance judged against the
 * standing intervals, the matrix read with its derived type assignment,
 * deletion refused under carrying types, and MM01 drawing internal
 * numbers while judging supplied numbers against the external interval.
 */
describe('SCR-051 material number range groups (MMNR)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  const interval = (patch: Partial<NumberRangeInput>): NumberRangeInput => ({
    client,
    changedBy: ACTOR,
    objectCode: 'MATERIALNR',
    companyCode: '*',
    subObject: '01',
    fiscalYear: 0,
    prefix: '',
    fromNumber: 1000,
    toNumber: 1999,
    numberLength: 6,
    displayStyle: 'CLASSIC',
    isExternal: false,
    isBuffered: false,
    bufferSize: 0,
    status: 'ACTIVE',
    mode: 'CREATE',
    reason: 'Stage 5 acceptance',
    ...patch,
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr051-mmnr');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        for (const activity of ['CFG.INV.MATERIALRANGE.DEFINE', 'CFG.INV.MATERIALTYPE.DEFINE']) {
          await tx.execute(sql`
            insert into config_activity_status (client, activity_code, status, created_by)
            values (${client}, ${activity}, 'NOT_STARTED', ${ACTOR})
            on conflict (client, activity_code) do nothing
          `);
        }
      });
      await maintainNumberRange(interval({ subObject: '01' }));
      await maintainNumberRange(interval({ subObject: '02', fromNumber: 5000, toNumber: 5999, isExternal: true }));
      await maintainNumberRange(interval({ subObject: '03', fromNumber: 2000, toNumber: 2999 }));
      await maintainNumberRange(interval({ subObject: '04', fromNumber: 6000, toNumber: 6999, isExternal: true }));
      await maintainNumberRange(interval({ subObject: '05', fromNumber: 3000, toNumber: 3999 }));
    }
    return client;
  }

  const group = (patch: Partial<Parameters<typeof saveMaterialNumberRangeGroup>[0]> = {}) => ({
    client,
    changedBy: ACTOR,
    mode: 'CREATE' as const,
    internalRangeKey: '01',
    externalRangeKey: '02',
    description: 'Grouped materials',
    reason: 'Stage 5 acceptance',
    ...patch,
  });

  it('judges group creation against the standing intervals', async () => {
    const c = await standingClient();
    await expect(
      saveMaterialNumberRangeGroup(group({ internalRangeKey: '09' })),
    ).rejects.toThrow('No internal material number range 09 stands');
    await expect(
      saveMaterialNumberRangeGroup(group({ externalRangeKey: '03' })),
    ).rejects.toThrow('No external material number range 03 stands');
    await expect(
      saveMaterialNumberRangeGroup(group({ externalRangeKey: '01' })),
    ).rejects.toThrow('must differ');
    const created = await saveMaterialNumberRangeGroup(group());
    expect(created.changed).toBe(true);
    await expect(saveMaterialNumberRangeGroup(group())).rejects.toThrow('already stands');
    const renamed = await saveMaterialNumberRangeGroup(
      group({ mode: 'CHANGE', description: 'Grouped stock' }),
    );
    expect(renamed.changed).toBe(true);
    const noop = await saveMaterialNumberRangeGroup(
      group({ mode: 'CHANGE', description: 'Grouped stock' }),
    );
    expect(noop.changed).toBe(false);
  });

  it('reads the matrix with derived assignment and ungrouped intervals', async () => {
    const c = await standingClient();
    await saveMaterialType({
      client: c, changedBy: ACTOR, mode: 'CREATE', materialType: 'TEST',
      name: 'Test material type', defaultProcurementType: 'BUY', defaultPriceControl: 'V',
      internalNumberRange: '01', externalNumberRange: '02',
      accountCategoryReference: '0001', externalPurchaseOrders: '2', internalPurchaseOrders: '1',
      isConfigurable: false, reason: 'Stage 5 acceptance',
    });
    const { groups, ungrouped } = await listMaterialNumberRangeGroups(c);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      internalKey: '01', externalKey: '02', description: 'Grouped stock',
      internalFrom: 1000, internalTo: 1999, externalFrom: 5000, externalTo: 5999,
      assignedTypes: ['TEST'],
    });
    expect(ungrouped.map((r) => r.rangeKey)).toEqual(['03', '04', '05']);
    const types = await listMaterialTypes(c);
    expect(types.find((t) => t.materialType === 'TEST')?.rangeGroup).toBe('Grouped stock');
    expect(types.find((t) => t.materialType === 'RAW')?.rangeGroup).toBeNull();
  });

  it('refuses deletion under a carrying type, then deletes freely', async () => {
    const c = await standingClient();
    await expect(
      deleteMaterialNumberRangeGroup({
        client: c, changedBy: ACTOR, internalRangeKey: '01', externalRangeKey: '02',
        reason: 'Stage 5 acceptance',
      }),
    ).rejects.toThrow('1 material type carries its intervals');
    await saveMaterialType({
      client: c, changedBy: ACTOR, mode: 'CHANGE', materialType: 'TEST',
      name: 'Test material type', defaultProcurementType: 'BUY', defaultPriceControl: 'V',
      internalNumberRange: '03', externalNumberRange: '04',
      accountCategoryReference: '0001', externalPurchaseOrders: '2', internalPurchaseOrders: '1',
      isConfigurable: false, reason: 'Move the type to its own ranges',
    });
    const deleted = await deleteMaterialNumberRangeGroup({
      client: c, changedBy: ACTOR, internalRangeKey: '01', externalRangeKey: '02',
      reason: 'Stage 5 acceptance',
    });
    expect(deleted.changed).toBe(true);
    const history = await withTenant(c, (tx) =>
      changeHistory(tx, c, 'material_number_range_group', '01/02'),
    );
    expect(history.map((h) => h.changeType).sort()).toEqual(['CHANGE', 'CREATE', 'DELETE']);
  });

  const basic = (patch: Partial<Extract<MaterialInput, { view: 'BASIC' }>> = {}): MaterialInput => ({
    client, materialNumber: '', changedBy: ACTOR, expectedVersion: 0, reason: 'Stage 5 acceptance',
    view: 'BASIC', description: 'Grouped component', materialType: 'TEST', materialGroup: 'RAW',
    baseUnit: 'KG', industrySector: 'M', barcode: '', grossWeight: '0', netWeight: '0',
    weightUnit: '', isBlocked: false, ...patch,
  });

  it('MM01 draws internal numbers and judges supplied ones', async () => {
    const c = await standingClient();
    void c;
    const first = await saveMaterialView(basic());
    expect(first.materialNumber).toBe('2000');
    const second = await saveMaterialView(basic({ description: 'Second grouped component' }));
    expect(second.materialNumber).toBe('2001');
    const supplied = await saveMaterialView(basic({ materialNumber: '6500' }));
    expect(supplied.materialNumber).toBe('6500');
    await expect(saveMaterialView(basic({ materialNumber: '5500' }))).rejects.toThrow(
      'stands outside the external interval 6000–6999',
    );
    await expect(saveMaterialView(basic({ materialNumber: 'EXT-1' }))).rejects.toThrow(
      'must be all digits',
    );
    // A rangeless delivered type keeps MM01's standing free entry…
    const free = await saveMaterialView(
      basic({ materialType: 'RAW', materialNumber: 'FREE-1' }),
    );
    expect(free.materialNumber).toBe('FREE-1');
    // …but cannot draw, having no internal range to draw from.
    await expect(saveMaterialView(basic({ materialType: 'RAW' }))).rejects.toThrow(
      'assigns no internal number range',
    );
  });
});

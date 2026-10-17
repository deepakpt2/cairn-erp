import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import {
  deleteAccountCategoryReference,
  deleteMaterialType,
  listAccountCategoryReferences,
  listMaterialTypes,
  listTypeValuation,
  saveAccountCategoryReference,
  saveMaterialType,
  saveTypeValuation,
  setMaterialTypeActive,
} from '../src/modules/inventory/material-type-definition';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR048_OMS2_TEST';

/**
 * SCR-048 / OMS2 acceptance at the service layer: the provisioned types
 * read back at their parity shape, number ranges judged against the
 * standing engine, the account reference judged against its master,
 * per-plant updating guarded by standing materials, and the lifecycle
 * (deactivate, delete-when-unused) with the trail to prove it.
 */
describe('SCR-048 material types (OMS2)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr048-material-type');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, 'CFG.INV.MATERIALTYPE.DEFINE', 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
      });
    }
    return client;
  }

  async function defineRanges(c: string) {
    await withTenant(c, async (tx) => {
      for (const [sub, external] of [['01', false], ['02', true]] as const) {
        await tx.execute(sql`
          insert into number_range (client, object_code, company_code, sub_object, fiscal_year,
            from_number, to_number, current_number, is_external, status, created_by)
          values (${c}, 'MATERIAL', '*', ${sub}, 0, 1, 999999, 0, ${external}, 'ACTIVE', ${ACTOR})
          on conflict do nothing
        `);
      }
    });
  }

  const baseType = {
    mode: 'CREATE' as const,
    materialType: 'TEST',
    name: 'Test material type',
    defaultProcurementType: 'BUY',
    defaultPriceControl: 'V',
    internalNumberRange: '01',
    externalNumberRange: '02',
    accountCategoryReference: '0001',
    externalPurchaseOrders: '2',
    internalPurchaseOrders: '1',
    isConfigurable: false,
    reason: 'Stage 5 acceptance',
  };

  it('reads the provisioned types, references and updating rows at parity shape', async () => {
    const c = await standingClient();
    const types = await listMaterialTypes(c);
    expect(types.map((t) => t.materialType)).toEqual(['FIN', 'RAW', 'SEMI', 'SERV', 'TRAD']);
    expect(types.every((t) => t.name.length <= 25)).toBe(true);
    const references = await listAccountCategoryReferences(c);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ reference: '0001', typeCount: 5 });
    const valuation = await listTypeValuation(c);
    const serv = valuation.find((r) => r.materialType === 'SERV');
    expect(serv).toMatchObject({ quantityUpdating: false, valueUpdating: false, stands: true });
    const raw = valuation.find((r) => r.materialType === 'RAW');
    expect(raw).toMatchObject({ quantityUpdating: true, valueUpdating: true });
  });

  it('refuses a reason-less write everywhere', async () => {
    const c = await standingClient();
    await expect(
      saveMaterialType({ client: c, changedBy: ACTOR, ...baseType, reason: '  ' }),
    ).rejects.toThrow('A reason is required');
    await expect(
      saveTypeValuation({
        client: c, changedBy: ACTOR, materialType: 'RAW', plant: '1000',
        quantityUpdating: false, valueUpdating: true, reason: '',
      }),
    ).rejects.toThrow('A reason is required');
  });

  it('judges both number-range keys against the standing engine', async () => {
    const c = await standingClient();
    await expect(
      saveMaterialType({ client: c, changedBy: ACTOR, ...baseType }),
    ).rejects.toThrow('No internal material number range 01 stands.');
    await defineRanges(c);
    await expect(
      saveMaterialType({ client: c, changedBy: ACTOR, ...baseType, externalNumberRange: '09' }),
    ).rejects.toThrow('No external material number range 09 stands.');
    // An internal key naming an external range is not an internal range.
    await expect(
      saveMaterialType({ client: c, changedBy: ACTOR, ...baseType, internalNumberRange: '02' }),
    ).rejects.toThrow('No internal material number range 02 stands.');
  });

  it('creates a type with a change document and security-relevant fields', async () => {
    const c = await standingClient();
    const result = await saveMaterialType({ client: c, changedBy: ACTOR, ...baseType });
    expect(result).toEqual({ materialType: 'TEST', changed: true });
    const again = await saveMaterialType({
      client: c, changedBy: ACTOR, ...baseType, mode: 'CHANGE',
    });
    expect(again.changed).toBe(false);
    const history = await withTenant(c, (tx) =>
      changeHistory(tx, c, 'material_type', 'TEST'),
    );
    expect(history).toHaveLength(1);
    expect(
      history[0].items
        .filter((i) => i.isSecurityRelevant === 'true')
        .map((i) => i.fieldName)
        .sort(),
    ).toEqual([
      'accountCategoryReference',
      'defaultPriceControl',
      'externalNumberRange',
      'internalNumberRange',
    ]);
    const [status] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select status from config_activity_status
        where client = ${c} and activity_code = 'CFG.INV.MATERIALTYPE.DEFINE'
      `);
      return rows as unknown as { status: string }[];
    });
    expect(status.status).toBe('COMPLETED');
  });

  it('refuses duplicate keys, oversize keys and names, and unknown references', async () => {
    const c = await standingClient();
    await expect(
      saveMaterialType({ client: c, changedBy: ACTOR, ...baseType, materialType: 'TEST' }),
    ).rejects.toThrow('already stands');
    await expect(
      saveMaterialType({ client: c, changedBy: ACTOR, ...baseType, materialType: 'TOOLONG' }),
    ).rejects.toThrow('one to 4 uppercase');
    await expect(
      saveMaterialType({
        client: c, changedBy: ACTOR, ...baseType,
        materialType: 'NEW1', name: 'A name that is longer than twenty-five',
      }),
    ).rejects.toThrow('at most 25 characters');
    await expect(
      saveMaterialType({
        client: c, changedBy: ACTOR, ...baseType,
        materialType: 'NEW1', accountCategoryReference: 'ZZZZ',
      }),
    ).rejects.toThrow('Account category reference ZZZZ does not stand.');
  });

  it('maintains account category references and refuses a used deletion', async () => {
    const c = await standingClient();
    await saveAccountCategoryReference({
      client: c, changedBy: ACTOR, mode: 'CREATE', reference: '0002',
      name: 'Spare valuation', reason: 'Grouped apart',
    });
    await saveAccountCategoryReference({
      client: c, changedBy: ACTOR, mode: 'CHANGE', reference: '0002',
      name: 'Spare valuation group', reason: 'Clearer name',
    });
    await expect(
      deleteAccountCategoryReference({
        client: c, changedBy: ACTOR, reference: '0001', reason: 'Trying',
      }),
    ).rejects.toThrow('cannot be deleted: 6 material types name it');
    const removed = await deleteAccountCategoryReference({
      client: c, changedBy: ACTOR, reference: '0002', reason: 'Unused',
    });
    expect(removed.changed).toBe(true);
  });

  it('guards updating flips by standing materials at the plant', async () => {
    const c = await standingClient();
    // No TEST materials stand yet: the flip is free.
    const flipped = await saveTypeValuation({
      client: c, changedBy: ACTOR, materialType: 'TEST', plant: '1000',
      quantityUpdating: true, valueUpdating: false, reason: 'No valuation for the test type',
    });
    expect(flipped.changed).toBe(true);
    await saveTypeValuation({
      client: c, changedBy: ACTOR, materialType: 'TEST', plant: '1000',
      quantityUpdating: true, valueUpdating: true, reason: 'Restore before materials',
    });
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, material_type, created_by)
        values (${c}, 'SCR048-MAT-1', 'TEST', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${c}, 'SCR048-MAT-1', '1000', ${ACTOR})
        on conflict do nothing
      `);
    });
    await expect(
      saveTypeValuation({
        client: c, changedBy: ACTOR, materialType: 'TEST', plant: '1000',
        quantityUpdating: false, valueUpdating: true, reason: 'Trying under materials',
      }),
    ).rejects.toThrow('cannot change: 1 material');
  });

  it('deactivates, reactivates and refuses deletion under standing materials', async () => {
    const c = await standingClient();
    await expect(
      deleteMaterialType({ client: c, changedBy: ACTOR, materialType: 'TEST', reason: 'Trying' }),
    ).rejects.toThrow('cannot be deleted: 1 material carries it');
    const off = await setMaterialTypeActive({
      client: c, changedBy: ACTOR, materialType: 'TEST', active: false, reason: 'Pause use',
    });
    expect(off.changed).toBe(true);
    const again = await setMaterialTypeActive({
      client: c, changedBy: ACTOR, materialType: 'TEST', active: false, reason: 'Pause again',
    });
    expect(again.changed).toBe(false);
    await setMaterialTypeActive({
      client: c, changedBy: ACTOR, materialType: 'TEST', active: true, reason: 'Resume',
    });
    // Remove the standing material: deletion now succeeds and takes its updating rows.
    await withTenant(c, async (tx) => {
      await tx.execute(sql`delete from material_plant where client = ${c} and material_number = 'SCR048-MAT-1'`);
      await tx.execute(sql`delete from material where client = ${c} and material_number = 'SCR048-MAT-1'`);
    });
    const removed = await deleteMaterialType({
      client: c, changedBy: ACTOR, materialType: 'TEST', reason: 'Unused type',
    });
    expect(removed.changed).toBe(true);
    const types = await listMaterialTypes(c);
    expect(types.map((t) => t.materialType)).not.toContain('TEST');
    const valuation = await listTypeValuation(c);
    expect(valuation.some((r) => r.materialType === 'TEST')).toBe(false);
  });
});

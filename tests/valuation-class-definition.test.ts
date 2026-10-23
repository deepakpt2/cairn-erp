import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { saveMaterialView, type MaterialInput } from '../src/modules/inventory/materials';
import { classPermittedForType } from '../src/modules/inventory/valuation-class-permission';
import {
  assignMaterialTypeReference,
  deleteValuationClass,
  listValuationClasses,
  listValuationGaps,
  saveValuationClass,
  saveValuationReference,
  postingValuationRefusal,
  valuationClassRefusal,
} from '../src/modules/inventory/valuation-class-definition';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'OMSK_TEST';

describe('valuation class permission', () => {
  it('permits only an active class assigned to the type reference', () => {
    expect(classPermittedForType({
      materialType: 'RAW',
      reference: '0001',
      referenceActive: true,
      classActive: true,
      allowedMaterialTypes: 'RAW',
      assignedToReference: true,
    })).toBe(true);
    expect(classPermittedForType({
      materialType: 'RAW',
      reference: '0001',
      referenceActive: true,
      classActive: true,
      allowedMaterialTypes: 'FIN',
      assignedToReference: true,
    })).toBe(false);
    expect(classPermittedForType({
      materialType: 'RAW',
      reference: '0001',
      referenceActive: true,
      classActive: true,
      allowedMaterialTypes: '',
      assignedToReference: false,
    })).toBe(false);
    expect(classPermittedForType({
      materialType: 'RAW',
      reference: '0008',
      referenceActive: false,
      classActive: true,
      allowedMaterialTypes: '',
      assignedToReference: true,
    })).toBe(false);
  });
});

describe('OMSK valuation classes', () => {
  const clients: string[] = [];

  afterAll(async () => {
    for (const client of clients) await destroyTenant(client);
    await closeDb();
  });

  async function tenant(seed: string) {
    const created = await createTenant(seed);
    clients.push(created.client);
    return created;
  }

  it('keeps leading zeros and assigns a class only to the named reference', async () => {
    const { client } = await tenant('omsk-keys');
    await saveValuationReference({
      client, changedBy: ACTOR, mode: 'CREATE', reference: '0008', name: 'Raw only', isActive: true, reason: 'Separate reference',
    });
    const created = await saveValuationClass({
      client,
      changedBy: ACTOR,
      mode: 'CREATE',
      valuationClass: '0001',
      name: 'Leading zero class',
      isActive: true,
      references: ['0008'],
      materialTypes: [],
      reason: 'Preserve the key',
    });
    expect(created.valuationClass).toBe('0001');
    const rows = await listValuationClasses(client);
    const row = rows.find((item) => item.valuationClass === '0001');
    expect(row?.references).toEqual(['0008']);
    expect(row?.valuationClass).toBe('0001');
    await expect(saveValuationClass({
      client, changedBy: ACTOR, mode: 'CREATE', valuationClass: '0001', name: 'Again', isActive: true,
      references: ['0008'], materialTypes: [], reason: 'Duplicate',
    })).rejects.toThrow('already stands');
  });

  it('refuses a class from another reference, an inactive reference, and a transport', async () => {
    const { client } = await tenant('omsk-refuse');
    await saveValuationReference({
      client, changedBy: ACTOR, mode: 'CREATE', reference: '0008', name: 'Other', isActive: true, reason: 'Other reference',
    });
    await saveValuationReference({
      client, changedBy: ACTOR, mode: 'CREATE', reference: '0009', name: 'Inactive', isActive: false, reason: 'Hold it back',
    });
    await saveValuationClass({
      client, changedBy: ACTOR, mode: 'CREATE', valuationClass: '3001', name: 'Other class', isActive: true,
      references: ['0008'], materialTypes: [], reason: 'Other reference class',
    });
    await expect(saveValuationClass({
      client, changedBy: ACTOR, mode: 'CREATE', valuationClass: '3002', name: 'Inactive assignment', isActive: true,
      references: ['0009'], materialTypes: [], reason: 'Should fail',
    })).rejects.toThrow('not active');
    await expect(saveValuationClass({
      client, changedBy: ACTOR, mode: 'CREATE', valuationClass: '3000', name: 'With a transport', isActive: true,
      references: ['0001'], materialTypes: ['RAW'], reason: 'Should fail', transportRequest: 'DEVK900001',
    })).rejects.toThrow('transport');
    const refusal = await withTenant(client, (tx) => valuationClassRefusal(tx, client, 'RAW', '3001'));
    expect(refusal).toMatch(/not allowed/);
    const delivered = await withTenant(client, (tx) => valuationClassRefusal(tx, client, 'RAW', 'RAW_INVENTORY'));
    expect(delivered).toBeNull();
    const finished = await withTenant(client, (tx) => valuationClassRefusal(tx, client, 'RAW', 'FINISHED_INVENTORY'));
    expect(finished).toMatch(/not allowed/);
  });

  it('does not rewrite a material when the class description changes, and blocks a destructive change', async () => {
    const created = await tenant('omsk-material');
    const client = created.client;
    const number = 'RAW-OMSK';
    const common = { client, materialNumber: number, changedBy: ACTOR, expectedVersion: 0, reason: 'OMSK material' };
    const basic: MaterialInput = {
      ...common, view: 'BASIC', description: 'OMSK raw', materialType: 'RAW', materialGroup: 'RAW',
      baseUnit: 'KG', industrySector: 'M', barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    };
    await saveMaterialView(basic);
    await saveMaterialView({
      ...common, view: 'ACCOUNTING', plant: '1000', valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE',
      standardPrice: '0', movingAveragePrice: '1.0000', priceUnit: '1',
    });
    await saveValuationClass({
      client, changedBy: ACTOR, mode: 'CHANGE', valuationClass: 'RAW_INVENTORY', name: 'Raw material inventory renamed',
      isActive: true, references: ['0001'], materialTypes: ['RAW'], reason: 'Description only', expectedVersion: 1,
    });
    const still = await withTenant(client, (tx) => tx.execute(sql`
      select valuation_class from material_valuation where client = ${client} and material_number = ${number}
    `));
    expect((still as unknown as Array<{ valuation_class: string }>)[0].valuation_class).toBe('RAW_INVENTORY');
    const journals = await withTenant(client, (tx) => tx.execute(sql`
      select count(*)::int as n from journal_entry where client = ${client}
    `));
    expect((journals as unknown as Array<{ n: number }>)[0].n).toBe(0);
    await expect(saveValuationClass({
      client, changedBy: ACTOR, mode: 'CHANGE', valuationClass: 'RAW_INVENTORY', name: 'Raw material inventory renamed',
      isActive: false, references: ['0001'], materialTypes: ['RAW'], reason: 'Deactivate used class', expectedVersion: 2,
    })).rejects.toThrow('would no longer be allowed');
    await expect(saveValuationClass({
      client, changedBy: ACTOR, mode: 'CHANGE', valuationClass: 'RAW_INVENTORY', name: 'Stale',
      isActive: true, references: ['0001'], materialTypes: ['RAW'], reason: 'Stale version', expectedVersion: 1,
    })).rejects.toThrow('changed after it was opened');
    await expect(deleteValuationClass({
      client, changedBy: ACTOR, valuationClass: 'RAW_INVENTORY', reason: 'Delete used class', expectedVersion: 2,
    })).rejects.toThrow('cannot be deleted');
    await expect(assignMaterialTypeReference({
      client, changedBy: ACTOR, materialType: 'RAW', reference: '0008', reason: 'Move the type',
    })).rejects.toThrow('does not stand');
    await saveValuationReference({
      client, changedBy: ACTOR, mode: 'CREATE', reference: '0008', name: 'Empty reference', isActive: true, reason: 'New reference',
    });
    await expect(assignMaterialTypeReference({
      client, changedBy: ACTOR, materialType: 'RAW', reference: '0008', reason: 'Move the type',
    })).rejects.toThrow('would no longer be allowed');
    const typeStill = await withTenant(client, (tx) => tx.execute(sql`
      select account_category_reference from material_type where client = ${client} and material_type = 'RAW'
    `));
    expect((typeStill as unknown as Array<{ account_category_reference: string }>)[0].account_category_reference).toBe('0001');
    const posted = await withTenant(client, (tx) => postingValuationRefusal(tx, client, number, 'FINISHED_INVENTORY'));
    expect(posted).toMatch(/not allowed/);
    const allowed = await withTenant(client, (tx) => postingValuationRefusal(tx, client, number, 'RAW_INVENTORY'));
    expect(allowed).toBeNull();
  });

  it('replays a request key and does not show another tenant class', async () => {
    const first = await tenant('omsk-replay-a');
    const second = await tenant('omsk-replay-b');
    const input = {
      client: first.client,
      changedBy: ACTOR,
      mode: 'CREATE' as const,
      valuationClass: '3000',
      name: 'Numeric looking class',
      isActive: true,
      references: ['0001'],
      materialTypes: ['RAW'],
      reason: 'First write',
      requestKey: 'omsk-request-1',
    };
    await saveValuationClass(input);
    const replay = await saveValuationClass({ ...input, name: 'Different name' });
    expect(replay.replayed).toBe(true);
    const rows = await listValuationClasses(first.client);
    expect(rows.find((row) => row.valuationClass === '3000')?.name).toBe('Numeric looking class');
    const history = await withTenant(first.client, (tx) => changeHistory(tx, first.client, 'valuation_class', '3000'));
    expect(history).toHaveLength(1);
    const other = await listValuationClasses(second.client);
    expect(other.some((row) => row.valuationClass === '3000')).toBe(false);
    const gaps = await listValuationGaps(first.client);
    expect(gaps.some((gap) => gap.includes('3000') && gap.includes('no account category reference'))).toBe(false);
  });
});

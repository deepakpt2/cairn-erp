import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveCharacteristic, setCharacteristicStatus } from '../src/modules/foundation/characteristic-definition';
import { saveClass } from '../src/modules/foundation/class-definition';
import { saveBatchLevel } from '../src/modules/inventory/batch-level';
import {
  ACTIVITY,
  ALIAS,
  CHANGE_ALIAS,
  DISPLAY_ALIAS,
  MATERIAL_BATCH_CLASS_TYPE,
  NOT_EXECUTED,
  PLANT_BATCH_CLASS_TYPE,
  evaluateBatchClass,
  listBatchClasses,
  saveBatchClass,
} from '../src/modules/inventory/batch-class';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'BMC1_TEST';
const AUTH = [ACTIVITY];
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function tenant(seed: string): Promise<string> {
  const created = await createTenant(seed);
  clients.push(created.client);
  return created.client;
}

function characteristic(client: string, name: string) {
  return saveCharacteristic({
    client,
    changedBy: ACTOR,
    mode: 'CREATE',
    characteristicName: name,
    description: name.slice(0, 30),
    dataFormat: 'CHAR',
    valueLength: 10,
    decimalPlaces: 0,
    unit: '',
    currency: '',
    negativeValuesAllowed: false,
    caseSensitive: false,
    intervalsAllowed: false,
    additionalValuesAllowed: false,
    valueAssignment: 'SINGLE',
    requiredEntry: false,
    values: [],
    reason: 'Characteristic for the batch class',
  });
}

function save(client: string, className: string, assignments: string[], extra: Record<string, unknown> = {}) {
  return saveBatchClass({
    client,
    changedBy: ACTOR,
    capabilities: AUTH,
    mode: 'CREATE',
    className,
    description: 'Shelf life class',
    assignments: assignments.map((characteristicName) => ({ characteristicName, requiredForClassification: true })),
    expectedVersion: null,
    confirmed: true,
    reason: 'Create the batch class',
    ...extra,
  });
}

describe('BMC1 batch class', () => {
  it('derives 022 at plant level and 023 at material or client level', async () => {
    const plant = await tenant('bmc1-plant');
    await characteristic(plant, 'SHELF_LIFE');
    await expect(save(plant, 'ZSHELF', ['SHELF_LIFE'])).rejects.toMatchObject({ code: 'LEVEL_REQUIRED' });
    expect((await listBatchClasses(plant)).blocked).toMatch(/023 is not assumed/);

    await saveBatchLevel({ client: plant, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    const created = await save(plant, 'ZSHELF', ['SHELF_LIFE']);
    expect(created.classType).toBe(PLANT_BATCH_CLASS_TYPE);
    expect(created.classType).not.toBe(MATERIAL_BATCH_CLASS_TYPE);
    expect(created.assignments.map((item) => item.characteristicName)).toEqual(['SHELF_LIFE']);
    await expect(save(plant, 'ZSHELF', ['SHELF_LIFE'], { classType: '023' })).rejects.toMatchObject({ code: 'TYPE_REFUSED' });

    const material = await tenant('bmc1-mat');
    await characteristic(material, 'COLOUR');
    await saveBatchLevel({ client: material, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });
    expect((await save(material, 'ZCOLOUR', ['COLOUR'])).classType).toBe('023');

    const clientLevel = await tenant('bmc1-clt');
    await characteristic(clientLevel, 'ORIGIN');
    await saveBatchLevel({ client: clientLevel, changedBy: ACTOR, batchLevel: '2', version: 0, reason: 'Client level' });
    expect((await save(clientLevel, 'ZORIGIN', ['ORIGIN'])).classType).toBe('023');
  });

  it('refuses a missing, duplicate, foreign, or blocked characteristic and keeps the class unassigned', async () => {
    const client = await tenant('bmc1-char');
    const other = await tenant('bmc1-other');
    await characteristic(other, 'FOREIGN_CHAR');
    await characteristic(client, 'POTENCY');
    await characteristic(client, 'GRADE');
    await setCharacteristicStatus({
      client, changedBy: ACTOR, characteristicName: 'GRADE', status: 'BLOCKED', reason: 'Block the characteristic',
    });
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '1', version: 0, reason: 'Material level' });

    await expect(save(client, 'ZBATCH', [])).rejects.toMatchObject({ code: 'CHARACTERISTIC_REQUIRED' });
    await expect(save(client, 'ZBATCH', ['MISSING'])).rejects.toMatchObject({ code: 'CHARACTERISTIC_UNKNOWN' });
    await expect(save(client, 'ZBATCH', ['FOREIGN_CHAR'])).rejects.toMatchObject({ code: 'CHARACTERISTIC_UNKNOWN' });
    await expect(save(client, 'ZBATCH', ['GRADE'])).rejects.toMatchObject({ code: 'CHARACTERISTIC_BLOCKED' });
    await expect(save(client, 'ZBATCH', ['POTENCY', 'POTENCY'])).rejects.toMatchObject({ code: 'DUPLICATE_CHARACTERISTIC' });
    await expect(save(client, 'ZBATCH', ['POTENCY'], { materialNumber: 'RM-1', batchNumber: 'B1' })).rejects.toMatchObject({ code: 'ASSIGNMENT_REFUSED' });
    await expect(save(client, 'ZBATCH', ['POTENCY'], { lifecycleStatus: 'RELEASED' })).rejects.toMatchObject({ code: 'STATUS_REFUSED' });
    await expect(save(client, 'TOOLONG_CLASS_NAME_1', ['POTENCY'])).rejects.toMatchObject({ code: 'CLASS_NAME' });

    const created = await save(client, 'ZBATCH', ['POTENCY']);
    await expect(save(client, 'ZBATCH', ['POTENCY'])).rejects.toMatchObject({ code: 'CLASS_EXISTS' });
    const stored = await withTenant(client, (tx) => tx.execute(sql`
      select class_type, class_name from classification_class where client = ${client} and class_name = 'ZBATCH'
    `)) as unknown as Array<{ class_type: string; class_name: string }>;
    expect(stored).toEqual([{ class_type: '023', class_name: 'ZBATCH' }]);
    expect(created.assignments).toHaveLength(1);
    expect(() => evaluateBatchClass()).toThrow(/not executed/i);
  });

  it('changes the assignment order and does not let a goods movement consume the class', async () => {
    const client = await tenant('bmc1-change');
    await characteristic(client, 'POTENCY');
    await characteristic(client, 'COLOUR');
    await saveBatchLevel({ client, changedBy: ACTOR, batchLevel: '0', version: 0, reason: 'Plant level' });
    const created = await save(client, 'ZORDER', ['POTENCY', 'COLOUR']);
    const changed = await saveBatchClass({
      client,
      changedBy: ACTOR,
      capabilities: AUTH,
      mode: 'CHANGE',
      className: 'ZORDER',
      description: 'Reordered class',
      assignments: [
        { characteristicName: 'COLOUR', requiredForClassification: false },
        { characteristicName: 'POTENCY', requiredForClassification: true },
      ],
      expectedVersion: created.version,
      confirmed: true,
      reason: 'Reorder the characteristics',
    });
    expect(changed.classType).toBe('022');
    expect(changed.assignments.map((item) => item.characteristicName)).toEqual(['COLOUR', 'POTENCY']);
    expect(changed.assignments.map((item) => item.position)).toEqual([1, 2]);
    await expect(saveBatchClass({
      client,
      changedBy: ACTOR,
      capabilities: AUTH,
      mode: 'CHANGE',
      className: 'ZORDER',
      description: 'Stale',
      assignments: [{ characteristicName: 'COLOUR', requiredForClassification: false }],
      expectedVersion: created.version,
      confirmed: true,
      reason: 'A stale save',
    })).rejects.toMatchObject({ code: 'STALE_VERSION' });

    await expect(saveClass({
      client,
      changedBy: ACTOR,
      mode: 'CREATE',
      classType: '022',
      className: 'ZOTHER',
      description: 'Not from CL02',
      assignments: [],
      reason: 'Must stay on BMC1',
    })).rejects.toThrow(/BMC1/);

    const service = readFileSync('src/modules/inventory/batch-class.ts', 'utf8');
    expect(service).not.toContain("classType: '023'");
    expect(service).toContain('NOT_EXECUTED');
    const page = readFileSync('src/app/inventory/batch-classes/page.tsx', 'utf8');
    expect(page).toContain('Not executed');
    expect(page).not.toContain('name="materialNumber"');
    for (const file of [
      'src/modules/inventory/goods-issue.ts',
      'src/modules/inventory/transfer-posting.ts',
      'src/modules/inventory/production-receipt.ts',
      'src/modules/inventory/batch-classification.ts',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toContain("from './batch-class'");
      expect(readFileSync(file, 'utf8')).not.toContain("from '@/modules/inventory/batch-class'");
    }
    expect(ACTIVITY).toBe('INV.BATCHCLASS.MAINTAIN');
    expect([ALIAS, CHANGE_ALIAS, DISPLAY_ALIAS]).toEqual(['BMC1', 'BMC2', 'BMC3']);
    expect(NOT_EXECUTED.map((item) => item.field)).toEqual(['OBJEK', 'AUSP', 'KLAH-STATU', 'LANGUAGE', 'DETERMINATION']);
  });
});

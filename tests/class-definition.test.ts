import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import { saveCharacteristic, setCharacteristicStatus } from '../src/modules/foundation/characteristic-definition';
import { deleteClass, listClasses, saveClass, setClassStatus } from '../src/modules/foundation/class-definition';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR058_CL02_TEST';

/**
 * SCR-058 / CL02 acceptance: the delivered class-type catalogue, the
 * class judged against standing characteristics, positions and
 * uniqueness, the lifecycle, and the CT04 usage count made real.
 */
describe('SCR-058 classes (CL02)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr058-class');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        for (const activity of ['CFG.PROC.CHARACTERISTIC.DEFINE', 'CFG.PROC.CLASS.DEFINE']) {
          await tx.execute(sql`
            insert into config_activity_status (client, activity_code, status, created_by)
            values (${client}, ${activity}, 'NOT_STARTED', ${ACTOR})
            on conflict (client, activity_code) do nothing
          `);
        }
      });
      const char = (patch: Partial<Parameters<typeof saveCharacteristic>[0]> = {}) => ({
        client, changedBy: ACTOR, mode: 'CREATE' as const,
        characteristicName: 'TOTAL_VALUE', description: 'Total document value',
        dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '',
        negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: true,
        additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false,
        values: [] as string[], reason: 'Stage 5 acceptance', ...patch,
      });
      await saveCharacteristic(char());
      await saveCharacteristic(char({
        characteristicName: 'PLANT', description: 'Receiving plant', dataFormat: 'CHAR',
        decimalPlaces: 0, valueLength: 10, intervalsAllowed: false, values: ['1000', '2000'],
      }));
      await setCharacteristicStatus({
        client, changedBy: ACTOR, characteristicName: 'PLANT', status: 'ACTIVE', reason: 'Stage 5 acceptance',
      });
      await setCharacteristicStatus({
        client, changedBy: ACTOR, characteristicName: 'PLANT', status: 'BLOCKED', reason: 'Stage 5 acceptance',
      });
    }
    return client;
  }

  const create = (patch: Partial<Parameters<typeof saveClass>[0]> = {}) => ({
    client,
    changedBy: ACTOR,
    mode: 'CREATE' as const,
    classType: 'PURCHASE_ORDER',
    className: 'PO_RELEASE',
    description: 'Purchase order release',
    assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: true }],
    reason: 'Stage 5 acceptance',
    ...patch,
  });

  it('judges the class against the catalogue and standing characteristics', async () => {
    const c = await standingClient();
    const choices = await listClasses(c);
    expect(choices.classTypes.map((t) => t.classType)).toContain('PURCHASE_ORDER');
    expect(choices.classTypes).toHaveLength(6);

    await expect(saveClass(create({ classType: 'NOPE' }))).rejects.toThrow('does not stand active');
    await expect(saveClass(create({
      assignments: [{ characteristicName: 'PLANT', requiredForClassification: false }],
    }))).rejects.toThrow('is blocked and cannot be newly assigned');
    await expect(saveClass(create({
      assignments: [
        { characteristicName: 'TOTAL_VALUE', requiredForClassification: true },
        { characteristicName: 'TOTAL_VALUE', requiredForClassification: false },
      ],
    }))).rejects.toThrow('stands twice in this class');

    await saveClass(create());
    const after = await listClasses(c);
    const row = after.classes.find((r) => r.className === 'PO_RELEASE');
    expect(row).toMatchObject({ lifecycleStatus: 'DRAFT', classType: 'PURCHASE_ORDER' });
    expect(row?.assignments).toHaveLength(1);
    expect(row?.assignments[0]).toMatchObject({ position: 1, characteristicName: 'TOTAL_VALUE', dataFormat: 'NUM' });
  });

  it('makes the CT04 usage count real: an assigned characteristic is protected', async () => {
    const c = await standingClient();
    await expect(saveCharacteristic({
      client: c, changedBy: ACTOR, mode: 'CHANGE',
      characteristicName: 'TOTAL_VALUE', description: 'Total document value',
      dataFormat: 'NUM', valueLength: 15, decimalPlaces: 2, unit: '', currency: '',
      negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: true,
      additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false,
      values: [], reason: 'Stage 5 acceptance',
    })).rejects.toThrow('is in use');
  });

  it('walks the lifecycle: activation, blocked assignments, draft-only deletion', async () => {
    const c = await standingClient();
    await setClassStatus({
      client: c, changedBy: ACTOR, classType: 'PURCHASE_ORDER', className: 'PO_RELEASE',
      status: 'ACTIVE', reason: 'Stage 5 acceptance',
    });
    await expect(deleteClass({
      client: c, changedBy: ACTOR, classType: 'PURCHASE_ORDER', className: 'PO_RELEASE', reason: 'Stage 5 acceptance',
    })).rejects.toThrow('blocks rather than deletes');

    await setClassStatus({
      client: c, changedBy: ACTOR, classType: 'PURCHASE_ORDER', className: 'PO_RELEASE',
      status: 'BLOCKED', reason: 'Stage 5 acceptance',
    });
    await expect(saveClass(create({ mode: 'CHANGE', assignments: [] })))
      .rejects.toThrow('its assignments cannot change while blocked');
    await saveClass(create({ mode: 'CHANGE', description: 'PO release (blocked edit)' }));

    await saveClass(create({ className: 'PO_DRAFT', assignments: [] }));
    await deleteClass({
      client: c, changedBy: ACTOR, classType: 'PURCHASE_ORDER', className: 'PO_DRAFT', reason: 'Stage 5 acceptance',
    });
    const after = await listClasses(c);
    expect(after.classes.find((r) => r.className === 'PO_DRAFT')).toBeUndefined();
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'classification_class', 'PURCHASE_ORDER/PO_RELEASE'));
    expect(history.length).toBeGreaterThanOrEqual(4);
  });
});

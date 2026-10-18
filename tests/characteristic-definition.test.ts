import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import {
  deleteCharacteristic,
  listCharacteristics,
  saveCharacteristic,
  setCharacteristicStatus,
} from '../src/modules/foundation/characteristic-definition';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR057_CT04_TEST';
const ACTIVITY = 'CFG.PROC.CHARACTERISTIC.DEFINE';

/**
 * SCR-057 / CT04 acceptance: the characteristic judged by its naming
 * and format rules, allowed values unique under the declared case
 * policy, the DRAFT/ACTIVE/BLOCKED lifecycle with its deletion rule,
 * and change history.
 */
describe('SCR-057 characteristics (CT04)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr057-characteristic');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, ${ACTIVITY}, 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
      });
    }
    return client;
  }

  const create = (patch: Partial<Parameters<typeof saveCharacteristic>[0]> = {}) => ({
    client,
    changedBy: ACTOR,
    mode: 'CREATE' as const,
    characteristicName: 'TOTAL_VALUE',
    description: 'Total document value',
    dataFormat: 'NUM',
    valueLength: 13,
    decimalPlaces: 2,
    unit: '',
    currency: '',
    negativeValuesAllowed: false,
    caseSensitive: false,
    intervalsAllowed: true,
    additionalValuesAllowed: true,
    valueAssignment: 'SINGLE',
    requiredEntry: false,
    values: [] as string[],
    reason: 'Stage 5 acceptance',
    ...patch,
  });

  it('creates a characteristic judged by its naming and format rules', async () => {
    const c = await standingClient();
    await expect(saveCharacteristic(create({ characteristicName: 'bad name' })))
      .rejects.toThrow('uppercase letters, digits and underscores');
    await expect(saveCharacteristic(create({ dataFormat: 'CHAR', decimalPlaces: 1 })))
      .rejects.toThrow('Decimal places belong to NUM and CURR');
    await expect(saveCharacteristic(create({ dataFormat: 'CURR', currency: '', intervalsAllowed: false })))
      .rejects.toThrow('names its currency');
    await expect(saveCharacteristic(create({
      characteristicName: 'COLOUR', dataFormat: 'CHAR', decimalPlaces: 0, intervalsAllowed: false,
      values: ['Red', 'red'],
    }))).rejects.toThrow('stands twice');

    await saveCharacteristic(create());
    await expect(saveCharacteristic(create())).rejects.toThrow('already stands');
    const rows = await listCharacteristics(c);
    const total = rows.find((r) => r.characteristicName === 'TOTAL_VALUE');
    expect(total).toMatchObject({ lifecycleStatus: 'DRAFT', dataFormat: 'NUM', decimalPlaces: 2 });
  });

  it('walks the lifecycle: activation, blocking over deletion, structural protection', async () => {
    const c = await standingClient();
    await setCharacteristicStatus({
      client: c, changedBy: ACTOR, characteristicName: 'TOTAL_VALUE', status: 'ACTIVE', reason: 'Stage 5 acceptance',
    });
    await expect(deleteCharacteristic({
      client: c, changedBy: ACTOR, characteristicName: 'TOTAL_VALUE', reason: 'Stage 5 acceptance',
    })).rejects.toThrow('blocks rather than deletes');

    await setCharacteristicStatus({
      client: c, changedBy: ACTOR, characteristicName: 'TOTAL_VALUE', status: 'BLOCKED', reason: 'Stage 5 acceptance',
    });
    await expect(saveCharacteristic(create({ mode: 'CHANGE', valueLength: 15 })))
      .rejects.toThrow('cannot change while blocked');
    await saveCharacteristic(create({ mode: 'CHANGE', description: 'Total value of document' }));
    const rows = await listCharacteristics(c);
    expect(rows.find((r) => r.characteristicName === 'TOTAL_VALUE')).toMatchObject({
      lifecycleStatus: 'BLOCKED', description: 'Total value of document',
    });
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'characteristic', 'TOTAL_VALUE'));
    expect(history.length).toBeGreaterThanOrEqual(4);
  });

  it('deletes only a valueless draft, and keeps case-sensitive values distinct', async () => {
    const c = await standingClient();
    await saveCharacteristic(create({
      characteristicName: 'COLOUR', dataFormat: 'CHAR', decimalPlaces: 0, intervalsAllowed: false,
      caseSensitive: true, values: ['Red', 'red'],
    }));
    await expect(deleteCharacteristic({
      client: c, changedBy: ACTOR, characteristicName: 'COLOUR', reason: 'Stage 5 acceptance',
    })).rejects.toThrow('carries 2 allowed values');
    await saveCharacteristic(create({
      characteristicName: 'COLOUR', mode: 'CHANGE', dataFormat: 'CHAR', decimalPlaces: 0,
      intervalsAllowed: false, caseSensitive: true, values: [],
    }));
    await deleteCharacteristic({
      client: c, changedBy: ACTOR, characteristicName: 'COLOUR', reason: 'Stage 5 acceptance',
    });
    const rows = await listCharacteristics(c);
    expect(rows.find((r) => r.characteristicName === 'COLOUR')).toBeUndefined();
  });
});

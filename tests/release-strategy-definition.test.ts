import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import { saveCharacteristic } from '../src/modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from '../src/modules/foundation/class-definition';
import {
  deleteReleaseGroup,
  determineRelease,
  listReleaseConfiguration,
  saveReleaseGroup,
  saveReleaseStrategy,
  setReleaseStrategyStatus,
} from '../src/modules/foundation/release-strategy-definition';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR059_RELEASE_TEST';

/**
 * SCR-059 acceptance: groups and codes judged, the strategy bound to
 * its class and criteria, activation beneath an ACTIVE class, and
 * the determination judge by priority.
 */
describe('SCR-059 release strategies', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr059-release-strategy');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        for (const activity of ['CFG.PROC.CHARACTERISTIC.DEFINE', 'CFG.PROC.CLASS.DEFINE', 'CFG.PROC.RELEASE.DEFINE']) {
          await tx.execute(sql`
            insert into config_activity_status (client, activity_code, status, created_by)
            values (${client}, ${activity}, 'NOT_STARTED', ${ACTOR})
            on conflict (client, activity_code) do nothing
          `);
        }
      });
      await saveCharacteristic({
        client, changedBy: ACTOR, mode: 'CREATE',
        characteristicName: 'TOTAL_VALUE', description: 'Total document value',
        dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '',
        negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: true,
        additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false,
        values: [], reason: 'Stage 5 acceptance',
      });
      await saveClass({
        client, changedBy: ACTOR, mode: 'CREATE',
        classType: 'PURCHASE_ORDER', className: 'PO_RELEASE', description: 'Purchase order release',
        assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: true }],
        reason: 'Stage 5 acceptance',
      });
      await saveReleaseGroup({
        client, changedBy: ACTOR, mode: 'CREATE',
        groupCode: 'PO', documentCategory: 'PURCHASE_ORDER', description: 'Purchase order releases',
        codes: [
          { code: 'MGR', description: 'Purchasing manager' },
          { code: 'FIN', description: 'Finance approver' },
        ],
        reason: 'Stage 5 acceptance',
      });
    }
    return client;
  }

  const strategy = (patch: Partial<Parameters<typeof saveReleaseStrategy>[0]> = {}) => ({
    client,
    changedBy: ACTOR,
    mode: 'CREATE' as const,
    groupCode: 'PO',
    strategyCode: 'HIGH',
    description: 'High value orders',
    className: 'PO_RELEASE',
    priority: 100,
    criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: '1000', valueTo: '' }],
    steps: ['MGR'],
    reason: 'Stage 5 acceptance',
    ...patch,
  });

  it('judges groups, codes, and the strategy against its class', async () => {
    const c = await standingClient();
    await expect(saveReleaseStrategy(strategy({ className: 'NOPE' })))
      .rejects.toThrow('does not stand under PURCHASE_ORDER');
    await expect(saveReleaseStrategy(strategy({
      criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: 'abc', valueTo: '' }],
    }))).rejects.toThrow('is not a number');
    await expect(saveReleaseStrategy(strategy({ steps: ['NOPE'] })))
      .rejects.toThrow('does not belong to group PO');
    await saveReleaseStrategy(strategy());
    await expect(deleteReleaseGroup({ client: c, changedBy: ACTOR, groupCode: 'PO', reason: 'Stage 5 acceptance' }))
      .rejects.toThrow('carries 1 strategies');
    const config = await listReleaseConfiguration(c);
    expect(config.strategies).toHaveLength(1);
    expect(config.strategies[0]).toMatchObject({ lifecycleStatus: 'DRAFT', steps: ['MGR'] });
  });

  it('activates only beneath an ACTIVE class, then determines by priority', async () => {
    const c = await standingClient();
    await expect(setReleaseStrategyStatus({
      client: c, changedBy: ACTOR, groupCode: 'PO', strategyCode: 'HIGH', status: 'ACTIVE', reason: 'Stage 5 acceptance',
    })).rejects.toThrow('cannot activate beneath it');

    await setClassStatus({
      client: c, changedBy: ACTOR, classType: 'PURCHASE_ORDER', className: 'PO_RELEASE',
      status: 'ACTIVE', reason: 'Stage 5 acceptance',
    });
    await setReleaseStrategyStatus({
      client: c, changedBy: ACTOR, groupCode: 'PO', strategyCode: 'HIGH', status: 'ACTIVE', reason: 'Stage 5 acceptance',
    });
    await saveReleaseStrategy(strategy({
      strategyCode: 'MEGA', description: 'Very high value orders', priority: 10,
      criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: '10000', valueTo: '' }],
      steps: ['MGR', 'FIN'],
    }));
    await setReleaseStrategyStatus({
      client: c, changedBy: ACTOR, groupCode: 'PO', strategyCode: 'MEGA', status: 'ACTIVE', reason: 'Stage 5 acceptance',
    });

    expect(await determineRelease(c, 'PURCHASE_ORDER', { TOTAL_VALUE: 500 })).toBeNull();
    expect(await determineRelease(c, 'PURCHASE_ORDER', { TOTAL_VALUE: 1500 }))
      .toMatchObject({ strategyCode: 'HIGH', steps: ['MGR'] });
    expect(await determineRelease(c, 'PURCHASE_ORDER', { TOTAL_VALUE: 20000 }))
      .toMatchObject({ strategyCode: 'MEGA', steps: ['MGR', 'FIN'] });
    expect(await determineRelease(c, 'PURCHASE_REQUISITION', { TOTAL_VALUE: 20000 })).toBeNull();

    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'release_strategy', 'PO/HIGH'));
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});

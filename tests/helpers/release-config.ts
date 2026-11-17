import { and, eq } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { saveCharacteristic } from '../../src/modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from '../../src/modules/foundation/class-definition';
import { characteristic } from '../../src/modules/foundation/characteristic-schema';
import {
  saveReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus,
} from '../../src/modules/foundation/release-strategy-definition';

/**
 * A release group with one ACTIVE strategy that claims a document whose TOTAL_VALUE is at least `from`,
 * for any category. The characteristic is created once per tenant.
 */
export async function defineReleaseStrategy(input: {
  client: string; actor: string; category: string; group: string; codes: string[];
  strategy: string; from: string; steps: string[]; priority?: number;
}): Promise<void> {
  const { client, actor } = input;
  const base = { client, changedBy: actor, reason: 'Release acceptance' };
  const [char] = await withTenant(client, (tx) => tx.select().from(characteristic).where(and(
    eq(characteristic.client, client), eq(characteristic.characteristicName, 'TOTAL_VALUE'))));
  if (!char) {
    await saveCharacteristic({
      ...base, mode: 'CREATE', characteristicName: 'TOTAL_VALUE', description: 'Total document value',
      dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '',
      negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: true,
      additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false, values: [],
    });
  }
  const className = `${input.group}_CLASS`;
  await saveClass({
    ...base, mode: 'CREATE', classType: input.category, className, description: `${className} class`,
    assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: true }],
  });
  await setClassStatus({ ...base, classType: input.category, className, status: 'ACTIVE' });
  await saveReleaseGroup({
    ...base, mode: 'CREATE', groupCode: input.group, documentCategory: input.category,
    description: `${input.group} releases`,
    codes: input.codes.map((code) => ({ code, description: `${code} approver` })),
  });
  await saveReleaseStrategy({
    ...base, mode: 'CREATE', groupCode: input.group, strategyCode: input.strategy,
    description: `${input.strategy} strategy`, className, priority: input.priority ?? 100,
    criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: input.from, valueTo: '' }],
    steps: input.steps,
  });
  await setReleaseStrategyStatus({ ...base, groupCode: input.group, strategyCode: input.strategy, status: 'ACTIVE' });
}

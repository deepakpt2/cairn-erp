/**
 * Demo purchase-order release strategies.
 *
 * Without a strategy no order needs release, so the demo could never show the
 * release flow. This writes the configuration through the same services the
 * config screens use (characteristic, class, group, strategies), then
 * determines the standing orders and walks a few of them through release so
 * the demo holds every state at once:
 *
 *  - HIGH (value >= 8,000, priority 100): two steps, MGR then FIN. One order
 *    stands released through step 1 and waits for FIN.
 *  - MID  (value >= 5,000, priority 200): one step, MGR. Some orders are fully
 *    released, the rest wait.
 *  - Orders under 5,000 are claimed by neither and need no release.
 *
 * Idempotent: configuration that stands is left alone, orders that already hold
 * a release row are not touched again.
 */
import { and, asc, eq } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { saveCharacteristic, setCharacteristicStatus } from '../../modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from '../../modules/foundation/class-definition';
import {
  characteristic, classificationClass, releaseGroup, releaseStrategy,
} from '../../modules/foundation/characteristic-schema';
import {
  saveReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus,
} from '../../modules/foundation/release-strategy-definition';
import { purchaseOrder, documentRelease } from '../../modules/purchasing/schema';
import {
  getDocumentRelease, orderAttributes, releaseDocument, syncDocumentRelease,
} from '../../modules/purchasing/release';

const CATEGORY = 'PURCHASE_ORDER';
const GROUP = 'PO';
const CLASS_NAME = 'PO_RELEASE';
const REASON = 'Demo release strategies';
/** MID orders released in full; the rest of MID wait at step 1. */
const MID_RELEASED = 4;

export interface DemoReleaseResult {
  strategies: number;
  claimed: number;
  released: number;
  pending: number;
}

export async function ensureDemoReleaseStrategies(client: string, actor: string): Promise<DemoReleaseResult> {
  const base = { client, changedBy: actor, reason: REASON };

  const [char, clazz, group, strategies] = await withTenant(client, async (tx) => [
    (await tx.select().from(characteristic).where(and(
      eq(characteristic.client, client), eq(characteristic.characteristicName, 'TOTAL_VALUE')))).at(0),
    (await tx.select().from(classificationClass).where(and(
      eq(classificationClass.client, client), eq(classificationClass.classType, CATEGORY),
      eq(classificationClass.className, CLASS_NAME)))).at(0),
    (await tx.select().from(releaseGroup).where(and(
      eq(releaseGroup.client, client), eq(releaseGroup.groupCode, GROUP)))).at(0),
    await tx.select().from(releaseStrategy).where(and(
      eq(releaseStrategy.client, client), eq(releaseStrategy.groupCode, GROUP))),
  ] as const);

  if (!char) {
    await saveCharacteristic({
      ...base, mode: 'CREATE', characteristicName: 'TOTAL_VALUE', description: 'Total document value',
      dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '',
      negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: false,
      additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false, values: [],
    });
  }
  if (!char || char.lifecycleStatus !== 'ACTIVE') {
    await setCharacteristicStatus({ ...base, characteristicName: 'TOTAL_VALUE', status: 'ACTIVE' });
  }
  if (!clazz) {
    await saveClass({
      ...base, mode: 'CREATE', classType: CATEGORY, className: CLASS_NAME,
      description: 'Purchase order release',
      assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: false }],
    });
  }
  if (!clazz || clazz.lifecycleStatus !== 'ACTIVE') {
    await setClassStatus({ ...base, classType: CATEGORY, className: CLASS_NAME, status: 'ACTIVE' });
  }
  if (!group) {
    await saveReleaseGroup({
      ...base, mode: 'CREATE', groupCode: GROUP, documentCategory: CATEGORY,
      description: 'Purchase order releases',
      codes: [{ code: 'MGR', description: 'Purchasing manager' }, { code: 'FIN', description: 'Finance approver' }],
    });
  }
  const defs = [
    { code: 'HIGH', description: 'High value orders', priority: 100, from: '8000', steps: ['MGR', 'FIN'] },
    { code: 'MID', description: 'Mid value orders', priority: 200, from: '5000', steps: ['MGR'] },
  ];
  for (const def of defs) {
    const standing = strategies.find((s) => s.strategyCode === def.code);
    if (!standing) {
      await saveReleaseStrategy({
        ...base, mode: 'CREATE', groupCode: GROUP, strategyCode: def.code, description: def.description,
        className: CLASS_NAME, priority: def.priority, steps: def.steps,
        criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: def.from, valueTo: '' }],
      });
    }
    if (!standing || standing.lifecycleStatus !== 'ACTIVE') {
      await setReleaseStrategyStatus({ ...base, groupCode: GROUP, strategyCode: def.code, status: 'ACTIVE' });
    }
  }

  // Determine the orders that stand and have no release row yet.
  const fresh = await withTenant(client, async (tx) => {
    const numbers = (await tx.select({ n: purchaseOrder.orderNumber }).from(purchaseOrder)
      .where(eq(purchaseOrder.client, client)).orderBy(asc(purchaseOrder.orderNumber))).map((r) => r.n);
    const held = new Set((await tx.select({ n: documentRelease.documentNumber }).from(documentRelease).where(and(
      eq(documentRelease.client, client), eq(documentRelease.documentCategory, CATEGORY)))).map((r) => r.n));
    const added: string[] = [];
    for (const number of numbers) {
      if (held.has(number)) continue;
      await syncDocumentRelease(tx, client, CATEGORY, number, await orderAttributes(tx, client, number), actor);
      added.push(number);
    }
    return added;
  });

  // Walk some of the newly claimed orders through release.
  let midReleased = 0;
  let highStarted = false;
  for (const number of fresh) {
    const state = await getDocumentRelease(client, CATEGORY, number);
    if (state.status !== 'PENDING') continue;
    const act = (releaseCode: string) => releaseDocument({
      client, changedBy: actor, documentCategory: CATEGORY, documentNumber: number, releaseCode,
    });
    if (state.strategyCode === 'HIGH' && !highStarted) {
      await act('MGR');
      highStarted = true;
    } else if (state.strategyCode === 'MID' && midReleased < MID_RELEASED) {
      await act('MGR');
      midReleased += 1;
    }
  }

  const rows = await withTenant(client, (tx) => tx.select().from(documentRelease).where(and(
    eq(documentRelease.client, client), eq(documentRelease.documentCategory, CATEGORY))));
  return {
    strategies: defs.length,
    claimed: rows.length,
    released: rows.filter((r) => r.status === 'RELEASED').length,
    pending: rows.filter((r) => r.status === 'PENDING').length,
  };
}

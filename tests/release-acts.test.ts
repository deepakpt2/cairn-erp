import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import { defineRange } from '../src/platform/numbering';
import { saveCharacteristic } from '../src/modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from '../src/modules/foundation/class-definition';
import {
  saveReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus,
} from '../src/modules/foundation/release-strategy-definition';
import { changeRequisition, createRequisition } from '../src/modules/purchasing/requisitions';
import { changeOrder, createOrder, getOrder } from '../src/modules/purchasing/orders';
import {
  cancelDocumentRelease, getDocumentRelease, releaseDocument,
} from '../src/modules/purchasing/release';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR060_RELEASE_ACT_TEST';

/**
 * SCR-060 acceptance: determination inside create and change, the
 * sequenced release acts under the standing next step's code, the
 * order header following, released documents refusing change, cancel
 * returning to step zero, and a changed claimant restarting a pending
 * document.
 */
describe('SCR-060 release acts', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr060-release-acts');
    const key = tenant.client;
    try {
      await withTenant(key, async (tx) => {
        await defineRange(tx, { client: key, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client: key, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
        // These codes are installation catalog rows owned by scripts/seed.ts.
        // A status row may reference one only when it already stands. Do not
        // invent a catalog row, and do not insert a status row that the
        // foreign key would reject. The document acts below do not require
        // the checklist row: markActivityComplete updates it when present.
        for (const activity of ['CFG.PROC.CHARACTERISTIC.DEFINE', 'CFG.PROC.CLASS.DEFINE', 'CFG.PROC.RELEASE.DEFINE']) {
          const catalog = await tx.execute(sql`
            select code from config_activity where code = ${activity}
          `) as unknown as unknown[];
          if (catalog.length === 0) continue;
          await tx.execute(sql`
            insert into config_activity_status (client, activity_code, status, created_by)
            values (${key}, ${activity}, 'NOT_STARTED', ${ACTOR})
            on conflict (client, activity_code) do nothing
          `);
        }
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${key}, '1000', 'Test purchasing organization', '1000', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${key}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${key}, 'V10000', 'SUPPLIER', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
          values (${key}, 'V10000', 'SUPPLIER', '1000', 'KWD', ${ACTOR})
          on conflict do nothing
        `);
      });
      await saveCharacteristic({
        client: key, changedBy: ACTOR, mode: 'CREATE',
        characteristicName: 'TOTAL_VALUE', description: 'Total document value',
        dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '',
        negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: true,
        additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false,
        values: [], reason: 'Stage 5 acceptance',
      });
      for (const [classType, className] of [
        ['PURCHASE_ORDER', 'PO_RELEASE'], ['PURCHASE_REQUISITION', 'PR_RELEASE'],
      ] as const) {
        await saveClass({
          client: key, changedBy: ACTOR, mode: 'CREATE',
          classType, className, description: `${className} release class`,
          assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: true }],
          reason: 'Stage 5 acceptance',
        });
        await setClassStatus({
          client: key, changedBy: ACTOR, classType, className, status: 'ACTIVE', reason: 'Stage 5 acceptance',
        });
      }
      await saveReleaseGroup({
        client: key, changedBy: ACTOR, mode: 'CREATE',
        groupCode: 'PO', documentCategory: 'PURCHASE_ORDER', description: 'Purchase order releases',
        codes: [
          { code: 'MGR', description: 'Purchasing manager' },
          { code: 'FIN', description: 'Finance approver' },
        ],
        reason: 'Stage 5 acceptance',
      });
      await saveReleaseGroup({
        client: key, changedBy: ACTOR, mode: 'CREATE',
        groupCode: 'PR', documentCategory: 'PURCHASE_REQUISITION', description: 'Requisition releases',
        codes: [{ code: 'MGR', description: 'Purchasing manager' }],
        reason: 'Stage 5 acceptance',
      });
      const activate = async (groupCode: string, strategyCode: string, className: string, priority: number, steps: string[]) => {
        await saveReleaseStrategy({
          client: key, changedBy: ACTOR, mode: 'CREATE',
          groupCode, strategyCode, description: `${strategyCode} strategy`, className, priority,
          criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: priority === 10 ? '10000' : '1000', valueTo: '' }],
          steps, reason: 'Stage 5 acceptance',
        });
        await setReleaseStrategyStatus({
          client: key, changedBy: ACTOR, groupCode, strategyCode, status: 'ACTIVE', reason: 'Stage 5 acceptance',
        });
      };
      await activate('PO', 'HIGH', 'PO_RELEASE', 100, ['MGR']);
      await activate('PO', 'MEGA', 'PO_RELEASE', 10, ['MGR', 'FIN']);
      await activate('PR', 'STD', 'PR_RELEASE', 100, ['MGR']);
      const supplier = await withTenant(key, async (tx) => tx.execute(sql`
        select p.partner_number
          from business_partner p
          join bp_role r
            on r.client = p.client and r.partner_number = p.partner_number and r.role_code = 'SUPPLIER'
          join supplier_purchasing_org s
            on s.client = p.client and s.partner_number = p.partner_number
           and s.role_code = 'SUPPLIER' and s.purchasing_org = '1000'
         where p.client = ${key} and p.partner_number = 'V10000'
      `)) as unknown as unknown[];
      if (supplier.length !== 1) throw new Error('Supplier V10000 fixture is incomplete.');
      client = key;
      return client;
    } catch (error) {
      await destroyTenant(key).catch(() => undefined);
      throw error;
    }
  }

  const header = {
    supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  };
  const orderItem = (netPrice: number) => ({
    materialNumber: '', shortText: 'Industrial steel plate', quantity: 10, unit: 'PC',
    netPrice, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }],
    assignments: [] as never[],
  });
  const requisitionItem = {
    materialNumber: '', shortText: 'Industrial steel plate', quantity: 10, unit: 'PC',
    deliveryDate: '2026-11-15', plant: '1000', storageLocation: '', purchasingGroup: '001',
    estimatedPrice: 150, priceUnit: 1, currency: 'USD', markedForDeletion: false,
    assignments: [] as never[],
  };

  it('determines on create: a claimant starts pending, no claimant needs no release', async () => {
    const c = await standingClient();
    const small = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [orderItem(50)] });
    expect(await getDocumentRelease(c, 'PURCHASE_ORDER', small.orderNumber))
      .toMatchObject({ status: 'NOT_REQUIRED' });
    await expect(releaseDocument({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_ORDER',
      documentNumber: small.orderNumber, releaseCode: 'MGR',
    })).rejects.toThrow('needs no release');

    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [orderItem(150)] });
    expect(await getDocumentRelease(c, 'PURCHASE_ORDER', order.orderNumber)).toMatchObject({
      status: 'PENDING', strategyCode: 'HIGH', steps: ['MGR'], currentStep: 0,
    });

    const requisition = await createRequisition({ client: c, changedBy: ACTOR, items: [requisitionItem] });
    expect(await getDocumentRelease(c, 'PURCHASE_REQUISITION', requisition.requisitionNumber)).toMatchObject({
      status: 'PENDING', strategyCode: 'STD', steps: ['MGR'], currentStep: 0,
    });
    // The requisition round-trips its own act and released-change refusal.
    await releaseDocument({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_REQUISITION',
      documentNumber: requisition.requisitionNumber, releaseCode: 'MGR',
    });
    await expect(changeRequisition({
      client: c, changedBy: ACTOR, requisitionNumber: requisition.requisitionNumber,
      items: [{ ...requisitionItem, itemNumber: 10 }],
    })).rejects.toThrow('is released and cannot be changed');
    await cancelDocumentRelease({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_REQUISITION',
      documentNumber: requisition.requisitionNumber,
    });
    expect(await getDocumentRelease(c, 'PURCHASE_REQUISITION', requisition.requisitionNumber))
      .toMatchObject({ status: 'PENDING', currentStep: 0 });
  });

  it('sequences the acts: wrong code refused, header follows, released change refused, cancel resets', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [orderItem(2000)] });
    expect(await getDocumentRelease(c, 'PURCHASE_ORDER', order.orderNumber)).toMatchObject({
      status: 'PENDING', strategyCode: 'MEGA', steps: ['MGR', 'FIN'], currentStep: 0,
    });
    await expect(releaseDocument({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_ORDER',
      documentNumber: order.orderNumber, releaseCode: 'FIN',
    })).rejects.toThrow('acts under release code MGR, not FIN');

    const midway = await releaseDocument({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_ORDER',
      documentNumber: order.orderNumber, releaseCode: 'MGR',
    });
    expect(midway).toMatchObject({ status: 'PENDING', currentStep: 1 });
    expect((await getOrder(c, order.orderNumber))?.releaseStatus).toBe('UNRELEASED');

    const done = await releaseDocument({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_ORDER',
      documentNumber: order.orderNumber, releaseCode: 'FIN',
    });
    expect(done).toMatchObject({ status: 'RELEASED', currentStep: 2 });
    expect((await getOrder(c, order.orderNumber))?.releaseStatus).toBe('RELEASED');
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'purchase_order', order.orderNumber));
    expect(history.length).toBeGreaterThanOrEqual(3);

    await expect(changeOrder({
      client: c, changedBy: ACTOR, ...header, orderNumber: order.orderNumber,
      items: [{ ...orderItem(2000), itemNumber: 10 }],
    })).rejects.toThrow('is released and cannot be changed');

    await cancelDocumentRelease({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_ORDER', documentNumber: order.orderNumber,
    });
    expect(await getDocumentRelease(c, 'PURCHASE_ORDER', order.orderNumber))
      .toMatchObject({ status: 'PENDING', currentStep: 0 });
    expect((await getOrder(c, order.orderNumber))?.releaseStatus).toBe('UNRELEASED');
    await changeOrder({
      client: c, changedBy: ACTOR, ...header, orderNumber: order.orderNumber,
      items: [{ ...orderItem(2000), itemNumber: 10 }],
    });
  });

  it('restarts a pending document at step zero when a change moves its claimant', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [orderItem(2000)] });
    await releaseDocument({
      client: c, changedBy: ACTOR, documentCategory: 'PURCHASE_ORDER',
      documentNumber: order.orderNumber, releaseCode: 'MGR',
    });
    expect(await getDocumentRelease(c, 'PURCHASE_ORDER', order.orderNumber))
      .toMatchObject({ strategyCode: 'MEGA', currentStep: 1 });
    await changeOrder({
      client: c, changedBy: ACTOR, ...header, orderNumber: order.orderNumber,
      items: [{ ...orderItem(150), itemNumber: 10 }],
    });
    expect(await getDocumentRelease(c, 'PURCHASE_ORDER', order.orderNumber)).toMatchObject({
      status: 'PENDING', strategyCode: 'HIGH', currentStep: 0,
    });
  });
});

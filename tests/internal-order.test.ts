import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { closeDb, createTenant, destroyTenant } from './helpers';
import { controllingArea, controllingAreaCompany, documentType } from '../src/modules/foundation/schema';
import { journalEntry, journalEntryLine } from '../src/modules/finance/schema';
import {
  changeInternalOrder,
  createInternalOrder,
  getInternalOrder,
  InternalOrderError,
} from '../src/modules/foundation/internal-order';
import { displayInternalOrder } from '../src/modules/foundation/internal-order-display';

const ACTOR = 'ORDER_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string) {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const { sql } = await import('drizzle-orm');
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client,
      objectCode: 'INTORDER',
      subObject: '*',
      prefix: 'IO',
      numberLength: 8,
      createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into internal_order_type (
        client, order_type, description, number_range_sub_object, statistical_default, created_by
      ) values (${tenant.client}, 'IO01', 'Internal order', '*', false, ${ACTOR})
      on conflict do nothing
    `);
    const [assignment] = await tx.select().from(controllingAreaCompany).where(eq(controllingAreaCompany.client, tenant.client));
    const [area] = await tx.select().from(controllingArea).where(and(
      eq(controllingArea.client, tenant.client),
      eq(controllingArea.controllingArea, assignment.controllingArea),
    ));
    (tenant as TestPlace).area = assignment.controllingArea;
    (tenant as TestPlace).company = assignment.companyCode;
    (tenant as TestPlace).currency = area.currency.trim();
  });
  return tenant as TestPlace;
}

interface TestPlace {
  client: string;
  companyCode: string;
  currency: string;
  area: string;
  company: string;
}

function order(tenant: TestPlace, description = 'Plant overhead') {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    orderType: 'IO01',
    description,
    controllingArea: tenant.area,
    companyCode: tenant.company,
    startDate: '2026-04-01',
    endDate: '2027-03-31',
  };
}

describe('internal order master', () => {
  it('creates an order without a journal, a budget, or a settlement', async () => {
    const tenant = await standing('ko01-create');
    const saved = await createInternalOrder(order(tenant));
    expect(saved.orderNumber).toMatch(/^IO/);
    const document = await getInternalOrder(tenant.client, saved.orderNumber);
    expect(document?.description).toBe('Plant overhead');
    expect(document?.currency).toBe(tenant.currency);
    expect(document?.journalCount).toBe(0);
    expect(document?.statistical).toBe(false);
    const again = await createInternalOrder({ ...order(tenant, 'Second order'), requestKey: 'walk-1' });
    const replay = await createInternalOrder({ ...order(tenant, 'Second order'), requestKey: 'walk-1' });
    expect(replay.orderNumber).toBe(again.orderNumber);
    const rows = await withTenant(tenant.client, async (tx) => tx.select().from(journalEntryLine).where(eq(journalEntryLine.client, tenant.client)));
    expect(rows).toHaveLength(0);
  });

  it('refuses a missing type, a typed number, and a company outside the area', async () => {
    const tenant = await standing('ko01-refuse');
    await expect(createInternalOrder({ ...order(tenant), orderType: 'ZZ99' })).rejects.toBeInstanceOf(InternalOrderError);
    await expect(createInternalOrder({ ...order(tenant), orderNumber: 'IO00000099' })).rejects.toThrow(/typed number/i);
    await expect(createInternalOrder({ ...order(tenant), companyCode: 'ZZZZ' })).rejects.toBeInstanceOf(InternalOrderError);
  });

  it('changes master data and does not rewrite a citing journal line', async () => {
    const tenant = await standing('ko02-change');
    const saved = await createInternalOrder(order(tenant));
    await withTenant(tenant.client, async (tx) => {
      const [type] = await tx.select().from(documentType).where(eq(documentType.client, tenant.client)).limit(1);
      await tx.insert(journalEntry).values({
        client: tenant.client,
        documentNumber: 'KO-J1',
        fiscalYear: 2026,
        documentType: type.documentType,
        companyCode: tenant.company,
        documentDate: '2026-05-01',
        postingDate: '2026-05-01',
        postingPeriod: 2,
        documentCurrency: tenant.currency,
        localCurrency: tenant.currency,
        createdBy: ACTOR,
      });
      await tx.insert(journalEntryLine).values({
        client: tenant.client,
        documentNumber: 'KO-J1',
        fiscalYear: 2026,
        lineNumber: 1,
        glAccount: '400000',
        companyCode: tenant.company,
        debitCredit: 'S',
        amountLocal: '10.0000',
        amountDocument: '10.0000',
        currency: tenant.currency,
        internalOrder: saved.orderNumber,
      });
      await tx.insert(journalEntryLine).values({
        client: tenant.client,
        documentNumber: 'KO-J1',
        fiscalYear: 2026,
        lineNumber: 2,
        glAccount: '100000',
        companyCode: tenant.company,
        debitCredit: 'H',
        amountLocal: '10.0000',
        amountDocument: '10.0000',
        currency: tenant.currency,
      });
    });
    await expect(changeInternalOrder({
      ...order(tenant, 'Narrowed'),
      orderNumber: saved.orderNumber,
      startDate: '2026-06-01',
    })).rejects.toThrow(/journal posting/i);
    const unchanged = await getInternalOrder(tenant.client, saved.orderNumber);
    expect(unchanged?.description).toBe('Plant overhead');
    expect(unchanged?.journalCount).toBe(1);
    await changeInternalOrder({
      ...order(tenant, 'Plant overhead revised'),
      orderNumber: saved.orderNumber,
    });
    const changed = await getInternalOrder(tenant.client, saved.orderNumber);
    expect(changed?.description).toBe('Plant overhead revised');
    const [line] = await withTenant(tenant.client, async (tx) => tx.select().from(journalEntryLine).where(and(
      eq(journalEntryLine.client, tenant.client),
      eq(journalEntryLine.documentNumber, 'KO-J1'),
      eq(journalEntryLine.lineNumber, 1),
    )));
    expect(line.internalOrder).toBe(saved.orderNumber);
    expect(line.amountDocument).toBe('10.0000');
  });

  it('marks an order and then refuses a later change', async () => {
    const tenant = await standing('ko02-mark');
    const saved = await createInternalOrder(order(tenant));
    await changeInternalOrder({ ...order(tenant), orderNumber: saved.orderNumber, markedForDeletion: true });
    await expect(changeInternalOrder({
      ...order(tenant, 'After mark'),
      orderNumber: saved.orderNumber,
    })).rejects.toThrow(/marked for deletion/i);
  });

  it('displays without accepting a change, and does not cross clients', async () => {
    const tenant = await standing('ko03-show');
    const other = await standing('ko03-hide');
    const saved = await createInternalOrder(order(tenant));
    const shown = await displayInternalOrder({ client: tenant.client, orderNumber: saved.orderNumber });
    expect(shown.orderNumber).toBe(saved.orderNumber);
    await expect(displayInternalOrder({
      client: tenant.client,
      orderNumber: saved.orderNumber,
      description: 'Changed in display',
    })).rejects.toThrow(/does not accept a change/i);
    await expect(getInternalOrder(other.client, saved.orderNumber)).resolves.toBeNull();
  });
});

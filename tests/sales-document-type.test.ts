/**
 * 9226 — a sales document type is configuration, not a constant.
 *
 * The chain carried `OR`, `LF` and `F2` as constants in its three services. Each constant really stood for
 * three facts — the code a document stores, the number range its number is drawn from, and the name a screen
 * shows — and could not express a fourth: whether the type is still in use. This file asserts the facts now
 * come from a row, that the rows every tenant needs are delivered with it, and that a type which does not
 * stand is reported as absent rather than guessed at.
 *
 * The cancellation type an invoice cancels into (9227) is asserted here too, because it is configuration like
 * any other type; the end-to-end proof that the services read the row rather than a constant is the rest of
 * the sales suite: `sales-order.test.ts` and `sales-delivery.test.ts` create orders, deliveries and billing documents
 * through the same services, against tenants that hold nothing but the delivered configuration. If the seed
 * did not land, they would refuse to create a document — which is exactly what the refusal is for.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  STANDARD_BILLING_CANCELLATION_TYPE,
  STANDARD_BILLING_TYPE,
  STANDARD_DELIVERY_TYPE,
  STANDARD_ORDER_TYPE,
  STANDARD_SALES_DOCUMENT_TYPES,
  salesDocumentTypeFor,
} from '../src/modules/sales/document-type';
import { salesDocumentType } from '../src/modules/sales/schema';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SD9226_DOCTYPE_TEST';

describe('sales document types are configuration (9226)', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9226-document-type');
    other = await createTenant('sd9226-document-type-isolation');
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
    if (other) await destroyTenant(other.client);
  });

  it('delivers the types the chain uses with every tenant', async () => {
    const rows = await withTenant(tenant.client, (tx) => tx.select().from(salesDocumentType)
      .where(eq(salesDocumentType.client, tenant.client)));
    const byCode = new Map(rows.map((row) => [row.documentType, row]));
    expect([...byCode.keys()].sort()).toEqual(STANDARD_SALES_DOCUMENT_TYPES.map((spec) => spec.documentType).sort());
    for (const spec of STANDARD_SALES_DOCUMENT_TYPES) {
      expect(byCode.get(spec.documentType)?.numberRangeObject).toBe(spec.numberRangeObject);
      expect(byCode.get(spec.documentType)?.numberRangeSubObject).toBe(spec.numberRangeSubObject);
      expect(byCode.get(spec.documentType)?.isActive).toBe(true);
    }
  });

  it('names each type after the document kind it creates', async () => {
    const order = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, STANDARD_ORDER_TYPE));
    const delivery = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, STANDARD_DELIVERY_TYPE));
    const billing = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, STANDARD_BILLING_TYPE));
    expect(order?.numberRangeObject).toBe('SALESORD');
    expect(order?.numberRangeSubObject).toBe('OR');
    expect(delivery?.numberRangeObject).toBe('DELIVERY');
    expect(delivery?.numberRangeSubObject).toBe('LF');
    expect(billing?.numberRangeObject).toBe('BILLING');
    expect(billing?.numberRangeSubObject).toBe('F2');
  });

  it('says nothing for a type that does not stand, rather than inventing one', async () => {
    const missing = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, 'ZZ'));
    expect(missing).toBeUndefined();
  });

  it('does not offer a type that has been deactivated', async () => {
    // Inserted rather than updated: the application role holds SELECT and INSERT on this table and nothing
    // else, because no screen maintains it yet — the grant arrives with the increment that writes. Rows
    // stand for the file and leave with the tenant, which `destroyTenant` drops.
    await withTenant(tenant.client, (tx) => tx.insert(salesDocumentType).values([
      {
        client: tenant.client, documentType: 'ZQ', name: 'Withdrawn quotation type',
        numberRangeObject: 'SALESORD', numberRangeSubObject: 'ZQ', isActive: false, createdBy: ACTOR,
      },
      {
        client: tenant.client, documentType: 'ZR', name: 'Live quotation type',
        numberRangeObject: 'SALESORD', numberRangeSubObject: 'ZR', isActive: true, createdBy: ACTOR,
      },
    ]));
    // A type with documents under it is deactivated rather than deleted, so the row stays and the history
    // keeps reading; it is simply no longer offered to a document that is about to be created.
    expect(await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, 'ZQ'))).toBeUndefined();
    expect(await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, 'ZR'))).toBeDefined();
  });

  it('keeps one tenant’s types out of another tenant’s', async () => {
    await withTenant(tenant.client, (tx) => tx.insert(salesDocumentType).values({
      client: tenant.client, documentType: 'ZY', name: 'One tenant’s own type',
      numberRangeObject: 'SALESORD', numberRangeSubObject: 'ZY', isActive: true, createdBy: ACTOR,
    }));
    const seenByOwner = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, 'ZY'));
    const seenByOther = await withTenant(other.client, (tx) => salesDocumentTypeFor(tx, other.client, 'ZY'));
    expect(seenByOwner?.documentType).toBe('ZY');
    expect(seenByOther).toBeUndefined();
  });

  it('delivers the cancellation type an invoice cancels into, and the interval it draws from', async () => {
    // A cancellation document is a document, and it needs the same two things any other one does: a type and
    // somewhere to draw its number from. Both arrive with the tenant — the type in the sales document type
    // configuration, the interval in the number ranges.
    const invoice = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, STANDARD_BILLING_TYPE));
    expect(invoice?.cancellationDocumentType).toBe(STANDARD_BILLING_CANCELLATION_TYPE);

    const cancellation = await withTenant(tenant.client, (tx) => salesDocumentTypeFor(tx, tenant.client, STANDARD_BILLING_CANCELLATION_TYPE));
    expect(cancellation?.numberRangeObject).toBe('BILLING');
    expect(cancellation?.numberRangeSubObject).toBe('S1');
    // The interval those numbers come from is asserted in sales-delivery.test.ts, where the fixture defines
    // its number ranges: a fixture tenant does not go through createTenant, so it holds only the intervals a
    // test asked for, and this file asks for none.
  });

  it('refuses a cancellation type that does not stand', async () => {
    // The column carries a foreign key, so a type cannot point its cancellations at thin air: a
    // misconfiguration that would otherwise surface as a document that cannot be drawn. Inserted rather than
    // updated because the application role holds INSERT and SELECT on this table and nothing else — no screen
    // maintains it yet — and the refusal has to be the key's, not the grant's.
    await expect(withTenant(tenant.client, (tx) => tx.insert(salesDocumentType).values({
      client: tenant.client, documentType: 'Z1', name: 'Points at nothing',
      numberRangeObject: 'BILLING', numberRangeSubObject: 'Z1',
      cancellationDocumentType: 'ZZ', createdBy: ACTOR,
    }))).rejects.toThrow(/cancellation_document_type|foreign key/i);
  });

  it('leaves no tenant in the database without the delivered types', async () => {
    // The migration backfilled every tenant standing when it ran; the standard configuration package seeds
    // every tenant created since. A tenant with none of them cannot create an order, a delivery or a billing
    // document, so the two paths have to agree — this is the assertion that would catch them drifting apart.
    const orphans = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select c.client, v.document_type
        from client c
        cross join (values ('OR'), ('LF'), ('F2'), ('S1')) as v (document_type)
       where not exists (
         select 1 from sales_document_type t
          where t.client = c.client and t.document_type = v.document_type
       )
    `)) as unknown as Array<{ client: string; document_type: string }>;
    expect(orphans.map((row) => `${row.client}/${row.document_type}`)).toEqual([]);
  });
});

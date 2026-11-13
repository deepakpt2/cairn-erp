/**
 * The quality services are enforced where they write, not where they are called from.
 *
 * A lot, a result and a usage decision are each an act by somebody in a plant: a
 * lot names goods standing in one, a result is a finding about them, and a
 * decision puts them somewhere. The screens ask before they call — and the
 * services ask again, because a screen is not the only caller. A usage decision
 * posts a stock movement through the transfer service, a closing run posts the
 * same movement from a job, and a provisioning phase posts it from a container:
 * an engine that only some of its callers question has a way in.
 *
 * These cases therefore call the services directly, with real identities built
 * in the tenant: a row in `app_user`, a role carrying a chosen set of
 * authorities, restriction rows, and a live session. What is proved is not that
 * an error is thrown but what the refusal says and what was left behind — a
 * refusal that wrote half a document would be worse than none.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { hashPassword } from '../src/platform/auth/password';
import { createSession } from '../src/platform/auth/session';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../src/platform/tables/security';
import { defineRange } from '../src/platform/numbering';
import { derivePosition } from '../src/platform/periods';
import { createTenant, destroyTenant, defineTestRanges, dateFromToday } from './helpers';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postTransfer as postTransferService } from '../src/modules/inventory/transfer-posting';
import { createOrder } from '../src/modules/purchasing/orders';
import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { openLot as openLotService } from '../src/modules/quality/lot';
import {
  recordInspectionResult as recordResultService,
  saveCharacteristic,
} from '../src/modules/quality/inspection-results';
import { postUsageDecisionWithStock as postDecisionService } from '../src/modules/quality/usage-decision';

const ACTOR = 'QM_AUTHZ_TEST';
const MATERIAL = 'MAT-QMA01';
const PLANT = '1000';
const OTHER_PLANT = '9999';
const STORE = '0001';
const TODAY = new Date().toISOString().slice(0, 10);

const LOT_CAPABILITY = 'QM.LOT.CREATE';
const RESULT_CAPABILITY = 'QM.INSPECTION.RECORD';
const DECISION_CAPABILITY = 'QM.USAGE.DECIDE';
const STOCK_CAPABILITY = 'QM.STOCK.POST';
const TRANSFER_CAPABILITY = 'INV.TRANSFER.POST';

/** Everything an inspector who also moves the goods holds. */
const FULL = [LOT_CAPABILITY, RESULT_CAPABILITY, DECISION_CAPABILITY, STOCK_CAPABILITY, TRANSFER_CAPABILITY];

let tenant: any;
let counter = 0;
const key = (what: string) => `qm-authz-${what}-${++counter}`;

interface Actor {
  username: string;
  authorization: { userId: string; sessionId: string };
}

/**
 * Build a real identity in the tenant.
 *
 * `capabilities` is the whole of what the actor may do, and `plants` the whole of
 * where: an empty list of plants is an actor with a company and no plant, which
 * is the ordinary way to prove that a plant-scoped service refuses.
 */
async function createActor(
  name: string,
  capabilities: readonly string[],
  plants: readonly string[],
): Promise<Actor> {
  const userId = randomUUID();
  const username = `qm.authz.${name}.${userId.slice(0, 8)}`;
  const roleCode = `QM_AUTHZ_${name.toUpperCase()}`;
  const client = tenant.client;
  return withTenant(client, async (tx) => {
    for (const code of capabilities) {
      await tx.insert(capability).values({
        code,
        module: code.split('.')[0],
        description: `Test authority ${code}`,
        action: 'POST',
      }).onConflictDoNothing();
    }
    await tx.insert(role).values({
      client,
      code: roleCode,
      name: `Quality authorisation test — ${name}`,
      description: 'Disposable role for the quality service authorisation tests',
      isSystemRole: false,
      isReadOnly: false,
      createdBy: ACTOR,
    }).onConflictDoNothing();
    for (const code of capabilities) {
      await tx.insert(roleCapability).values({
        client, roleCode, capabilityCode: code, createdBy: ACTOR,
      }).onConflictDoNothing();
    }
    await tx.insert(appUser).values({
      id: userId,
      client,
      username,
      fullName: `Quality authorisation test — ${name}`,
      passwordHash: await hashPassword('QualityAuthzTest123!'),
      isActive: true,
      createdBy: ACTOR,
    });
    await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR });
    await tx.insert(authOrgRestriction).values([
      { id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE', scopeValue: PLANT, createdBy: ACTOR },
      ...plants.map((scopeValue) => ({
        id: randomUUID(), client, userId, scopeType: 'PLANT', scopeValue, createdBy: ACTOR,
      })),
    ]);
    await createSession(tx, { client, userId, ipAddress: '127.0.0.1', userAgent: 'qm-authz-test', ttlMinutes: 60 });
    const sessions = await tx.execute(sql`
      select id from user_session where client = ${client} and user_id = ${userId}
      order by issued_at desc limit 1
    `) as unknown as Array<{ id: string }>;
    if (!sessions[0]) throw new Error('The quality authorisation test session was not persisted.');
    return { username, authorization: { userId, sessionId: sessions[0].id } };
  });
}

/** How many of something the tenant holds. */
async function count(statement: string): Promise<number> {
  return withTenant(tenant.client, async (tx) => {
    const rows = await tx.execute(sql.raw(statement)) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

function lots(): Promise<number> {
  return count(`select count(*) as n from quality_lot where client = '${tenant.client}'`);
}

function results(): Promise<number> {
  return count(`select count(*) as n from inspection_result where client = '${tenant.client}'`);
}

function decisions(): Promise<number> {
  return count(`select count(*) as n from usage_decision where client = '${tenant.client}'`);
}

function transfers(): Promise<number> {
  return count(`select count(*) as n from material_document_line
                 where client = '${tenant.client}' and movement_type in ('TRANSFER_STYPE', 'TRANSFER_STYPE_BLOCK')`);
}

/** The quantity standing in one stock segment. */
async function stockOf(stockType: string): Promise<number> {
  return withTenant(tenant.client, async (tx) => {
    const rows = await tx.execute(sql`
      select coalesce(sum(quantity::numeric), 0)::text as n from stock_quantity
       where client = ${tenant.client} and material_number = ${MATERIAL}
         and plant = ${PLANT} and storage_location = ${STORE} and stock_type = ${stockType}
    `) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

/** A receipt standing in inspection stock, and the order behind it. */
async function standingReceipt(quantity: number): Promise<string> {
  const order = await createOrder({
    client: tenant.client,
    changedBy: ACTOR,
    supplierNumber: 'V10000',
    purchasingOrg: PLANT,
    purchasingGroup: '001',
    companyCode: PLANT,
    currency: '',
    items: [{
      materialNumber: MATERIAL,
      shortText: 'Inspected plates',
      quantity,
      unit: 'PC',
      netPrice: 10,
      priceUnit: 1,
      taxCode: '',
      plant: PLANT,
      storageLocation: STORE,
      markedForDeletion: false,
      scheduleLines: [{ deliveryDate: dateFromToday(12), quantity }],
      assignments: [] as never[],
    }],
  });
  const doc = await postGoodsReceipt({
    client: tenant.client,
    changedBy: ACTOR,
    orderNumber: order.orderNumber,
    documentDate: TODAY,
    postingDate: TODAY,
    requestKey: key('gr'),
    stockType: 'QUALITY',
    lines: [{ itemNumber: 10, quantity, storageLocation: STORE }],
  });
  return doc.materialDocumentNumber;
}

describe('quality services, judged where they write', () => {
  let document = '';

  afterAll(async () => {
    if (tenant?.client) await destroyTenant(tenant.client);
  });

  beforeAll(async () => {
    tenant = await createTenant('qm-service-authorization');
    await defineTestRanges(tenant);
    const position = await withTenant(tenant.client, (tx) =>
      derivePosition(tx, tenant.client, 'K4', TODAY));
    await initializeMaterialPeriodControl({
      client: tenant.client,
      changedBy: ACTOR,
      companyCode: PLANT,
      fiscalYear: position.fiscalYear,
      period: position.period,
      reason: 'Quality service authorisation',
    });
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, {
        client: tenant.client, objectCode: 'PURCHORD', subObject: 'POF',
        prefix: 'POF', numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'MATDOC', subObject: '*',
        prefix: '', numberLength: 10, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'INSPLOT', subObject: '*',
        prefix: 'QL', numberLength: 7, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${tenant.client}, '1000', 'Test purchasing organization', '1000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${tenant.client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Inspected plates', 'RAW', 'PC', false, ${ACTOR})
        on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${tenant.client}, ${MATERIAL}, '1000', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        )
        values (${tenant.client}, ${MATERIAL}, '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${tenant.client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${tenant.client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
        on conflict do nothing
      `);
    });
    document = await standingReceipt(10);
    await saveCharacteristic({
      client: tenant.client,
      changedBy: ACTOR,
      characteristicCode: 'DIM01',
      description: 'Outer diameter',
      characteristicType: 'QUANTITATIVE',
      nominalValue: 50,
      tolerancePlus: 1,
      toleranceMinus: -1,
      unit: 'MM',
    });
  });

  it('refuses to open a lot for nobody', async () => {
    const before = await lots();
    await expect(openLotService({
      client: tenant.client,
      changedBy: ACTOR,
      materialDocumentNumber: document,
      lineNumber: 1,
      requestKey: key('lot-nobody'),
    })).rejects.toThrow(/signed-in user/);
    expect(await lots()).toBe(before);
  });

  it('refuses to open a lot in a plant the actor was not given', async () => {
    const elsewhere = await createActor('elsewhere', FULL, [OTHER_PLANT]);
    const before = await lots();
    await expect(openLotService({
      client: tenant.client,
      changedBy: elsewhere.username,
      materialDocumentNumber: document,
      lineNumber: 1,
      requestKey: key('lot-scope'),
    }, { authorization: elsewhere.authorization })).rejects.toThrow(new RegExp(`cover plant ${PLANT}`));
    expect(await lots()).toBe(before);
  });

  it('opens the lot for an inspector whose reach covers the plant', async () => {
    const inspector = await createActor('inspector', FULL, [PLANT]);
    const before = await lots();
    const lot = await openLotService({
      client: tenant.client,
      changedBy: inspector.username,
      materialDocumentNumber: document,
      lineNumber: 1,
      inspectionNote: 'Goods received for inspection',
      requestKey: key('lot-ok'),
    }, { authorization: inspector.authorization });
    expect(await lots()).toBe(before + 1);
    tenant.lot = lot.lotNumber;
  });

  it('refuses a result from somebody who does not hold the result authority', async () => {
    const clerk = await createActor('clerk', [LOT_CAPABILITY], [PLANT]);
    const before = await results();
    await expect(recordResultService({
      client: tenant.client,
      changedBy: clerk.username,
      lotNumber: tenant.lot,
      characteristicCode: 'DIM01',
      resultValue: '50.2',
      measuredUnit: 'MM',
    }, { authorization: clerk.authorization })).rejects.toThrow(new RegExp(RESULT_CAPABILITY));
    expect(await results()).toBe(before);
  });

  it('records the result for an inspector who holds it', async () => {
    const inspector = await createActor('measurer', FULL, [PLANT]);
    const before = await results();
    await recordResultService({
      client: tenant.client,
      changedBy: inspector.username,
      lotNumber: tenant.lot,
      characteristicCode: 'DIM01',
      resultValue: '50.2',
      measuredUnit: 'MM',
    }, { authorization: inspector.authorization });
    expect(await results()).toBe(before + 1);
  });

  it('refuses a decision that moves stock from somebody who may not move it', async () => {
    const decider = await createActor('decider', [DECISION_CAPABILITY, TRANSFER_CAPABILITY], [PLANT]);
    const before = { decisions: await decisions(), transfers: await transfers(), quality: await stockOf('QUALITY') };
    await expect(postDecisionService({
      client: tenant.client,
      changedBy: decider.username,
      lotNumber: tenant.lot,
      decisionCode: 'ACCEPT',
      requestKey: key('dec-stock'),
    }, { authorization: decider.authorization })).rejects.toThrow(new RegExp(STOCK_CAPABILITY));
    expect(await decisions()).toBe(before.decisions);
    expect(await transfers()).toBe(before.transfers);
    expect(await stockOf('QUALITY')).toBe(before.quality);
  });

  it('refuses a decision whose movement the actor may not post', async () => {
    // The inspector holds the quality authorities and not the inventory one: the
    // decision moves stock, and a movement is posted by somebody who may move
    // stock — the same rule an issue to a production order lives under.
    const decider = await createActor('nomove', [DECISION_CAPABILITY, STOCK_CAPABILITY], [PLANT]);
    const before = { decisions: await decisions(), transfers: await transfers(), quality: await stockOf('QUALITY') };
    await expect(postDecisionService({
      client: tenant.client,
      changedBy: decider.username,
      lotNumber: tenant.lot,
      decisionCode: 'ACCEPT',
      requestKey: key('dec-move'),
    }, { authorization: decider.authorization })).rejects.toThrow(new RegExp(TRANSFER_CAPABILITY));
    expect(await decisions()).toBe(before.decisions);
    expect(await transfers()).toBe(before.transfers);
    expect(await stockOf('QUALITY')).toBe(before.quality);
  });

  it('refuses a transfer posted by nobody, and one posted outside the actor’s reach', async () => {
    const before = await transfers();
    await expect(postTransferService({
      client: tenant.client,
      changedBy: ACTOR,
      movementTypeCode: '321',
      materialNumber: MATERIAL,
      quantity: 1,
      issuingPlant: PLANT,
      issuingStorageLocation: STORE,
      receivingPlant: PLANT,
      receivingStorageLocation: STORE,
      postingDate: TODAY,
      documentDate: TODAY,
      requestKey: key('tr-nobody'),
    })).rejects.toThrow(/signed-in user/);

    const elsewhere = await createActor('mover-elsewhere', [TRANSFER_CAPABILITY], [OTHER_PLANT]);
    await expect(postTransferService({
      client: tenant.client,
      changedBy: elsewhere.username,
      movementTypeCode: '321',
      materialNumber: MATERIAL,
      quantity: 1,
      issuingPlant: PLANT,
      issuingStorageLocation: STORE,
      receivingPlant: PLANT,
      receivingStorageLocation: STORE,
      postingDate: TODAY,
      documentDate: TODAY,
      requestKey: key('tr-scope'),
    }, { authorization: elsewhere.authorization })).rejects.toThrow(new RegExp(`cover plant ${PLANT}`));
    expect(await transfers()).toBe(before);
  });

  it('decides, and moves the goods, for an inspector who holds both', async () => {
    const inspector = await createActor('both', FULL, [PLANT]);
    const before = { quality: await stockOf('QUALITY'), free: await stockOf('UNRESTRICTED') };
    const decided = await postDecisionService({
      client: tenant.client,
      changedBy: inspector.username,
      lotNumber: tenant.lot,
      decisionCode: 'ACCEPT',
      decisionDate: TODAY,
      postingDate: TODAY,
      requestKey: key('dec-ok'),
    }, { authorization: inspector.authorization });
    expect(decided.stockPosted).toBe(true);
    expect(await stockOf('QUALITY')).toBe(before.quality - 10);
    expect(await stockOf('UNRESTRICTED')).toBe(before.free + 10);
  });
});

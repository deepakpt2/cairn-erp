import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  ReservationError,
  completeReservationItem,
  createReservation,
  getReservation,
  withdrawReservation,
  type CreateReservationInput,
} from '../src/modules/inventory/reservations';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * SCR-133 / MB21 acceptance for INV.RESERVATION.CREATE.
 *
 * The suite pins the reservation itself — a numbered RKPF header and its RESB
 * items, the 201 movement with a real cost centre, the refusals by name — and the
 * obligation the round carries: an open reservation is a REQUIREMENT in MD04 at
 * its required date, withdrawn in part it still demands the remainder, and
 * completed or fully withdrawn it stops being a demand at once.
 */
const ACTOR = 'SCR133_MB21_TEST';
const DAY = '2026-10-15';

describe('SCR-133 reservations (MB21)', () => {
  let client = '';
  let area = 'A000';
  let key = 0;
  const nextKey = () => `scr133-${++key}`;

  const input = (overrides: Partial<CreateReservationInput> = {}): CreateReservationInput => ({
    client,
    changedBy: ACTOR,
    movementTypeCode: '201',
    baseDate: '2026-11-20',
    costCenter: 'CC1000',
    items: [
      { materialNumber: 'MAT-RSV', plant: '1000', requiredQuantity: 25, storageLocation: '0001' },
    ],
    requestKey: nextKey(),
    ...overrides,
  });

  beforeAll(async () => {
    const tenant = await createTenant('scr133-mb21');
    client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    area = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select controlling_area from controlling_area where client = ${client} order by controlling_area limit 1
      `) as unknown as Array<{ controlling_area: string }>;
      return rows[0]?.controlling_area ?? 'A000';
    });
    await withTenant(client, async (tx) => {
      await defineRange(tx, {
        client, objectCode: 'RESERV', subObject: '*', prefix: 'RSV', numberLength: 8, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by) values
          (${client}, '2000', 'Second plant', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, created_by) values
          (${client}, '1000', '0001', 'Main store', true, ${ACTOR}),
          (${client}, '1000', '0099', 'Blocked store', false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-RSV', 'Reserved material', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by) values
          (${client}, 'MAT-RSV', '1000', ${ACTOR}), (${client}, 'MAT-RSV', '2000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
        select ${client}, '2000', 'Second company', 'KW', ${tenant.currency}, c.chart_of_accounts, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '3000', 'Third plant', '2000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'MAT-RSV', '3000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into controlling_area_company (client, controlling_area, company_code, created_by) values
          (${client}, ${area}, '2000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by) values
          (${client}, ${area}, 'CC1000', '2026-01-01', '2026-12-31', 'Main centre', 'PRODUCTION', '1000', false, ${ACTOR}),
          (${client}, ${area}, 'CC2000', '2026-01-01', '2026-12-31', 'Locked centre', 'PRODUCTION', '1000', true, ${ACTOR}),
          (${client}, ${area}, 'CC3000', '2026-01-01', '2026-03-31', 'Expired centre', 'PRODUCTION', '1000', false, ${ACTOR})
        on conflict do nothing
      `);
      // A stock position so MD04 has a base to stand on.
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
          (${client}, 'MAT-RSV', '1000', '0001', 'UNRESTRICTED', 100, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function md04() {
    return stockRequirementsList({
      client,
      today: '2026-10-15',
      selection: {
        material: 'MAT-RSV', plant: '1000', periodSplit: 'DAILY', maxHits: 500,
      },
    });
  }

  it('writes a numbered header and its items, deriving the company code from the plant', async () => {
    const created = await createReservation(input({
      items: [
        { materialNumber: 'MAT-RSV', plant: '1000', requiredQuantity: 25, storageLocation: '0001' },
        { materialNumber: 'MAT-RSV', plant: '2000', requiredQuantity: 10 },
      ],
    }));
    expect(created.reservationNumber).toMatch(/^RSV-/);
    expect(created.movementType).toBe('RESERV_ISSUE_CC');
    expect(created.movementCode).toBe('201');
    expect(created.costCenter).toBe('CC1000');
    expect(created.accountAssignment).toBe('COST_CENTER');
    expect(created.items).toHaveLength(2);
    expect(created.items[0].itemNumber).toBe(10);
    expect(created.items[1].itemNumber).toBe(20);
    expect(created.items[0].requiredQuantity).toBe('25.000');
    expect(created.items[0].openQuantity).toBe('25.000');
    expect(created.items[1].storageLocation).toBeNull();
    expect(created.items[1].unit).toBe('PC');
  });

  it('shows an open reservation as a requirement in MD04 at its required date', async () => {
    const created = await createReservation(input());
    const list = await md04();
    const element = list.rows.find(
      (e) => e.elementType === 'RESERVATION' && e.documentNumber === created.reservationNumber,
    );
    expect(element).toBeDefined();
    expect(element!.direction).toBe('REQUIREMENT');
    expect(element!.date).toBe('2026-11-20');
    expect(element!.quantity).toBe(25);
    expect(element!.drillDown).toContain('/inventory/reservations');
  });

  it('keeps the remainder as demand after a part withdrawal, and completes it in full', async () => {
    const created = await createReservation(input());
    const first = await withdrawReservation({
      client, changedBy: ACTOR, reservationNumber: created.reservationNumber,
      itemNumber: 10, quantity: 10,
    });
    expect(first.items[0].withdrawnQuantity).toBe('10.000');
    expect(first.items[0].openQuantity).toBe('15.000');
    expect(first.items[0].isCompleted).toBe(false);

    const list = await md04();
    const element = list.rows.find(
      (e) => e.elementType === 'RESERVATION' && e.documentNumber === created.reservationNumber,
    );
    expect(element!.quantity).toBe(15);

    const second = await withdrawReservation({
      client, changedBy: ACTOR, reservationNumber: created.reservationNumber,
      itemNumber: 10, quantity: 15,
    });
    expect(second.items[0].isCompleted).toBe(true);
    expect(second.items[0].openQuantity).toBe('0.000');

    const after = await md04();
    expect(after.rows.some(
      (e) => e.elementType === 'RESERVATION' && e.documentNumber === created.reservationNumber,
    )).toBe(false);
  });

  it('drops a completed item out of the demand at once', async () => {
    const created = await createReservation(input());
    const completed = await completeReservationItem({
      client, changedBy: ACTOR, reservationNumber: created.reservationNumber, itemNumber: 10,
    });
    expect(completed.items[0].isCompleted).toBe(true);
    const list = await md04();
    expect(list.rows.some(
      (e) => e.elementType === 'RESERVATION' && e.documentNumber === created.reservationNumber,
    )).toBe(false);
  });

  it('refuses an over-withdrawal, a completed item and a forbidden movement', async () => {
    const created = await createReservation(input());
    await expect(withdrawReservation({
      client, changedBy: ACTOR, reservationNumber: created.reservationNumber, itemNumber: 10, quantity: 30,
    })).rejects.toThrow(/exceeds the 25\.000 still open/);

    const forbidden = await createReservation(input({
      items: [{ materialNumber: 'MAT-RSV', plant: '1000', requiredQuantity: 5, movementAllowed: false }],
    }));
    await expect(withdrawReservation({
      client, changedBy: ACTOR, reservationNumber: forbidden.reservationNumber, itemNumber: 10, quantity: 1,
    })).rejects.toThrow(/does not allow movements/);

    await withdrawReservation({
      client, changedBy: ACTOR, reservationNumber: created.reservationNumber, itemNumber: 10, quantity: 25,
    });
    await expect(withdrawReservation({
      client, changedBy: ACTOR, reservationNumber: created.reservationNumber, itemNumber: 10, quantity: 1,
    })).rejects.toThrow(/already completed/);
  });

  it('refuses a reservation without a cost centre, and a cost centre that does not stand', async () => {
    await expect(createReservation(input({ costCenter: undefined })))
      .rejects.toThrow(/charges a cost centre, and none was named/);
    await expect(createReservation(input({ costCenter: 'CC9999' })))
      .rejects.toThrow(/Cost centre CC9999 does not stand in company code 1000/);
    await expect(createReservation(input({ costCenter: 'CC2000' })))
      .rejects.toThrow(/locked for postings/);
    const expired = await createReservation(input({ costCenter: 'CC3000', baseDate: '2026-11-20' }))
      .catch((e: unknown) => e);
    expect((expired as ReservationError).message).toMatch(/not valid on 2026-11-20/);
  });

  it('refuses the 261 order movement by name, naming the missing order capability', async () => {
    const error = await createReservation(input({ movementTypeCode: '261' })).catch((e: unknown) => e);
    expect((error as ReservationError).message).toMatch(/carries no order master/);
    expect((error as ReservationError).remedy).toMatch(/PROD.ORDER.CREATE/);
  });

  it('refuses an unknown movement type, an unknown material and a foreign storage location', async () => {
    await expect(createReservation(input({ movementTypeCode: '101' })))
      .rejects.toThrow(/101 is not a reservation movement/);
    await expect(createReservation(input({ items: [{ materialNumber: 'NOPE', plant: '1000', requiredQuantity: 1 }] })))
      .rejects.toThrow(/Material NOPE does not exist/);
    await expect(createReservation(input({ items: [{ materialNumber: 'MAT-RSV', plant: '2000', requiredQuantity: 1, storageLocation: '0001' }] })))
      .rejects.toThrow(/Storage location 0001 does not stand in plant 2000/);
    await expect(createReservation(input({ items: [{ materialNumber: 'MAT-RSV', plant: '1000', requiredQuantity: 1, storageLocation: '0099' }] })))
      .rejects.toThrow(/is blocked/);
  });

  it('refuses an empty reservation, a non-positive quantity and an unwritten material', async () => {
    await expect(createReservation(input({ items: [] })))
      .rejects.toThrow(/at least one item/);
    await expect(createReservation(input({ items: [{ materialNumber: 'MAT-RSV', plant: '1000', requiredQuantity: 0 }] })))
      .rejects.toThrow(/positive quantity/);
    await expect(createReservation(input({ baseDate: '20.11.2026' })))
      .rejects.toThrow(/is not a date/);
  });

  it('refuses plants in two company codes, because one cost centre cannot bear both', async () => {
    const error = await createReservation(input({
      items: [
        { materialNumber: 'MAT-RSV', plant: '1000', requiredQuantity: 1 },
        { materialNumber: 'MAT-RSV', plant: '3000', requiredQuantity: 1 },
      ],
    })).catch((e: unknown) => e);
    expect((error as ReservationError).message).toMatch(/plants in 2 company codes \(1000, 2000\)/);
  });

  it('returns the reservation already standing for a replayed request key', async () => {
    const request = input();
    const first = await createReservation(request);
    const second = await createReservation(request);
    expect(second.reservationNumber).toBe(first.reservationNumber);
    expect((await getReservation(client, first.reservationNumber))!.items).toHaveLength(1);
  });
});

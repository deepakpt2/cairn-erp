/**
 * Sales condition records — the price a customer is charged for a material (VK11 create, VK12 change,
 * VK13 display).
 *
 * A condition record is not edited in place. Saving a price for a period that a standing record already
 * covers either refuses — because silently overwriting the figure an earlier order read would break the
 * order — or closes the standing record at the day before the new one starts and inserts the new span.
 * That is why the sales order can name the record it priced from and be read back years later.
 */
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { bpRole, businessPartner } from '../foundation/business-partner-schema';
import { currency } from '../../platform/tables/reference';
import { material } from '../inventory/schema';
import { salesArea } from '../foundation/schema';
import { CONDITION_TYPES, salesConditionRecord } from './schema';

export const CONDITION_CAPABILITY = 'CFG.SALES.CONDITION.MAINTAIN';
export const CONDITION_OBJECT_CLASS = 'sales_condition_record';
export const CONDITION_ROUTE = '/sales/conditions';
export const CONDITION_ALIASES = ['VK11', 'VK12', 'VK13'] as const;

export class ConditionError extends Error {
  remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'ConditionError';
    this.remedy = remedy;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');

export const conditionInput = z.object({
  client: key(4),
  changedBy: z.string().trim().min(1).max(60),
  salesOrg: key(4),
  distributionChannel: key(2),
  division: key(2),
  /** Absent or blank means the record is customer-independent. */
  customerNumber: z.union([z.undefined(), z.literal(''), key(40)]),
  /** Absent or blank means the record is material-independent. */
  materialNumber: z.union([z.undefined(), z.literal(''), key(40)]),
  currency: key(3),
  amount: z.coerce.number().min(0),
  priceUnit: z.coerce.number().int().positive().default(1),
  validityFrom: isoDate,
  validityTo: isoDate,
  /** Set only by a deliberate replacement of the price that stands for the overlapping period. */
  supersedeStanding: z.boolean().default(false),
});

export type ConditionInput = z.infer<typeof conditionInput>;

/**
 * The record key, derived from the business key rather than drawn from a number range: the same
 * combination of sales area, customer, material and start date prices once, so a derived key cannot
 * collide and no range has to be maintained for a price.
 */
function deriveConditionNumber(input: {
  salesOrg: string; distributionChannel: string; division: string;
  customerNumber?: string; materialNumber?: string; validityFrom: string;
}): string {
  const basis = [input.salesOrg, input.distributionChannel, input.division,
    input.customerNumber ?? '', input.materialNumber ?? ''].join('|');
  let hash = 5381;
  for (let i = 0; i < basis.length; i += 1) hash = ((hash * 33) ^ basis.charCodeAt(i)) >>> 0;
  const tail = hash.toString(36).toUpperCase().padStart(6, '0').slice(-6);
  const day = input.validityFrom.replaceAll('-', '');
  return `PR${day}${tail}`.slice(0, 18);
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface ConditionView {
  conditionNumber: string;
  conditionType: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  customerNumber: string;
  materialNumber: string;
  currency: string;
  amount: string;
  priceUnit: number;
  validityFrom: string;
  validityTo: string;
  changedBy: string | null;
}

function mapRecord(row: typeof salesConditionRecord.$inferSelect): ConditionView {
  return {
    conditionNumber: row.conditionNumber,
    conditionType: row.conditionType,
    salesOrg: row.salesOrg,
    distributionChannel: row.distributionChannel,
    division: row.division,
    customerNumber: row.customerNumber,
    materialNumber: row.materialNumber,
    currency: row.currency,
    amount: row.amount,
    priceUnit: row.priceUnit,
    validityFrom: row.validityFrom,
    validityTo: row.validityTo,
    changedBy: row.changedBy ?? row.createdBy,
  };
}

/**
 * Save a price. The standing record for an overlapping period is closed at the day before, never
 * overwritten, and the change is written to the order items that read the old price as nothing at all:
 * an order keeps the condition number it was priced from.
 */
export async function saveSalesCondition(input: ConditionInput): Promise<{
  condition: ConditionView;
  closedConditionNumber: string | null;
  superseded: boolean;
}> {
  const parsed = conditionInput.parse(input);
  if (!parsed.customerNumber && !parsed.materialNumber) {
    throw new ConditionError(
      'A condition record must name a customer, a material, or both.',
      'A price stated for nobody and nothing is not a record: name the customer, the material, or both.',
    );
  }
  if (parsed.validityTo < parsed.validityFrom) {
    throw new ConditionError(
      `The validity period ends ${parsed.validityTo}, before it starts on ${parsed.validityFrom}.`,
      'Enter a last day on or after the first day.',
    );
  }
  return withTenant(parsed.client, async (tx) => {
    const [area] = await tx.select().from(salesArea).where(and(
      eq(salesArea.client, parsed.client),
      eq(salesArea.salesOrg, parsed.salesOrg),
      eq(salesArea.distributionChannel, parsed.distributionChannel),
      eq(salesArea.division, parsed.division),
    )).limit(1);
    if (!area) {
      throw new ConditionError(
        `Sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division} does not stand.`,
        'Define the sales area before pricing into it.',
      );
    }
    if (!area.isActive) {
      throw new ConditionError(
        `Sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division} is not active.`,
        'Price in an active sales area.',
      );
    }
    if (parsed.customerNumber) {
      const [role] = await tx.select().from(bpRole).where(and(
        eq(bpRole.client, parsed.client),
        eq(bpRole.partnerNumber, parsed.customerNumber),
        eq(bpRole.roleCode, 'CUSTOMER'),
      )).limit(1);
      if (!role) {
        const [partner] = await tx.select({ partnerNumber: businessPartner.partnerNumber }).from(businessPartner)
          .where(and(eq(businessPartner.client, parsed.client), eq(businessPartner.partnerNumber, parsed.customerNumber)))
          .limit(1);
        throw new ConditionError(
          partner
            ? `Business partner ${parsed.customerNumber} is not maintained in the customer role.`
            : `Customer ${parsed.customerNumber} does not stand as a business partner.`,
          partner
            ? 'Extend the partner with the FL customer role, then price for it.'
            : 'Maintain the business partner first. A condition record does not create a customer.',
        );
      }
    }
    if (parsed.materialNumber) {
      const [item] = await tx.select({ materialNumber: material.materialNumber }).from(material)
        .where(and(eq(material.client, parsed.client), eq(material.materialNumber, parsed.materialNumber)))
        .limit(1);
      if (!item) {
        throw new ConditionError(
          `Material ${parsed.materialNumber} does not stand in this client.`,
          'Maintain the material first. A condition record does not create it.',
        );
      }
    }
    const [money] = await tx.select({ code: currency.code }).from(currency)
      .where(eq(currency.code, parsed.currency)).limit(1);
    if (!money) {
      throw new ConditionError(`Currency ${parsed.currency} does not stand.`, 'Price in a currency that exists.');
    }

    const overlaps = await tx.select().from(salesConditionRecord).where(and(
      eq(salesConditionRecord.client, parsed.client),
      eq(salesConditionRecord.conditionType, CONDITION_TYPES[0]),
      eq(salesConditionRecord.salesOrg, parsed.salesOrg),
      eq(salesConditionRecord.distributionChannel, parsed.distributionChannel),
      eq(salesConditionRecord.division, parsed.division),
      eq(salesConditionRecord.customerNumber, parsed.customerNumber ?? ''),
      eq(salesConditionRecord.materialNumber, parsed.materialNumber ?? ''),
      sql`${salesConditionRecord.validityTo} >= ${parsed.validityFrom}`,
    )).orderBy(desc(salesConditionRecord.validityFrom));
    if (overlaps.length && !parsed.supersedeStanding) {
      const first = overlaps[0];
      throw new ConditionError(
        `Record ${first.conditionNumber} already prices this combination from ${first.validityFrom} to ${first.validityTo}, which the new period overlaps.`,
        'Narrow the new validity period, or save again with the replacement confirmed so the standing record closes the day before the new one starts.',
      );
    }
    // The most recent overlapping span is the one that stands today; it is closed at the day before.
    const closed = overlaps.length
      ? await tx.update(salesConditionRecord)
        .set({
          validityTo: addDays(parsed.validityFrom, -1),
          changedBy: parsed.changedBy,
          changedAt: new Date(),
        })
        .where(and(
          eq(salesConditionRecord.client, parsed.client),
          eq(salesConditionRecord.conditionNumber, overlaps[0].conditionNumber),
          sql`${salesConditionRecord.validityFrom} <= ${parsed.validityFrom}`,
        ))
        .returning({ conditionNumber: salesConditionRecord.conditionNumber })
      : [];
    if (overlaps.length && !closed.length) {
      throw new ConditionError(
        `The standing record ${overlaps[0].conditionNumber} starts on or after the new period, so it cannot be closed by a predecessor.`,
        'Save the earlier period first, or correct the new record to start after the standing one.',
      );
    }
    if (overlaps.length && addDays(parsed.validityFrom, -1) < overlaps[0].validityFrom) {
      throw new ConditionError(
        `Closing record ${overlaps[0].conditionNumber} the day before ${parsed.validityFrom} would leave it with no period at all.`,
        'Start the new record after the standing one ends, or let the standing record be the earlier one.',
      );
    }

    const conditionNumber = deriveConditionNumber(parsed);
    const [inserted] = await tx.insert(salesConditionRecord).values({
      client: parsed.client,
      conditionNumber,
      conditionType: CONDITION_TYPES[0],
      salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel,
      division: parsed.division,
      customerNumber: parsed.customerNumber ?? '',
      materialNumber: parsed.materialNumber ?? '',
      currency: parsed.currency,
      amount: parsed.amount.toFixed(4),
      priceUnit: parsed.priceUnit,
      validityFrom: parsed.validityFrom,
      validityTo: parsed.validityTo,
      createdBy: parsed.changedBy,
    }).onConflictDoNothing({
      target: [
        salesConditionRecord.client, salesConditionRecord.conditionType, salesConditionRecord.salesOrg,
        salesConditionRecord.distributionChannel, salesConditionRecord.division, salesConditionRecord.customerNumber,
        salesConditionRecord.materialNumber, salesConditionRecord.validityFrom,
      ],
    }).returning();
    if (!inserted) {
      throw new ConditionError(
        `A record for this combination already stands from ${parsed.validityFrom}.`,
        'Enter a start date the standing record does not use, or correct the record that does.',
      );
    }

    await recordChange(tx, {
      client: parsed.client, objectClass: CONDITION_OBJECT_CLASS, objectKey: conditionNumber,
      changeType: overlaps.length ? 'CHANGE' : 'CREATE', changedBy: parsed.changedBy,
      before: overlaps.length
        ? { conditionNumber: overlaps[0].conditionNumber, validityTo: overlaps[0].validityTo, amount: overlaps[0].amount }
        : undefined,
      after: { amount: parsed.amount.toFixed(4), currency: parsed.currency, validityFrom: parsed.validityFrom, validityTo: parsed.validityTo },
    });
    return {
      condition: mapRecord(inserted),
      closedConditionNumber: closed.length ? closed[0].conditionNumber : null,
      superseded: overlaps.length > 0,
    };
  });
}

export async function listSalesConditions(
  client: string,
  filter: { customerNumber?: string; materialNumber?: string; validOn?: string } = {},
): Promise<ConditionView[]> {
  return withTenant(client, async (tx) => {
    const conditions = [eq(salesConditionRecord.client, client)];
    if (filter.customerNumber) conditions.push(eq(salesConditionRecord.customerNumber, filter.customerNumber.trim().toUpperCase()));
    if (filter.materialNumber) conditions.push(eq(salesConditionRecord.materialNumber, filter.materialNumber.trim().toUpperCase()));
    if (filter.validOn) {
      conditions.push(sql`${salesConditionRecord.validityFrom} <= ${filter.validOn}`);
      conditions.push(sql`${salesConditionRecord.validityTo} >= ${filter.validOn}`);
    }
    const rows = await tx.select().from(salesConditionRecord).where(and(...conditions))
      .orderBy(desc(salesConditionRecord.validityFrom), desc(salesConditionRecord.conditionNumber)).limit(200);
    return rows.map(mapRecord);
  });
}



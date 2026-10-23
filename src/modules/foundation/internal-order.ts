/**
 * Internal order master — KO01 create, KO02 change, KO03 display.
 *
 * An internal order is a cost object. Saving it does not post, budget,
 * plan, or settle. IO01 is a configured type, not a meaning in this
 * service. There is no status profile. Journal lines may cite the order
 * number as text; this service does not rewrite them.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { appUser } from '../../platform/tables/security';
import {
  companyCode,
  controllingArea,
  controllingAreaCompany,
  costCenter,
  internalOrder,
  internalOrderType,
  profitCenter,
} from './schema';
import { journalEntry, journalEntryLine } from '../finance/schema';

export const INTERNAL_ORDER_MAINTAIN_CAPABILITY = 'CO.ORDER.MAINTAIN';
export const INTERNAL_ORDER_DISPLAY_CAPABILITY = 'CO.ORDER.DISPLAY';
export const INTERNAL_ORDER_OBJECT_CLASS = 'internal_order';
export const INTERNAL_ORDER_ROUTE = '/controlling/internal-orders';

export class InternalOrderError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InternalOrderError';
    this.remedy = remedy;
  }
}

const documentInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  orderType: z.string().trim().min(2).max(4),
  description: z.string().trim().min(1).max(40),
  controllingArea: z.string().trim().min(4).max(4),
  companyCode: z.string().trim().min(1).max(10),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  personResponsible: z.string().trim().max(20).optional().default(''),
  responsibleUser: z.string().trim().max(40).optional().default(''),
  costCenter: z.string().trim().max(10).optional().default(''),
  profitCenter: z.string().trim().max(10).optional().default(''),
  statistical: z.boolean().optional(),
  isPostingLocked: z.boolean().optional().default(false),
  markedForDeletion: z.boolean().optional().default(false),
  sourceOrderNumber: z.string().trim().max(20).optional().default(''),
  requestKey: z.string().trim().max(64).optional(),
  orderNumber: z.string().trim().max(20).optional().default(''),
}).strict();

export type CreateInternalOrderInput = z.input<typeof documentInput>;

export interface InternalOrderDocument {
  orderNumber: string;
  orderType: string;
  description: string;
  controllingArea: string;
  companyCode: string;
  currency: string;
  startDate: string;
  endDate: string;
  personResponsible: string | null;
  responsibleUser: string | null;
  costCenter: string | null;
  profitCenter: string | null;
  statistical: boolean;
  isPostingLocked: boolean;
  markedForDeletion: boolean;
  sourceOrderNumber: string | null;
  journalCount: number;
}

function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function day(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function shown(value: string | number | boolean | null | undefined): string {
  if (value == null || value === '') return '';
  return String(value);
}

async function loadType(tx: Tx, client: string, code: string) {
  const [row] = await tx.select().from(internalOrderType).where(and(
    eq(internalOrderType.client, client),
    eq(internalOrderType.orderType, code.trim().toUpperCase()),
    eq(internalOrderType.isActive, true),
  ));
  if (!row) {
    throw new InternalOrderError(
      `Order type ${code} is not an active internal-order type.`,
      'Maintain the order type. IO01 is not assumed when it is not configured.',
    );
  }
  return row;
}

async function journalDates(tx: Tx, client: string, orderNumber: string): Promise<string[]> {
  const rows = await tx.select({ postingDate: journalEntry.postingDate }).from(journalEntryLine)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, journalEntryLine.client),
      eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
      eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
    ))
    .where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.internalOrder, orderNumber),
    ));
  return rows.map((row) => day(row.postingDate));
}

async function judge(
  tx: Tx,
  client: string,
  input: z.infer<typeof documentInput>,
  currency: string,
) {
  if (input.endDate < input.startDate) {
    throw new InternalOrderError('The end date is before the start date.');
  }
  const areaCode = input.controllingArea.trim().toUpperCase();
  const [area] = await tx.select().from(controllingArea).where(and(
    eq(controllingArea.client, client), eq(controllingArea.controllingArea, areaCode),
  ));
  if (!area?.isActive) throw new InternalOrderError(`Controlling area ${areaCode} does not exist or is inactive.`);
  const company = input.companyCode.trim().toUpperCase();
  const [assignment] = await tx.select().from(controllingAreaCompany).where(and(
    eq(controllingAreaCompany.client, client),
    eq(controllingAreaCompany.controllingArea, areaCode),
    eq(controllingAreaCompany.companyCode, company),
  ));
  if (!assignment) {
    throw new InternalOrderError(`Company code ${company} is not assigned to controlling area ${areaCode}.`);
  }
  const [companyRow] = await tx.select().from(companyCode).where(and(
    eq(companyCode.client, client), eq(companyCode.companyCode, company),
  ));
  if (!companyRow) throw new InternalOrderError(`Company code ${company} does not exist.`);
  const orderCurrency = currency.trim().toUpperCase();
  if (orderCurrency !== area.currency.trim().toUpperCase()) {
    throw new InternalOrderError(
      `The order currency is the controlling area currency ${area.currency.trim()}.`,
      'A second order currency is not stored.',
    );
  }
  const user = blank(input.responsibleUser);
  if (user) {
    const [person] = await tx.select().from(appUser).where(and(
      eq(appUser.client, client), eq(appUser.username, user), eq(appUser.isActive, true),
    ));
    if (!person) throw new InternalOrderError(`Responsible user ${user} is not an active user of this client.`);
  }
  const center = blank(input.costCenter)?.toUpperCase() ?? null;
  if (center) {
    const rows = await tx.select().from(costCenter).where(and(
      eq(costCenter.client, client),
      eq(costCenter.controllingArea, areaCode),
      eq(costCenter.costCenter, center),
      eq(costCenter.companyCode, company),
    ));
    const standing = rows.find((row) => day(row.validFrom) <= input.endDate && day(row.validTo) >= input.startDate);
    if (!standing) {
      throw new InternalOrderError(`Cost center ${center} is not valid for this order in controlling area ${areaCode}.`);
    }
  }
  const profit = blank(input.profitCenter)?.toUpperCase() ?? null;
  if (profit) {
    const rows = await tx.select().from(profitCenter).where(and(
      eq(profitCenter.client, client),
      eq(profitCenter.controllingArea, areaCode),
      eq(profitCenter.profitCenter, profit),
    ));
    const standing = rows.find((row) => day(row.validFrom) <= input.endDate && day(row.validTo) >= input.startDate);
    if (!standing) {
      throw new InternalOrderError(`Profit center ${profit} is not valid for this order in controlling area ${areaCode}.`);
    }
  }
  return {
    controllingArea: areaCode,
    companyCode: company,
    currency: orderCurrency,
    personResponsible: blank(input.personResponsible),
    responsibleUser: user,
    costCenter: center,
    profitCenter: profit,
  };
}

function snapshot(row: {
  description: string;
  startDate: string;
  endDate: string;
  personResponsible: string | null;
  responsibleUser: string | null;
  costCenter: string | null;
  profitCenter: string | null;
  statistical: boolean;
  isPostingLocked: boolean;
  markedForDeletion: boolean;
}): Record<string, unknown> {
  return {
    description: row.description,
    startDate: row.startDate,
    endDate: row.endDate,
    personResponsible: shown(row.personResponsible),
    responsibleUser: shown(row.responsibleUser),
    costCenter: shown(row.costCenter),
    profitCenter: shown(row.profitCenter),
    statistical: row.statistical ? 'true' : 'false',
    postingLocked: row.isPostingLocked ? 'true' : 'false',
    markedForDeletion: row.markedForDeletion ? 'true' : 'false',
  };
}

export async function createInternalOrder(
  raw: CreateInternalOrderInput,
): Promise<{ orderNumber: string }> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InternalOrderError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  if (blank(input.orderNumber)) {
    throw new InternalOrderError(
      'This number range assigns the order number. A typed number is not accepted.',
      'Leave the order number empty. External numbering is not assigned by this service.',
    );
  }
  const orderNumber = await withTenant(input.client, async (tx) => {
    if (input.requestKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/internal_order/request/${input.requestKey}`}, 0))`);
      const [existing] = await tx.select().from(internalOrder).where(and(
        eq(internalOrder.client, input.client), eq(internalOrder.requestKey, input.requestKey),
      ));
      if (existing) return existing.orderNumber;
    }
    const type = await loadType(tx, input.client, input.orderType);
    const source = blank(input.sourceOrderNumber);
    let sourceRow: typeof internalOrder.$inferSelect | undefined;
    if (source) {
      const [row] = await tx.select().from(internalOrder).where(and(
        eq(internalOrder.client, input.client), eq(internalOrder.orderNumber, source),
      ));
      if (!row) throw new InternalOrderError(`Reference order ${source} does not exist.`);
      if (row.controllingArea !== input.controllingArea.trim().toUpperCase() || row.companyCode !== input.companyCode.trim().toUpperCase()) {
        throw new InternalOrderError('A reference order must belong to the same controlling area and company code.');
      }
      sourceRow = row;
    }
    const [area] = await tx.select().from(controllingArea).where(and(
      eq(controllingArea.client, input.client),
      eq(controllingArea.controllingArea, input.controllingArea.trim().toUpperCase()),
    ));
    const judged = await judge(tx, input.client, input, area?.currency ?? '');
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client,
        objectCode: 'INTORDER',
        companyCode: '*',
        subObject: type.numberRangeSubObject || '*',
        fiscalYear: 0,
        allocatedBy: input.changedBy,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No internal-order number could be drawn.';
      throw new InternalOrderError(message, 'Define an internal INTORDER interval, then save again.');
    }
    if (drawn.display.length > 20) {
      throw new InternalOrderError('The drawn order number is longer than the order number field.');
    }
    await tx.insert(internalOrder).values({
      client: input.client,
      orderNumber: drawn.display,
      orderType: type.orderType,
      description: input.description,
      controllingArea: judged.controllingArea,
      companyCode: judged.companyCode,
      currency: judged.currency,
      startDate: input.startDate,
      endDate: input.endDate,
      personResponsible: judged.personResponsible,
      responsibleUser: judged.responsibleUser,
      costCenter: judged.costCenter,
      profitCenter: judged.profitCenter,
      statistical: input.statistical ?? sourceRow?.statistical ?? type.statisticalDefault,
      isPostingLocked: false,
      markedForDeletion: false,
      sourceOrderNumber: source,
      requestKey: input.requestKey ?? null,
      createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client,
      objectClass: INTERNAL_ORDER_OBJECT_CLASS,
      objectKey: drawn.display,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: 'KO01',
      after: { orderType: type.orderType, description: input.description, controllingArea: judged.controllingArea },
    });
    return drawn.display;
  });
  return { orderNumber };
}

export async function changeInternalOrder(
  raw: CreateInternalOrderInput & { orderNumber: string },
): Promise<{ orderNumber: string }> {
  const { orderNumber: supplied, ...document } = raw;
  const parsed = documentInput.safeParse({ ...document, orderNumber: '' });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InternalOrderError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const number = supplied.trim();
  if (!number) throw new InternalOrderError('An order number is required.');
  await withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/internal_order/${number}`}, 0))`);
    const [before] = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, input.client), eq(internalOrder.orderNumber, number),
    ));
    if (!before) throw new InternalOrderError(`Internal order ${number} does not exist.`);
    if (before.markedForDeletion) {
      throw new InternalOrderError(`Internal order ${number} is marked for deletion and cannot be changed.`);
    }
    if (input.orderType.trim().toUpperCase() !== before.orderType) {
      throw new InternalOrderError('The order type cannot be changed after the order is saved.');
    }
    if (input.controllingArea.trim().toUpperCase() !== before.controllingArea || input.companyCode.trim().toUpperCase() !== before.companyCode) {
      throw new InternalOrderError('Controlling area and company code stay as saved.');
    }
    const judged = await judge(tx, input.client, input, before.currency);
    const dates = await journalDates(tx, input.client, number);
    if (dates.some((date) => date < input.startDate || date > input.endDate)) {
      throw new InternalOrderError(
        'The new validity excludes a journal posting that already cites this order.',
        'The journal line is not rewritten. Widen the dates, or leave them as saved.',
      );
    }
    await tx.update(internalOrder).set({
      description: input.description,
      startDate: input.startDate,
      endDate: input.endDate,
      personResponsible: judged.personResponsible,
      responsibleUser: judged.responsibleUser,
      costCenter: judged.costCenter,
      profitCenter: judged.profitCenter,
      statistical: input.statistical ?? before.statistical,
      isPostingLocked: input.isPostingLocked,
      markedForDeletion: input.markedForDeletion,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(eq(internalOrder.client, input.client), eq(internalOrder.orderNumber, number)));
    const [after] = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, input.client), eq(internalOrder.orderNumber, number),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: INTERNAL_ORDER_OBJECT_CLASS,
      objectKey: number,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: 'KO02',
      before: snapshot(before),
      after: snapshot(after ?? before),
    });
  });
  return { orderNumber: number };
}

async function toDocument(tx: Tx, client: string, row: typeof internalOrder.$inferSelect): Promise<InternalOrderDocument> {
  const dates = await journalDates(tx, client, row.orderNumber);
  return {
    orderNumber: row.orderNumber,
    orderType: row.orderType,
    description: row.description,
    controllingArea: row.controllingArea,
    companyCode: row.companyCode,
    currency: row.currency,
    startDate: row.startDate,
    endDate: row.endDate,
    personResponsible: row.personResponsible,
    responsibleUser: row.responsibleUser,
    costCenter: row.costCenter,
    profitCenter: row.profitCenter,
    statistical: row.statistical,
    isPostingLocked: row.isPostingLocked,
    markedForDeletion: row.markedForDeletion,
    sourceOrderNumber: row.sourceOrderNumber,
    journalCount: dates.length,
  };
}

export async function getInternalOrder(client: string, orderNumber: string): Promise<InternalOrderDocument | null> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, client), eq(internalOrder.orderNumber, orderNumber.trim()),
    ));
    if (!row) return null;
    return toDocument(tx, client, row);
  });
}

export async function listInternalOrders(client: string): Promise<InternalOrderDocument[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(internalOrder).where(eq(internalOrder.client, client))
      .orderBy(asc(internalOrder.orderNumber));
    const listed: InternalOrderDocument[] = [];
    for (const row of rows) listed.push(await toDocument(tx, client, row));
    return listed;
  });
}

export async function internalOrderChoices(client: string) {
  return withTenant(client, async (tx) => {
    const [types, areas, companies, centers, profits] = await Promise.all([
      tx.select().from(internalOrderType).where(and(
        eq(internalOrderType.client, client), eq(internalOrderType.isActive, true),
      )).orderBy(asc(internalOrderType.orderType)),
      tx.select().from(controllingArea).where(eq(controllingArea.client, client)).orderBy(asc(controllingArea.controllingArea)),
      tx.select().from(controllingAreaCompany).where(eq(controllingAreaCompany.client, client)),
      tx.select().from(costCenter).where(eq(costCenter.client, client)).orderBy(asc(costCenter.costCenter)),
      tx.select().from(profitCenter).where(eq(profitCenter.client, client)).orderBy(asc(profitCenter.profitCenter)),
    ]);
    return {
      types: types.map((row) => ({ orderType: row.orderType, description: row.description })),
      areas: areas.map((row) => ({ controllingArea: row.controllingArea, name: row.name, currency: row.currency.trim() })),
      companies: companies.map((row) => ({ controllingArea: row.controllingArea, companyCode: row.companyCode })),
      costCenters: centers.map((row) => ({ controllingArea: row.controllingArea, companyCode: row.companyCode, costCenter: row.costCenter, name: row.name })),
      profitCenters: profits.map((row) => ({ controllingArea: row.controllingArea, profitCenter: row.profitCenter, name: row.name })),
    };
  });
}

/**
 * KO22 — change the original budget of an internal order.
 *
 * A save writes a new budget document. It does not rewrite an earlier
 * document, post a journal, create a supplement or a return, or settle.
 * BP01 is configured data. Availability control is stored and not executed.
 * There is no second availability-control engine here.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition } from '../../platform/periods';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { numberRange } from '../../platform/tables/numbering';
import { journalEntryLine } from '../finance/schema';
import {
  controllingArea,
  internalOrder,
  internalOrderBudgetProfile,
  internalOrderOriginalBudget,
  internalOrderOriginalBudgetYear,
  internalOrderTypeBudgetProfile,
} from './schema';

export const ORIGINAL_BUDGET_CHANGE_CAPABILITY = 'CO.BUDGET.ORIGINAL.CHANGE';
export const ORIGINAL_BUDGET_DISPLAY_CAPABILITY = 'CO.BUDGET.ORIGINAL.DISPLAY';
export const ORIGINAL_BUDGET_ROUTE = '/controlling/original-budget';
export const ORIGINAL_BUDGET_OBJECT_CLASS = 'internal_order_original_budget';

export class InternalOrderBudgetError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InternalOrderBudgetError';
    this.remedy = remedy;
  }
}

const annualInput = z.object({
  fiscalYear: z.number().int(),
  amount: z.string().trim().min(1).max(24),
}).strict();

const changeInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  orderNumber: z.string().trim().min(1).max(20),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  overallAmount: z.string().trim().max(24).optional(),
  annual: z.array(annualInput).optional(),
  documentText: z.string().trim().max(50).optional().default(''),
  currency: z.string().trim().max(3).optional().default(''),
  requestKey: z.string().trim().max(64).optional(),
}).strict();

export type ChangeOriginalBudgetInput = z.input<typeof changeInput>;

export interface OriginalBudgetYear {
  fiscalYear: number;
  amount: string;
}

export interface OriginalBudgetDocument {
  documentNumber: string;
  documentDate: string;
  fiscalYear: number;
  period: number;
  overallAmount: string | null;
  documentText: string | null;
  annual: OriginalBudgetYear[];
  createdAt: string;
}

export interface OriginalBudgetView {
  orderNumber: string;
  description: string;
  orderType: string;
  controllingArea: string;
  companyCode: string;
  currency: string;
  budgetProfile: string | null;
  availabilityControl: boolean;
  availabilityControlExecuted: false;
  changeAllowed: boolean;
  overallAmount: string | null;
  annual: OriginalBudgetYear[];
  documents: OriginalBudgetDocument[];
  supplementsConfigured: false;
  returnsConfigured: false;
  carryforwardConfigured: false;
  currentBudgetCalculated: false;
  journalCount: number;
}

const profileInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  profileCode: z.string().trim().min(2).max(6),
  description: z.string().trim().min(1).max(40),
  overallBudget: z.boolean(),
  annualBudget: z.boolean(),
  annualNotExceedOverall: z.boolean().optional().default(false),
  availabilityControl: z.boolean().optional().default(false),
  changeAllowed: z.boolean().optional().default(true),
}).strict();

function calendarDate(value: string): void {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new InternalOrderBudgetError(`${value} is not a calendar date.`);
  }
}

function money(value: string): string {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new InternalOrderBudgetError('The budget amount must be a nonnegative amount.');
  }
  const fraction = value.split('.')[1] ?? '';
  if (fraction.length > 4) {
    throw new InternalOrderBudgetError('The budget amount has more than 4 decimal places.');
  }
  return fromScaled(toScaled(value, 4), 4);
}

function shownTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function assertRange(client: string): Promise<void> {
  await withTenant(client, async (tx) => {
    const [range] = await tx.select().from(numberRange).where(and(
      eq(numberRange.client, client),
      eq(numberRange.objectCode, 'ORDBUDGET'),
      eq(numberRange.companyCode, '*'),
      eq(numberRange.subObject, '*'),
      eq(numberRange.fiscalYear, 0),
    ));
    if (!range || range.isExternal) {
      throw new InternalOrderBudgetError(
        'No internal ORDBUDGET number range stands, so no budget document can be drawn.',
        'Define an internal ORDBUDGET interval. External numbering is not assigned by this service.',
      );
    }
  });
}

async function latestDocument(tx: Tx, client: string, orderNumber: string) {
  const [header] = await tx.select().from(internalOrderOriginalBudget).where(and(
    eq(internalOrderOriginalBudget.client, client),
    eq(internalOrderOriginalBudget.orderNumber, orderNumber),
  )).orderBy(desc(internalOrderOriginalBudget.createdAt), desc(internalOrderOriginalBudget.documentNumber)).limit(1);
  if (!header) return null;
  const years = await tx.select().from(internalOrderOriginalBudgetYear).where(and(
    eq(internalOrderOriginalBudgetYear.client, client),
    eq(internalOrderOriginalBudgetYear.documentNumber, header.documentNumber),
  )).orderBy(asc(internalOrderOriginalBudgetYear.fiscalYear));
  return { header, years };
}

async function journalCount(tx: Tx, client: string, orderNumber: string): Promise<number> {
  const rows = await tx.select({ documentNumber: journalEntryLine.documentNumber }).from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client),
    eq(journalEntryLine.internalOrder, orderNumber),
  ));
  return rows.length;
}

export async function saveBudgetProfile(raw: z.input<typeof profileInput>): Promise<void> {
  const parsed = profileInput.safeParse(raw);
  if (!parsed.success) throw new InternalOrderBudgetError(parsed.error.issues[0].message);
  const input = parsed.data;
  if (!input.overallBudget && !input.annualBudget) {
    throw new InternalOrderBudgetError('A budget profile must allow an overall budget, an annual budget, or both.');
  }
  await withTenant(input.client, async (tx) => {
    await tx.insert(internalOrderBudgetProfile).values({
      client: input.client,
      profileCode: input.profileCode.toUpperCase(),
      description: input.description,
      overallBudget: input.overallBudget,
      annualBudget: input.annualBudget,
      annualNotExceedOverall: input.annualNotExceedOverall,
      availabilityControl: input.availabilityControl,
      changeAllowed: input.changeAllowed,
      isActive: true,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [internalOrderBudgetProfile.client, internalOrderBudgetProfile.profileCode],
      set: {
        description: input.description,
        overallBudget: input.overallBudget,
        annualBudget: input.annualBudget,
        annualNotExceedOverall: input.annualNotExceedOverall,
        availabilityControl: input.availabilityControl,
        changeAllowed: input.changeAllowed,
        isActive: true,
        changedBy: input.changedBy,
        changedAt: new Date(),
      },
    });
  });
}

export async function assignOrderTypeBudgetProfile(raw: {
  client: string;
  changedBy: string;
  orderType: string;
  profileCode: string;
}): Promise<void> {
  const orderType = raw.orderType.trim().toUpperCase();
  const profileCode = raw.profileCode.trim().toUpperCase();
  await withTenant(raw.client, async (tx) => {
    const [profile] = await tx.select().from(internalOrderBudgetProfile).where(and(
      eq(internalOrderBudgetProfile.client, raw.client),
      eq(internalOrderBudgetProfile.profileCode, profileCode),
      eq(internalOrderBudgetProfile.isActive, true),
    ));
    if (!profile) throw new InternalOrderBudgetError(`Budget profile ${profileCode} is not an active profile.`);
    await tx.insert(internalOrderTypeBudgetProfile).values({
      client: raw.client,
      orderType,
      profileCode,
      createdBy: raw.changedBy,
    }).onConflictDoUpdate({
      target: [internalOrderTypeBudgetProfile.client, internalOrderTypeBudgetProfile.orderType],
      set: { profileCode, changedBy: raw.changedBy, changedAt: new Date() },
    });
  });
}

export async function getOriginalBudget(client: string, orderNumber: string): Promise<OriginalBudgetView | null> {
  return withTenant(client, async (tx) => {
    const [order] = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, client),
      eq(internalOrder.orderNumber, orderNumber.trim()),
    ));
    if (!order) return null;
    const [assignment] = await tx.select().from(internalOrderTypeBudgetProfile).where(and(
      eq(internalOrderTypeBudgetProfile.client, client),
      eq(internalOrderTypeBudgetProfile.orderType, order.orderType),
    ));
    const [profile] = assignment
      ? await tx.select().from(internalOrderBudgetProfile).where(and(
          eq(internalOrderBudgetProfile.client, client),
          eq(internalOrderBudgetProfile.profileCode, assignment.profileCode),
        ))
      : [];
    const headers = await tx.select().from(internalOrderOriginalBudget).where(and(
      eq(internalOrderOriginalBudget.client, client),
      eq(internalOrderOriginalBudget.orderNumber, order.orderNumber),
    )).orderBy(desc(internalOrderOriginalBudget.createdAt), desc(internalOrderOriginalBudget.documentNumber));
    const documents: OriginalBudgetDocument[] = [];
    for (const header of headers) {
      const years = await tx.select().from(internalOrderOriginalBudgetYear).where(and(
        eq(internalOrderOriginalBudgetYear.client, client),
        eq(internalOrderOriginalBudgetYear.documentNumber, header.documentNumber),
      )).orderBy(asc(internalOrderOriginalBudgetYear.fiscalYear));
      documents.push({
        documentNumber: header.documentNumber,
        documentDate: header.documentDate,
        fiscalYear: header.fiscalYear,
        period: header.period,
        overallAmount: header.overallAmount,
        documentText: header.documentText,
        annual: years.map((year) => ({ fiscalYear: year.fiscalYear, amount: year.amount })),
        createdAt: shownTime(header.createdAt),
      });
    }
    const current = documents[0];
    return {
      orderNumber: order.orderNumber,
      description: order.description,
      orderType: order.orderType,
      controllingArea: order.controllingArea,
      companyCode: order.companyCode,
      currency: order.currency.trim(),
      budgetProfile: profile?.profileCode ?? null,
      availabilityControl: profile?.availabilityControl ?? false,
      availabilityControlExecuted: false,
      changeAllowed: profile?.changeAllowed ?? false,
      overallAmount: current?.overallAmount ?? null,
      annual: current?.annual ?? [],
      documents,
      supplementsConfigured: false,
      returnsConfigured: false,
      carryforwardConfigured: false,
      currentBudgetCalculated: false,
      journalCount: await journalCount(tx, client, order.orderNumber),
    };
  });
}

export async function changeOriginalBudget(raw: ChangeOriginalBudgetInput): Promise<{ documentNumber: string }> {
  const parsed = changeInput.safeParse(raw);
  if (!parsed.success) throw new InternalOrderBudgetError(parsed.error.issues[0].message);
  const input = parsed.data;
  calendarDate(input.documentDate);
  await assertRange(input.client);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/internal_order/${input.orderNumber}`}, 0))`);
    if (input.requestKey) {
      const [existing] = await tx.select().from(internalOrderOriginalBudget).where(and(
        eq(internalOrderOriginalBudget.client, input.client),
        eq(internalOrderOriginalBudget.requestKey, input.requestKey),
      ));
      if (existing) return { documentNumber: existing.documentNumber };
    }
    const [order] = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, input.client),
      eq(internalOrder.orderNumber, input.orderNumber),
    ));
    if (!order) throw new InternalOrderBudgetError(`Internal order ${input.orderNumber} does not exist.`);
    if (order.markedForDeletion) {
      throw new InternalOrderBudgetError(`Internal order ${order.orderNumber} is marked for deletion. Its original budget cannot be changed.`);
    }
    const suppliedCurrency = input.currency.trim().toUpperCase();
    if (suppliedCurrency && suppliedCurrency !== order.currency.trim().toUpperCase()) {
      throw new InternalOrderBudgetError(`The budget currency is the order currency ${order.currency.trim()}.`);
    }
    const [assignment] = await tx.select().from(internalOrderTypeBudgetProfile).where(and(
      eq(internalOrderTypeBudgetProfile.client, input.client),
      eq(internalOrderTypeBudgetProfile.orderType, order.orderType),
    ));
    if (!assignment) {
      throw new InternalOrderBudgetError(
        `No budget profile is configured for order type ${order.orderType}.`,
        'Assign a budget profile. BP01 is not assumed when it is not configured.',
      );
    }
    const [profile] = await tx.select().from(internalOrderBudgetProfile).where(and(
      eq(internalOrderBudgetProfile.client, input.client),
      eq(internalOrderBudgetProfile.profileCode, assignment.profileCode),
      eq(internalOrderBudgetProfile.isActive, true),
    ));
    if (!profile) throw new InternalOrderBudgetError(`Budget profile ${assignment.profileCode} is not active.`);
    if (!profile.changeAllowed) {
      throw new InternalOrderBudgetError(`Budget profile ${profile.profileCode} does not allow a change to the original budget.`);
    }
    const [area] = await tx.select().from(controllingArea).where(and(
      eq(controllingArea.client, input.client),
      eq(controllingArea.controllingArea, order.controllingArea),
    ));
    if (!area) throw new InternalOrderBudgetError(`Controlling area ${order.controllingArea} does not exist.`);
    const position = await derivePosition(tx, input.client, area.fiscalYearVariant, input.documentDate);
    const start = await derivePosition(tx, input.client, area.fiscalYearVariant, order.startDate);
    const end = await derivePosition(tx, input.client, area.fiscalYearVariant, order.endDate);
    const firstYear = Math.min(start.fiscalYear, end.fiscalYear);
    const lastYear = Math.max(start.fiscalYear, end.fiscalYear);
    const previous = await latestDocument(tx, input.client, order.orderNumber);
    const annual = new Map<number, string>();
    for (const year of previous?.years ?? []) annual.set(year.fiscalYear, year.amount);
    for (const line of input.annual ?? []) {
      if (!profile.annualBudget) {
        throw new InternalOrderBudgetError(`Budget profile ${profile.profileCode} does not use an annual budget.`);
      }
      if (line.fiscalYear < firstYear || line.fiscalYear > lastYear) {
        throw new InternalOrderBudgetError(
          `Fiscal year ${line.fiscalYear} is outside the order validity ${firstYear} to ${lastYear}.`,
          'The year comes from the controlling area fiscal-year variant. A calendar year is not assumed.',
        );
      }
      annual.set(line.fiscalYear, money(line.amount));
    }
    let overall = previous?.header.overallAmount ?? null;
    if (input.overallAmount != null && input.overallAmount !== '') {
      if (!profile.overallBudget) {
        throw new InternalOrderBudgetError(`Budget profile ${profile.profileCode} does not use an overall budget.`);
      }
      overall = money(input.overallAmount);
    }
    if (profile.overallBudget && overall == null) {
      throw new InternalOrderBudgetError('The overall original budget is required for this budget profile.');
    }
    if (profile.annualNotExceedOverall && overall != null) {
      const total = [...annual.values()].reduce((sum, amount) => sum + toScaled(amount, 4), 0n);
      if (total > toScaled(overall, 4)) {
        throw new InternalOrderBudgetError(
          `The annual original budget ${fromScaled(total, 4)} exceeds the overall original budget ${overall}.`,
          'The profile requires annual amounts not to exceed the overall amount. Equality is not required.',
        );
      }
    }
    const drawn = await allocateNumber(tx, {
      client: input.client,
      objectCode: 'ORDBUDGET',
      companyCode: '*',
      subObject: '*',
      fiscalYear: 0,
      allocatedBy: input.changedBy,
    });
    if (drawn.display.length > 20) {
      throw new InternalOrderBudgetError('The drawn budget document number is longer than the document number field.');
    }
    await tx.insert(internalOrderOriginalBudget).values({
      client: input.client,
      documentNumber: drawn.display,
      orderNumber: order.orderNumber,
      documentDate: input.documentDate,
      fiscalYear: position.fiscalYear,
      period: position.period,
      currency: order.currency.trim(),
      overallAmount: overall,
      documentText: input.documentText || null,
      requestKey: input.requestKey ?? null,
      createdBy: input.changedBy,
    });
    for (const [fiscalYear, amount] of [...annual.entries()].sort(([left], [right]) => left - right)) {
      await tx.insert(internalOrderOriginalBudgetYear).values({
        client: input.client,
        documentNumber: drawn.display,
        fiscalYear,
        amount,
        createdBy: input.changedBy,
      });
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: ORIGINAL_BUDGET_OBJECT_CLASS,
      objectKey: drawn.display,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: 'KO22',
      after: {
        orderNumber: order.orderNumber,
        overallAmount: overall ?? '',
        currency: order.currency.trim(),
      },
    });
    return { documentNumber: drawn.display };
  });
}

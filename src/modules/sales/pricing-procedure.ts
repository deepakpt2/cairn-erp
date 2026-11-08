/**
 * Pricing as a procedure.
 *
 * An order price was `PR00` in a constant, and the tax was a rate a service read from the tax master and
 * applied by hand. Two pricing facts, neither of them describable: nobody could say what a customer
 * discount is, because a discount was not a thing — it was an absence of code. A price, a discount, a
 * freight charge and an output tax are the same kind of thing seen four ways: a figure, a base it is
 * calculated on, a sign, and a key the ledger is determined by. So they are rows in a condition type
 * master, ordered into steps of a procedure, and this module walks the steps.
 *
 * What is *not* configurable is how a figure becomes an amount. `FIXED` and `PERCENTAGE` are the two
 * calculations the engine executes, and no amount of configuration invents a third: a pricing engine that
 * can be programmed is a programming language, and this one has to be auditable.
 *
 * Three rules are worth stating because they are the ones that keep the figures honest:
 *
 * The procedure is determined, never found. A document is priced by the procedure the determination names
 * for its sales area, its document type and its customer; when no row stands, the document refuses. A
 * wildcard is a row a tenant can read and replace, not a fallback in the engine.
 *
 * A step that needs a base is calculated on the span of steps it names. This is the whole difference
 * between a discount and a tax: the discount is taken on the price, the tax is charged on the value that
 * survived the discount and the freight. A tax on the gross is a tax on money the customer never paid.
 *
 * And a step with no record standing is a step that contributes nothing, unless the step is required. A
 * customer with no discount record is a customer who pays list price, which is not an error; an item with
 * no price is not priced, which is.
 *
 * Every step that contributed is returned, so the caller can write the document's conditions beside the
 * totals. A discounted invoice whose arithmetic lives nowhere is a number nobody can defend.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { companyCode, taxCode as taxCodeTable } from '../foundation/schema';
import { materialValuation } from '../inventory/schema';
import {
  salesConditionRecord, salesConditionType, salesDocumentCondition, salesPricingProcedureStep,
  salesProcedureDetermination,
} from './schema';

/** Where the procedure is maintained. It names the screen the refusals point a reader to. */
export const PRICING_PROCEDURE_ROUTE = '/config/pricing-procedure';

/** The procedure delivered with the package: price, discount, freight, header freight, tax, cost. */
export const STANDARD_PRICING_PROCEDURE = 'RVAA01';

/**
 * The condition types delivered with the package: a price, a customer discount, a freight charge, a
 * freight charge on the document, a statistical cost and an output tax. The migration seeds the same
 * six for the tenants that stood before it, and a test holds the two lists together — a master that
 * disagrees with its own history is a configuration with two truths in it.
 *
 * Two of them are not priced from a record. The tax is rated by the tax master, because a rate the
 * state sets is not a price a clerk maintains. The cost is read from the valuation of the material,
 * because a cost is what the books say the goods are worth and not what somebody typed into a
 * condition.
 */
export const DELIVERED_CONDITION_TYPES = [
  { conditionType: 'PR00', name: 'Price', conditionClass: 'PRICE', calculationType: 'FIXED', isNegative: false, isStatistical: false, accountKey: 'ERL' },
  { conditionType: 'K007', name: 'Customer discount', conditionClass: 'DISCOUNT', calculationType: 'PERCENTAGE', isNegative: true, isStatistical: false, accountKey: 'ERS' },
  { conditionType: 'KF00', name: 'Freight', conditionClass: 'FREIGHT', calculationType: 'FIXED', isNegative: false, isStatistical: false, accountKey: 'ERF' },
  { conditionType: 'HD00', name: 'Header freight', conditionClass: 'FREIGHT', calculationType: 'FIXED', isNegative: false, isStatistical: false, accountKey: 'ERF' },
  { conditionType: 'VPRS', name: 'Cost', conditionClass: 'COST', calculationType: 'MATERIAL_COST', isNegative: false, isStatistical: true, accountKey: null },
  { conditionType: 'MWST', name: 'Output tax', conditionClass: 'TAX', calculationType: 'PERCENTAGE', isNegative: false, isStatistical: false, accountKey: 'MWS' },
] as const;

/**
 * The delivered procedure, in the order it is executed: the price, the discount taken on the price, the
 * freight, the freight on the document, the tax charged on what survived all three, and the cost the
 * document shows and never charges. Only the price is required — a customer with no discount record
 * pays list price, and an item with no price is not priced.
 */
export const DELIVERED_PRICING_STEPS = [
  { stepNumber: 10, conditionType: 'PR00', fromStep: null, toStep: null, isRequired: true, conditionLevel: 'ITEM' },
  { stepNumber: 20, conditionType: 'K007', fromStep: 10, toStep: 10, isRequired: false, conditionLevel: 'ITEM' },
  { stepNumber: 30, conditionType: 'KF00', fromStep: null, toStep: null, isRequired: false, conditionLevel: 'ITEM' },
  { stepNumber: 35, conditionType: 'HD00', fromStep: null, toStep: null, isRequired: false, conditionLevel: 'HEADER' },
  { stepNumber: 40, conditionType: 'MWST', fromStep: 10, toStep: 35, isRequired: false, conditionLevel: 'ITEM' },
  { stepNumber: 50, conditionType: 'VPRS', fromStep: null, toStep: null, isRequired: false, conditionLevel: 'ITEM' },
] as const;

/** The document pricing procedure a document type carries until a tenant names another, as VOV8 does. */
export const STANDARD_DOCUMENT_PRICING_PROCEDURE = 'A';

export class PricingProcedureError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PricingProcedureError';
    this.remedy = remedy;
  }
}

function round(value: number, places: number): string {
  if (!Number.isFinite(value)) {
    throw new PricingProcedureError('A price did not scale to a number.', 'Check the condition record amount.');
  }
  const factor = 10 ** places;
  return (Math.round((value + Number.EPSILON) * factor) / factor).toFixed(places);
}

const round2 = (value: number) => round(value, 2);
const round4 = (value: number) => round(value, 4);

/** Which key found the record, so a reader can tell a customer price from a general one. */
/**
 * Which key found the record, so a reader can tell a customer price from a general one. `GENERAL` is the
 * row that names neither customer nor material, and it is what a header condition is answered by.
 */
export type ConditionAccess = 'CUSTOMER_MATERIAL' | 'MATERIAL' | 'CUSTOMER' | 'GENERAL';

export interface ProcedureItemInput {
  /** The document line this item belongs to; 0 for a condition carried by the header. */
  lineNumber: number;
  materialNumber: string;
  /** The plant the item is delivered from: the valuation area a cost is read in. */
  plant: string;
  /** The quantity the conditions are calculated on. */
  quantity: number;
  /**
   * The tax code the item is billed under, when it is billed under one. An item with no tax code is not
   * an error — a zero-rated sale is a sale — and the tax step contributes nothing rather than refusing.
   */
  taxCode?: string | null;
}

export interface PricedCondition {
  lineNumber: number;
  stepNumber: number;
  conditionType: string;
  conditionClass: string;
  /**
   * Where the row came from: priced on the line, the whole of a header condition, or this line's share
   * of one. The shares of a header condition sum to the whole, to the cent.
   */
  origin: 'ITEM' | 'HEADER' | 'DISTRIBUTED';
  /** What the step was calculated on, in the document currency. */
  baseValue: string;
  /** The record's amount for a fixed step, the percentage for a percentage step. */
  rate: string;
  /** What the step contributes, signed: a discount carries a negative amount. */
  amount: string;
  priceUnit: number;
  /** The record that answered, where a record answered. A tax names the rate and no record. */
  conditionNumber: string | null;
  accountKey: string | null;
  isStatistical: boolean;
  access: ConditionAccess | null;
}

export interface PricedItem {
  lineNumber: number;
  conditions: PricedCondition[];
  /** The net value: every step that is not tax and not statistical. */
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  /** The unit price the document line carries: the net value per price unit. */
  netPrice: string;
  priceUnit: number;
  /** The tax rate that answered, as the tax master states it. */
  taxRate: string;
  /** The record that priced the item, for the line that has to name one. */
  conditionNumber: string;
}

export interface PriceDocumentInput {
  client: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  customerNumber: string;
  companyCode: string;
  currency: string;
  documentDate: string;
  /** The pricing procedure the document type carries, as VOV8 carries it. */
  documentPricingProcedure: string;
  /** The procedure the customer's sales-area data carries; blank where the customer names none. */
  customerPricingProcedure?: string | null;
  items: ProcedureItemInput[];
}

export interface ProcedureStep {
  stepNumber: number;
  conditionType: string;
  conditionClass: string;
  calculationType: string;
  isStatistical: boolean;
  accountKey: string | null;
}

export interface PricedDocument {
  procedureCode: string;
  /** The steps the procedure executed, in order — what the document's conditions are written from. */
  steps: ProcedureStep[];
  /** The conditions the header carries, in whole, at line 0. */
  headerConditions: PricedCondition[];
  currency: string;
  items: PricedItem[];
  netValue: string;
  taxValue: string;
  grossValue: string;
  /** What each account key carries, for the ledger that will be determined from them. */
  byAccountKey: Array<{ accountKey: string; amount: string }>;
}

interface StepRow {
  stepNumber: number;
  conditionType: string;
  conditionClass: string;
  calculationType: string;
  isNegative: boolean;
  isStatistical: boolean;
  accountKey: string | null;
  fromStep: number | null;
  toStep: number | null;
  isRequired: boolean;
  conditionLevel: 'ITEM' | 'HEADER';
}

/**
 * Which procedure prices this document.
 *
 * Searched most-specific-first: the sales area that names the document and the customer before the row
 * that answers for any area or any customer. When nothing stands, the document is not priced — a price
 * nobody can name the rule for is not a price.
 */
export async function resolvePricingProcedure(
  tx: Tx,
  client: string,
  input: {
    salesOrg: string;
    distributionChannel: string;
    division: string;
    documentPricingProcedure: string;
    customerPricingProcedure?: string | null;
  },
): Promise<string> {
  const customer = (input.customerPricingProcedure ?? '').trim().toUpperCase() || '*';
  const rows = await tx.select().from(salesProcedureDetermination).where(and(
    eq(salesProcedureDetermination.client, client),
    eq(salesProcedureDetermination.documentPricingProcedure, input.documentPricingProcedure.trim().toUpperCase()),
  ));
  const matching = rows.filter((row) => row.customerPricingProcedure === customer
    || row.customerPricingProcedure === '*');
  const specificity = (row: typeof rows[number]): number => {
    const area = (row.salesOrg === input.salesOrg ? 4 : row.salesOrg ? 0 : 2)
      + (row.distributionChannel === input.distributionChannel ? 2 : row.distributionChannel ? 0 : 1)
      + (row.division === input.division ? 1 : row.division ? 0 : 0);
    const customerScore = row.customerPricingProcedure === customer ? 8 : 0;
    return customerScore + area;
  };
  // A row that names a different sales area is not a candidate at all: wrong area, wrong procedure.
  const candidates = matching.filter((row) => (row.salesOrg === '' || row.salesOrg === input.salesOrg)
    && (row.distributionChannel === '' || row.distributionChannel === input.distributionChannel)
    && (row.division === '' || row.division === input.division));
  const best = candidates.sort((a, b) => specificity(b) - specificity(a))[0];
  if (!best) {
    throw new PricingProcedureError(
      `No pricing procedure is determined for document procedure ${input.documentPricingProcedure} and customer procedure ${customer} in sales area ${input.salesOrg}/${input.distributionChannel}/${input.division}, so no document can be priced there.`,
      `Maintain the procedure determination at ${PRICING_PROCEDURE_ROUTE}, naming the procedure this combination is priced by.`,
    );
  }
  return best.procedureCode;
}

/** The steps of a procedure, in the order they are executed. */
async function stepsOf(tx: Tx, client: string, procedureCode: string): Promise<StepRow[]> {
  const rows = await tx.select({
    stepNumber: salesPricingProcedureStep.stepNumber,
    conditionType: salesPricingProcedureStep.conditionType,
    conditionClass: salesConditionType.conditionClass,
    calculationType: salesConditionType.calculationType,
    isNegative: salesConditionType.isNegative,
    isStatistical: salesConditionType.isStatistical,
    accountKey: salesConditionType.accountKey,
    fromStep: salesPricingProcedureStep.fromStep,
    toStep: salesPricingProcedureStep.toStep,
    isRequired: salesPricingProcedureStep.isRequired,
    conditionLevel: salesPricingProcedureStep.conditionLevel,
  }).from(salesPricingProcedureStep)
    .innerJoin(salesConditionType, and(
      eq(salesConditionType.client, salesPricingProcedureStep.client),
      eq(salesConditionType.conditionType, salesPricingProcedureStep.conditionType),
    ))
    .where(and(
      eq(salesPricingProcedureStep.client, client),
      eq(salesPricingProcedureStep.procedureCode, procedureCode),
      // A withdrawn step is not executed. The row stays, because it is part of the rule the documents
      // standing under this procedure were priced by.
      eq(salesPricingProcedureStep.isActive, true),
    ))
    .orderBy(asc(salesPricingProcedureStep.stepNumber));

  if (rows.length === 0) {
    throw new PricingProcedureError(
      `Pricing procedure ${procedureCode} carries no step that stands, so nothing can be priced by it.`,
      `Maintain the steps of ${procedureCode} at ${PRICING_PROCEDURE_ROUTE}.`,
    );
  }
  // The level is one of two words, and anything that is not the header is an item: a column that could
  // hold a third value is not a column this engine would know how to execute.
  return rows.map((row) => ({
    ...row,
    conditionLevel: row.conditionLevel === 'HEADER' ? ('HEADER' as const) : ('ITEM' as const),
  }));
}

/**
 * The condition record that answers for a condition type on this item.
 *
 * The access order is the one the codebase has always used — customer and material, then material alone,
 * then customer alone — and the record with the latest start date that still covers the document date
 * answers. It is fixed because the access sequences are not being reinvented here: what changes is that
 * every step is priced by it, not only the price.
 */
async function findRecord(
  tx: Tx,
  input: {
    client: string;
    conditionType: string;
    salesOrg: string;
    distributionChannel: string;
    division: string;
    customerNumber: string;
    materialNumber: string;
    documentDate: string;
    currency: string;
  },
): Promise<{ amount: string; priceUnit: number; conditionNumber: string; access: ConditionAccess } | undefined> {
  const accesses: Array<{ customer: string; material: string; name: ConditionAccess }> = [
    { customer: input.customerNumber, material: input.materialNumber, name: 'CUSTOMER_MATERIAL' },
    { customer: '', material: input.materialNumber, name: 'MATERIAL' },
    { customer: input.customerNumber, material: '', name: 'CUSTOMER' },
    { customer: '', material: '', name: 'GENERAL' },
  ];
  for (const attempt of accesses) {
    const [found] = await tx.select().from(salesConditionRecord).where(and(
      eq(salesConditionRecord.client, input.client),
      eq(salesConditionRecord.conditionType, input.conditionType),
      eq(salesConditionRecord.salesOrg, input.salesOrg),
      eq(salesConditionRecord.distributionChannel, input.distributionChannel),
      eq(salesConditionRecord.division, input.division),
      eq(salesConditionRecord.customerNumber, attempt.customer),
      eq(salesConditionRecord.materialNumber, attempt.material),
      sql`${salesConditionRecord.validityFrom} <= ${input.documentDate}`,
      sql`${salesConditionRecord.validityTo} >= ${input.documentDate}`,
    )).orderBy(sql`${salesConditionRecord.validityFrom} desc, ${salesConditionRecord.conditionNumber} desc`).limit(1);
    if (!found) continue;
    if (found.currency.trim().toUpperCase() !== input.currency.trim().toUpperCase()) {
      throw new PricingProcedureError(
        `Condition record ${found.conditionNumber} is stated in ${found.currency}, not in the document currency ${input.currency}.`,
        'Maintain a record in the document currency, or price in the currency the record states. A price is never converted silently into a document.',
      );
    }
    return {
      amount: found.amount,
      priceUnit: found.priceUnit,
      conditionNumber: found.conditionNumber,
      access: attempt.name,
    };
  }
  return undefined;
}

/**
 * Price a document through the procedure.
 *
 * The steps are executed in the order they stand, and a step sees the values the steps before it
 * produced. That is what makes a span mean something: a tax on steps 10 to 35 is charged on what
 * survived the price, the discount, the item freight and the header freight — not on the gross, which
 * would be a tax on a discount the customer never paid.
 *
 * A header step is evaluated once for the document and distributed to the items in proportion to what
 * each is worth, because the ledger is determined per line and a figure belonging to no line can be
 * posted to no account the determination chose. The header keeps the whole at line 0; the items carry
 * their share of it.
 */
export async function priceDocument(tx: Tx, input: PriceDocumentInput): Promise<PricedDocument> {
  const procedureCode = await resolvePricingProcedure(tx, input.client, {
    salesOrg: input.salesOrg,
    distributionChannel: input.distributionChannel,
    division: input.division,
    documentPricingProcedure: input.documentPricingProcedure,
    customerPricingProcedure: input.customerPricingProcedure,
  });
  const steps = await stepsOf(tx, input.client, procedureCode);

  // The country the tax code is read in: the country of the company code the document is raised under,
  // which is the country whose tax master rates the sale. A company code that does not stand cannot name
  // one, and a document priced without knowing whose tax rates it is subject to is not priced.
  const [company] = await tx.select({ country: companyCode.country }).from(companyCode)
    .where(and(eq(companyCode.client, input.client), eq(companyCode.companyCode, input.companyCode))).limit(1);
  if (!company) {
    throw new PricingProcedureError(
      `Company code ${input.companyCode} does not stand, so the country whose tax master rates this document cannot be read.`,
      'Name a company code that stands. Every document is taxed by the rates of the country it is raised in.',
    );
  }
  const country = company.country;
  const accountTotals = new Map<string, number>();
  const headerConditions: PricedCondition[] = [];

  const states: ItemState[] = input.items.map((item) => ({
    item,
    conditions: [],
    stepValues: new Map<number, number>(),
    netValue: 0,
    taxValue: 0,
    priceUnit: 1,
    pricedBy: '',
    taxRate: '0.0000',
  }));

  for (const step of steps) {
    const negative = step.isNegative ? -1 : 1;

    if (step.conditionLevel === 'HEADER') {
      const evaluated = await evaluateStep(tx, input, procedureCode, step, {
        lineNumber: 0,
        materialNumber: '',
        plant: '',
        quantity: 0,
        taxCode: null,
        stepValues: documentStepValues(states),
        isHeader: true,
      }, country);
      if (!evaluated) continue;
      const shares = distribute(evaluated.amount, states.map((state) => state.netValue));
      headerConditions.push({
        lineNumber: 0,
        stepNumber: step.stepNumber,
        conditionType: step.conditionType,
        conditionClass: step.conditionClass,
        origin: 'HEADER',
        baseValue: round2(evaluated.base),
        rate: round4(evaluated.rate),
        amount: round2(evaluated.amount * negative),
        priceUnit: evaluated.priceUnit,
        conditionNumber: evaluated.conditionNumber,
        accountKey: step.accountKey,
        isStatistical: step.isStatistical,
        access: evaluated.access,
      });
      states.forEach((state, index) => {
        const share = shares.parts[index] ?? 0;
        state.conditions.push({
          lineNumber: state.item.lineNumber,
          stepNumber: step.stepNumber,
          conditionType: step.conditionType,
          conditionClass: step.conditionClass,
          origin: 'DISTRIBUTED',
          // What the share was taken in proportion to, which is the only base a distributed figure has.
          baseValue: round2(shares.weights[index] ?? 0),
          rate: round4(evaluated.rate),
          amount: round2(share * negative),
          priceUnit: evaluated.priceUnit,
          conditionNumber: evaluated.conditionNumber,
          accountKey: step.accountKey,
          isStatistical: step.isStatistical,
          access: evaluated.access,
        });
        // The share is what the line is worth of this condition, and what a later step sees of it.
        state.stepValues.set(step.stepNumber, share * negative);
        if (!step.isStatistical) {
          if (step.conditionClass === 'TAX') state.taxValue += share;
          else state.netValue += share * negative;
        }
        accumulate(accountTotals, step, share * negative);
      });
      continue;
    }

    for (const state of states) {
      const evaluated = await evaluateStep(tx, input, procedureCode, step, {
        lineNumber: state.item.lineNumber,
        materialNumber: state.item.materialNumber,
        plant: state.item.plant,
        quantity: state.item.quantity,
        taxCode: state.item.taxCode,
        stepValues: state.stepValues,
        isHeader: false,
      }, country);
      if (!evaluated) continue;
      const signed = evaluated.amount * negative;
      state.conditions.push({
        lineNumber: state.item.lineNumber,
        stepNumber: step.stepNumber,
        conditionType: step.conditionType,
        conditionClass: step.conditionClass,
        origin: 'ITEM',
        baseValue: round4(evaluated.base),
        rate: round4(evaluated.rate),
        amount: round2(signed),
        priceUnit: evaluated.priceUnit,
        conditionNumber: evaluated.conditionNumber,
        accountKey: step.accountKey,
        isStatistical: step.isStatistical,
        access: evaluated.access,
      });
      // A step's value is signed: a span that names this step adds what it contributed, and to a
      // discount that means taking away.
      state.stepValues.set(step.stepNumber, signed);
      if (!step.isStatistical) {
        if (step.conditionClass === 'TAX') state.taxValue += evaluated.amount;
        else state.netValue += signed;
      }
      if (step.conditionClass === 'PRICE') {
        state.priceUnit = evaluated.priceUnit;
        state.pricedBy = evaluated.conditionNumber ?? '';
      }
      accumulate(accountTotals, step, signed);
    }
  }

  const items: PricedItem[] = states.map((state) => {
    const net = round2(state.netValue);
    const tax = round2(state.taxValue);
    return {
      lineNumber: state.item.lineNumber,
      conditions: state.conditions,
      netAmount: net,
      taxAmount: tax,
      grossAmount: round2(Number(net) + Number(tax)),
      netPrice: round4((Number(net) * state.priceUnit) / (state.item.quantity === 0 ? 1 : state.item.quantity)),
      priceUnit: state.priceUnit,
      taxRate: state.taxRate,
      conditionNumber: state.pricedBy,
    };
  });

  const netValue = round2(items.reduce((sum, item) => sum + Number(item.netAmount), 0));
  const taxValue = round2(items.reduce((sum, item) => sum + Number(item.taxAmount), 0));
  return {
    procedureCode,
    steps: steps.map((step) => ({
      stepNumber: step.stepNumber,
      conditionType: step.conditionType,
      conditionClass: step.conditionClass,
      calculationType: step.calculationType,
      isStatistical: step.isStatistical,
      accountKey: step.accountKey,
    })),
    headerConditions,
    currency: input.currency,
    items,
    netValue,
    taxValue,
    grossValue: round2(Number(netValue) + Number(taxValue)),
    byAccountKey: [...accountTotals.entries()]
      .map(([accountKey, amount]) => ({ accountKey, amount: round2(amount) }))
      .sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
  };
}

/** What one item carries while the steps are executed. */
interface ItemState {
  item: ProcedureItemInput;
  conditions: PricedCondition[];
  /** What each step contributed to this item, signed: the base a later span is summed from. */
  stepValues: Map<number, number>;
  netValue: number;
  taxValue: number;
  priceUnit: number;
  pricedBy: string;
  taxRate: string;
}

/** What the document carries of every step: the sum over the items of what each contributed. */
function documentStepValues(states: ItemState[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const state of states) {
    for (const [stepNumber, value] of state.stepValues) {
      totals.set(stepNumber, (totals.get(stepNumber) ?? 0) + value);
    }
  }
  return totals;
}

/**
 * Split a figure over the items in proportion to their weights.
 *
 * The shares are whole cents and they sum exactly to the figure: the remainders are given out largest
 * first, so a header condition is never worth a cent more or less than the sum of what the lines carry.
 * That is the whole point of distributing it — a document whose lines do not add up to its value is a
 * document that cannot be reconciled.
 */
function distribute(total: number, weights: number[]): { parts: number[]; weights: number[] } {
  const cents = Math.round(Number(round2(total)) * 100);
  const positive = weights.map((weight) => Math.max(weight, 0));
  const sum = positive.reduce((acc, weight) => acc + weight, 0);
  // Nothing to be in proportion to: every line carries the same share, which is what a document of
  // free goods would otherwise divide by zero to find.
  const basis = sum > 0 ? positive : weights.map(() => 1);
  const totalBasis = basis.reduce((acc, weight) => acc + weight, 0) || 1;
  const exact = basis.map((weight) => (cents * weight) / totalBasis);
  const parts = exact.map((value) => Math.trunc(value));
  let remaining = Math.abs(cents) - parts.reduce((acc, value) => acc + Math.abs(value), 0);
  const order = exact
    .map((value, index) => ({ index, fraction: Math.abs(value) - Math.abs(Math.trunc(value)) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of order) {
    if (remaining <= 0) break;
    // The sign of the whole decides which way a remainder cent goes: a discount's parts stay negative.
    parts[entry.index] += cents < 0 ? -1 : 1;
    remaining -= 1;
  }
  return { parts: parts.map((cents_) => cents_ / 100), weights };
}

/**
 * What one step contributes.
 *
 * `undefined` means the step contributed nothing and was allowed to: no record stood and the step was
 * not required. A required step that finds nothing refuses, because a document priced without the
 * condition its procedure demands is not the document the procedure describes.
 */
async function evaluateStep(
  tx: Tx,
  input: PriceDocumentInput,
  procedureCode: string,
  step: StepRow,
  context: {
    lineNumber: number;
    materialNumber: string;
    plant: string;
    quantity: number;
    taxCode?: string | null;
    stepValues: Map<number, number>;
    isHeader: boolean;
  },
  country: string,
): Promise<{
  amount: number; base: number; rate: number; priceUnit: number;
  conditionNumber: string | null; access: ConditionAccess | null;
} | undefined> {
  if (step.conditionClass === 'TAX') {
    const base = sumSpan(context.stepValues, step.fromStep, step.toStep);
    let rate = 0;
    if (context.taxCode) {
      const [code] = await tx.select({ ratePercent: taxCodeTable.ratePercent }).from(taxCodeTable).where(and(
        eq(taxCodeTable.client, input.client),
        eq(taxCodeTable.country, country),
        eq(taxCodeTable.taxCode, context.taxCode),
      )).limit(1);
      if (!code) {
        throw new PricingProcedureError(
          `Tax code ${context.taxCode} does not stand for country ${country || '(none)'}, the country of company code ${input.companyCode}.`,
          'Maintain the tax code in that country, or leave the item free of tax if that is what the customer is billed at.',
        );
      }
      rate = Number(code.ratePercent);
    }
    return { amount: (base * rate) / 100, base, rate, priceUnit: 1, conditionNumber: null, access: null };
  }

  if (step.calculationType === 'MATERIAL_COST') {
    if (context.isHeader) {
      throw new PricingProcedureError(
        `Step ${step.stepNumber} of procedure ${procedureCode} reads a cost from the material, and a header condition names no material to read it from.`,
        `Move step ${step.stepNumber} to the item level at ${PRICING_PROCEDURE_ROUTE}, or give it a condition type whose rate is maintained.`,
      );
    }
    const [valuation] = await tx.select({
      priceControl: materialValuation.priceControl,
      standardPrice: materialValuation.standardPrice,
      movingAveragePrice: materialValuation.movingAveragePrice,
      priceUnit: materialValuation.priceUnit,
      currency: materialValuation.currency,
    }).from(materialValuation).where(and(
      eq(materialValuation.client, input.client),
      eq(materialValuation.materialNumber, context.materialNumber),
      eq(materialValuation.valuationArea, context.plant),
    )).limit(1);
    // A cost the books do not carry is not a cost of zero: it is absent, and the document shows none.
    if (!valuation) return undefined;
    if (valuation.currency.trim().toUpperCase() !== input.currency.trim().toUpperCase()) {
      throw new PricingProcedureError(
        `Material ${context.materialNumber} is valued in ${valuation.currency} at plant ${context.plant}, and the document is stated in ${input.currency}.`,
        'A cost is not converted into the document currency to make a margin look better. Value the material in the document currency, or leave the cost out of the procedure.',
      );
    }
    const rate = valuation.priceControl === 'MOVING_AVERAGE'
      ? Number(valuation.movingAveragePrice)
      : Number(valuation.standardPrice);
    const priceUnit = Number(valuation.priceUnit) || 1;
    const quantity = context.quantity / priceUnit;
    return { amount: quantity * rate, base: quantity, rate, priceUnit, conditionNumber: null, access: null };
  }

  const record = await findRecord(tx, {
    client: input.client,
    conditionType: step.conditionType,
    salesOrg: input.salesOrg,
    distributionChannel: input.distributionChannel,
    division: input.division,
    customerNumber: input.customerNumber,
    materialNumber: context.materialNumber,
    documentDate: input.documentDate,
    currency: input.currency,
  });
  if (!record) {
    if (step.isRequired) {
      throw new PricingProcedureError(
        `No ${step.conditionType} condition record stands for ${context.isHeader ? 'the document' : `material ${context.materialNumber}`} and customer ${input.customerNumber} in sales area ${input.salesOrg}/${input.distributionChannel}/${input.division} on ${input.documentDate}, and step ${step.stepNumber} of procedure ${procedureCode} requires one.`,
        `Maintain the ${step.conditionType} condition record, or remove step ${step.stepNumber} from the procedure at ${PRICING_PROCEDURE_ROUTE}.`,
      );
    }
    return undefined;
  }
  const rate = Number(record.amount);
  const priceUnit = record.priceUnit;

  if (step.calculationType === 'PERCENTAGE') {
    const base = sumSpan(context.stepValues, step.fromStep, step.toStep);
    return {
      amount: (base * rate) / 100,
      base,
      rate,
      priceUnit: 1,
      conditionNumber: record.conditionNumber,
      access: record.access,
    };
  }

  // A fixed step: a figure per price unit. At the item it is applied to the quantity; at the header it
  // is the figure itself, because a charge on the document is not multiplied by anything.
  const quantity = context.quantity / priceUnit;
  return {
    amount: context.isHeader ? rate : quantity * rate,
    base: context.isHeader ? 0 : quantity,
    rate,
    priceUnit,
    conditionNumber: record.conditionNumber,
    access: record.access,
  };
}

/** What each account key carries over the whole document. */
function accumulate(totals: Map<string, number>, step: StepRow, amount: number): void {
  if (step.isStatistical || !step.accountKey) return;
  totals.set(step.accountKey, (totals.get(step.accountKey) ?? 0) + amount);
}

/**
 * The value a percentage step is calculated on: the steps it names, in the order they stand.
 *
 * A step that names no span is calculated on nothing, which is a configuration error refused when the
 * procedure is maintained rather than discovered here at the worst possible moment.
 */
function sumSpan(
  stepValues: Map<number, number>,
  fromStep: number | null,
  toStep: number | null,
): number {
  if (fromStep === null || toStep === null) {
    throw new PricingProcedureError(
      'A percentage step names no span of steps to be calculated on, so it has no base.',
      `Name the span the step is calculated on at ${PRICING_PROCEDURE_ROUTE}.`,
    );
  }
  let sum = 0;
  for (const [stepNumber, value] of stepValues) {
    if (stepNumber >= fromStep && stepNumber <= toStep) sum += value;
  }
  return sum;
}

/**
 * Write the conditions a document was priced by.
 *
 * Every step of the procedure is written, not only the steps that contributed: a document's conditions
 * are the procedure as it was executed, and a step that contributed nothing is a fact about the pricing
 * — the customer had no discount, the freight did not apply — not an absence of a row. That is also
 * what lets a re-priced document be rewritten in place instead of deleted and re-inserted: the
 * application role holds no DELETE on history.
 */
export async function writeDocumentConditions(
  tx: Tx,
  input: {
    client: string;
    documentCategory: 'ORDER' | 'BILLING';
    documentNumber: string;
    priced: PricedDocument;
    changedBy: string;
  },
): Promise<number> {
  let written = 0;
  const write = async (
    row: {
      lineNumber: number; stepNumber: number; conditionType: string; baseValue: string; rate: string;
      amount: string; priceUnit: number; conditionNumber: string | null; accountKey: string | null;
      isStatistical: boolean; origin: 'ITEM' | 'HEADER' | 'DISTRIBUTED';
    },
  ): Promise<void> => {
    const values = {
      client: input.client,
      documentCategory: input.documentCategory,
      documentNumber: input.documentNumber,
      lineNumber: row.lineNumber,
      stepNumber: row.stepNumber,
      conditionType: row.conditionType,
      baseValue: row.baseValue,
      rate: row.rate,
      amount: row.amount,
      priceUnit: row.priceUnit,
      currency: input.priced.currency,
      conditionNumber: row.conditionNumber,
      accountKey: row.accountKey,
      isStatistical: row.isStatistical,
      origin: row.origin,
      changedBy: input.changedBy,
      changedAt: new Date(),
    };
    await tx.insert(salesDocumentCondition).values({ ...values, createdBy: input.changedBy })
      .onConflictDoUpdate({
        target: [
          salesDocumentCondition.client, salesDocumentCondition.documentCategory,
          salesDocumentCondition.documentNumber, salesDocumentCondition.lineNumber,
          salesDocumentCondition.stepNumber,
        ],
        set: values,
      });
    written += 1;
  };

  // The header's conditions first, whole, at line 0: what the printout shows and what the distributed
  // rows below add up to.
  for (const header of input.priced.headerConditions) {
    await write({
      lineNumber: 0,
      stepNumber: header.stepNumber,
      conditionType: header.conditionType,
      baseValue: header.baseValue,
      rate: header.rate,
      amount: header.amount,
      priceUnit: header.priceUnit,
      conditionNumber: header.conditionNumber,
      accountKey: header.accountKey,
      isStatistical: header.isStatistical,
      origin: 'HEADER',
    });
  }

  for (const item of input.priced.items) {
    for (const step of input.priced.steps) {
      const contributed = item.conditions.find((condition) => condition.stepNumber === step.stepNumber);
      await write({
        lineNumber: item.lineNumber,
        stepNumber: step.stepNumber,
        conditionType: step.conditionType,
        baseValue: contributed?.baseValue ?? '0.0000',
        rate: contributed?.rate ?? '0.000000',
        amount: contributed?.amount ?? '0.0000',
        priceUnit: contributed?.priceUnit ?? 1,
        conditionNumber: contributed?.conditionNumber ?? null,
        accountKey: contributed?.accountKey ?? step.accountKey,
        isStatistical: contributed?.isStatistical ?? step.isStatistical,
        origin: contributed?.origin ?? 'ITEM',
      });
    }
  }
  return written;
}

/**
 * The conditions a document was priced by, read back.
 *
 * This is what the printout shows under the figures and what a credit memo copies: a document's
 * conditions are the arithmetic that produced it, and they are read rather than recomputed, because
 * recomputing them would price an old document with today's records.
 */
export async function salesDocumentConditionsOf(
  client: string,
  documentCategory: 'ORDER' | 'BILLING',
  documentNumber: string,
): Promise<Array<{
  lineNumber: number; stepNumber: number; conditionType: string; baseValue: string; rate: string;
  amount: string; priceUnit: number; currency: string; conditionNumber: string | null;
  accountKey: string | null; isStatistical: boolean; origin: 'ITEM' | 'HEADER' | 'DISTRIBUTED';
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      lineNumber: salesDocumentCondition.lineNumber,
      stepNumber: salesDocumentCondition.stepNumber,
      conditionType: salesDocumentCondition.conditionType,
      baseValue: salesDocumentCondition.baseValue,
      rate: salesDocumentCondition.rate,
      amount: salesDocumentCondition.amount,
      priceUnit: salesDocumentCondition.priceUnit,
      currency: salesDocumentCondition.currency,
      conditionNumber: salesDocumentCondition.conditionNumber,
      accountKey: salesDocumentCondition.accountKey,
      isStatistical: salesDocumentCondition.isStatistical,
      origin: salesDocumentCondition.origin,
    }).from(salesDocumentCondition).where(and(
      eq(salesDocumentCondition.client, client),
      eq(salesDocumentCondition.documentCategory, documentCategory),
      eq(salesDocumentCondition.documentNumber, documentNumber),
    )).orderBy(asc(salesDocumentCondition.lineNumber), asc(salesDocumentCondition.stepNumber));
    return rows.map((row) => ({
      ...row,
      origin: (row.origin === 'HEADER' || row.origin === 'DISTRIBUTED') ? row.origin : 'ITEM',
    }));
  });
}

/** The determination rows a tenant stands, most-specific first — what the maintenance screen lists. */
export async function pricingProcedureDeterminationRows(
  client: string,
): Promise<Array<{
  salesOrg: string; distributionChannel: string; division: string;
  documentPricingProcedure: string; customerPricingProcedure: string; procedureCode: string;
}>> {
  return withTenant(client, async (tx) => tx.select({
    salesOrg: salesProcedureDetermination.salesOrg,
    distributionChannel: salesProcedureDetermination.distributionChannel,
    division: salesProcedureDetermination.division,
    documentPricingProcedure: salesProcedureDetermination.documentPricingProcedure,
    customerPricingProcedure: salesProcedureDetermination.customerPricingProcedure,
    procedureCode: salesProcedureDetermination.procedureCode,
  }).from(salesProcedureDetermination).where(eq(salesProcedureDetermination.client, client))
    .orderBy(asc(salesProcedureDetermination.salesOrg), asc(salesProcedureDetermination.documentPricingProcedure),
      asc(salesProcedureDetermination.customerPricingProcedure)));
}

/**
 * The conditions of a document, mirrored onto another — what a credit memo is.
 *
 * A credit is not newly priced: it is the mirror of the document it gives back, scaled to the quantity
 * being credited. Reading the stored conditions and scaling them is the only way a credit can be proved
 * to be the same price the customer was charged, whatever the condition records say today.
 */
export function mirrorConditions(
  conditions: Array<{
    stepNumber: number; conditionType: string; conditionClass: string; origin?: 'ITEM' | 'HEADER' | 'DISTRIBUTED';
    baseValue: string; rate: string; amount: string;
    priceUnit: number; currency: string; conditionNumber: string | null; accountKey: string | null;
    isStatistical: boolean;
  }>,
  factor: number,
): PricedCondition[] {
  return conditions.map((condition) => ({
    lineNumber: 0,
    stepNumber: condition.stepNumber,
    conditionType: condition.conditionType,
    conditionClass: condition.conditionClass,
    origin: condition.origin ?? 'ITEM',
    baseValue: round4(Number(condition.baseValue) * factor),
    rate: condition.rate,
    amount: round2(Number(condition.amount) * factor),
    priceUnit: condition.priceUnit,
    conditionNumber: condition.conditionNumber,
    accountKey: condition.accountKey,
    isStatistical: condition.isStatistical,
    access: null,
  }));
}

import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { glAccount } from '../finance/schema';
import { valuationClass } from '../inventory/schema';
import { accountDetermination, chartOfAccounts } from './schema';

/**
 * OBYC Define Account Determination — the read side (SCR-040 stage 1).
 *
 * The reference transaction's spine is a table of (chart, transaction key,
 * modifiers) → G/L account. This product stores the same spine in its own
 * vocabulary (R-89): the transaction keys are the product's posting events,
 * with BSX, WRX, GBB and PRD carried as search aliases and never stored;
 * the valuation-grouping dimension is omitted, because this product keyes
 * valuation by plant and holds no grouping of valuation areas to resolve
 * through; the valuation class is the material master's own, so a
 * determination line names the class a material actually carries.
 *
 * The event catalogue below is configuration vocabulary, not decoration:
 * each event states the account kind it expects (balance sheet or profit
 * and loss) and which modifier columns belong to it, and the write
 * (stage 3) judges a row against exactly those statements — including
 * refusing a valuation class or general modifier an event does not use,
 * the dynamic columns of the reference layout enforced in the service
 * rather than merely hidden on screen.
 */
export const ACTIVITY = 'CFG.FIN.ACCTDET.DEFINE';

export type AccountKind = 'BALANCE_SHEET' | 'PL_STATEMENT';

export interface PostingEvent {
  event: string;
  /** The reference transaction key, for search and display only — never stored. */
  referenceAlias: string;
  expectedAccountKind: AccountKind;
  usesValuationClass: boolean;
  usesGeneralModifier: boolean;
}

export const POSTING_EVENTS: PostingEvent[] = [
  { event: 'INVENTORY', referenceAlias: 'BSX', expectedAccountKind: 'BALANCE_SHEET', usesValuationClass: true, usesGeneralModifier: false },
  { event: 'GR_IR_CLEARING', referenceAlias: 'WRX', expectedAccountKind: 'BALANCE_SHEET', usesValuationClass: false, usesGeneralModifier: false },
  { event: 'OFFSETTING_INVENTORY', referenceAlias: 'GBB', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: true },
  // The goods-issue offsets, maintainable since SCR-136; production consumption since SCR-139.
  { event: 'CONSUMPTION', referenceAlias: 'GBB', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: false },
  { event: 'SCRAP', referenceAlias: 'GBB', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: false },
  { event: 'PRODUCTION_CONSUMPTION', referenceAlias: 'GBB', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: false },
  // The credit side of a production order receipt (WRX-style): what the order produced is worth
  // to the plant, offset against inventory. Added with SCR-140.
  { event: 'PRODUCTION_OUTPUT', referenceAlias: 'GBB', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: false },
  { event: 'PRICE_DIFFERENCE', referenceAlias: 'PRD', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: false },
  { event: 'TAX', referenceAlias: 'MWS', expectedAccountKind: 'BALANCE_SHEET', usesValuationClass: false, usesGeneralModifier: false },
  { event: 'FXGAIN', referenceAlias: 'FXGAIN', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: false, usesGeneralModifier: false },
  { event: 'RETAINED_EARNINGS', referenceAlias: 'RETAINED_EARNINGS', expectedAccountKind: 'BALANCE_SHEET', usesValuationClass: false, usesGeneralModifier: true },
  { event: 'FXLOSS', referenceAlias: 'FXLOSS', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: false, usesGeneralModifier: false },
  { event: 'CASH_DISCOUNT', referenceAlias: 'SKTO', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: false, usesGeneralModifier: true },
  { event: 'PAYMENT_DIFFERENCE', referenceAlias: 'DIF', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: false, usesGeneralModifier: true },
];

export function postingEvent(event: string): PostingEvent | undefined {
  return POSTING_EVENTS.find((entry) => entry.event === event);
}

export interface AccountDeterminationRow {
  chartOfAccounts: string;
  event: string;
  /** '' = any valuation class. */
  valuationClass: string;
  /** '' = no general-modifier split. */
  generalModifier: string;
  glAccount: string;
}

export interface ChartChoice {
  chartOfAccounts: string;
  name: string;
}

export interface ValuationClassChoice {
  valuationClass: string;
  name: string;
}

/** Every determination row the tenant holds, in key order. */
export async function listAccountDeterminations(client: string): Promise<AccountDeterminationRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(accountDetermination)
      .where(eq(accountDetermination.client, client))
      .orderBy(
        asc(accountDetermination.chartOfAccounts),
        asc(accountDetermination.event),
        asc(accountDetermination.valuationClass),
        asc(accountDetermination.generalModifier),
      );

    return rows.map((row) => ({
      chartOfAccounts: row.chartOfAccounts,
      event: row.event,
      valuationClass: row.valuationClass,
      generalModifier: row.generalModifier,
      glAccount: row.glAccount,
    }));
  });
}

/** The charts of accounts the tenant holds — the screen's heading choice and the write's judging list. */
export async function listDeterminationCharts(client: string): Promise<ChartChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ chartOfAccounts: chartOfAccounts.chartOfAccounts, name: chartOfAccounts.name })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.client, client))
      .orderBy(asc(chartOfAccounts.chartOfAccounts));
    return rows;
  });
}

/** The tenant's active valuation classes — the class value help, in the material master's own keys. */
export async function listDeterminationValuationClasses(client: string): Promise<ValuationClassChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ valuationClass: valuationClass.valuationClass, name: valuationClass.name })
      .from(valuationClass)
      .where(and(eq(valuationClass.client, client), eq(valuationClass.isActive, true)))
      .orderBy(asc(valuationClass.valuationClass));
    return rows;
  });
}

export interface GlAccountChoice {
  chartOfAccounts: string;
  accountNumber: string;
  name: string;
  glAccountType: string;
}

/** Every G/L account of the tenant's charts — the account value help and the write's judging set. */
export async function listGlAccountChoices(client: string): Promise<GlAccountChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        chartOfAccounts: glAccount.chartOfAccounts,
        accountNumber: glAccount.accountNumber,
        name: glAccount.name,
        glAccountType: glAccount.glAccountType,
      })
      .from(glAccount)
      .where(eq(glAccount.client, client))
      .orderBy(asc(glAccount.chartOfAccounts), asc(glAccount.accountNumber));
    return rows;
  });
}

/**
 * OBYC — maintain the account determinations (SCR-040 stage 3).
 *
 * Two writes, in the shape every define-screen here converged on:
 * create-or-change, and delete. The G/L account is the one changeable
 * field — redirecting an automatic posting onto another account is the
 * daily work of this table — and the five-part key is immutable:
 * redirecting by *condition* means defining the row for that condition.
 *
 * The service judges what the database cannot (R-89): the chart stands
 * among the tenant's charts; the event stands in the catalogue, and the
 * modifiers obey the catalogue — an event that uses no valuation class
 * refuses one named, as one that uses no general modifier refuses one;
 * a named class stands active in the tenant; and the account is judged
 * per failure, the way FI12 judges its G/L rule — not in the chart is
 * one refusal, the wrong kind for the event (balance sheet against
 * profit and loss) is another, because the remedy differs. Deletion is
 * hard, with the screen stating what it costs: the posting that would
 * have derived the account will fail for want of the row.
 *
 * A **reason is mandatory on every write**, one change document per
 * write with the G/L account security-relevant: it is the whole value
 * of the row, and money will move by it when posting reads the table.
 */
export const OBJECT_CLASS = 'account_determination';
const PREREQUISITES = ['CFG.FIN.COA.DEFINE'] as const;

export const determinationValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  chartOfAccounts: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{4}$/, 'The Chart of Accounts is exactly four letters or digits.')),
  event: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z][A-Z0-9_]{2,23}$/, 'The Posting Event is an upper-case event key.')),
  valuationClass: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^([A-Z0-9_]{1,20})?$/, 'The Valuation Class is up to twenty letters, digits or underscores, or blank for any class.')),
  generalModifier: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^([A-Z0-9]{1,4})?$/, 'The General Modifier is up to four letters or digits, or blank.')),
  glAccount: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'The G/L Account is up to ten letters or digits.')),
  reason: z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.'),
});

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
};

export const determinationInputSchema = determinationValuesSchema.extend(actorFields).strict();
export type DeterminationInput = z.input<typeof determinationInputSchema>;

export const determinationDeleteInputSchema = z.object({
  ...actorFields,
  chartOfAccounts: determinationValuesSchema.shape.chartOfAccounts,
  event: determinationValuesSchema.shape.event,
  valuationClass: determinationValuesSchema.shape.valuationClass,
  generalModifier: determinationValuesSchema.shape.generalModifier,
  reason: determinationValuesSchema.shape.reason,
}).strict();
export type DeterminationDeleteInput = z.input<typeof determinationDeleteInputSchema>;

export class AccountDeterminationError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the determination and try again.',
  ) {
    super(message);
    this.name = 'AccountDeterminationError';
  }
}

export interface DeterminationSaveResult {
  changed: boolean;
  chartOfAccounts: string;
  event: string;
  glAccount: string;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function assertPrerequisites(tx: Tx, client: string): Promise<void> {
  const rows = await tx
    .select({ activityCode: configActivityStatus.activityCode })
    .from(configActivityStatus)
    .where(and(
      eq(configActivityStatus.client, client),
      inArray(configActivityStatus.activityCode, [...PREREQUISITES]),
      eq(configActivityStatus.status, 'COMPLETED'),
    ));
  const completed = new Set(rows.map((row) => row.activityCode));
  const missing = PREREQUISITES.filter((code) => !completed.has(code));
  if (missing.length > 0) {
    throw new AccountDeterminationError(
      `Account determination prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define the chart of accounts in the configuration workbench first: a determination assigns accounts of a chart, and there is nothing to assign until it exists.',
    );
  }
}

const FIELD_LABELS = {
  glAccount: 'G/L account',
  chartOfAccounts: 'Chart of accounts',
  event: 'Posting event',
  valuationClass: 'Valuation class',
  generalModifier: 'General modifier',
} as const;

/** The key the change documents file under: blanks under working names. */
function objectKeyFor(values: { chartOfAccounts: string; event: string; valuationClass: string; generalModifier: string }): string {
  return `${values.chartOfAccounts}/${values.event}/${values.valuationClass === '' ? 'ANY' : values.valuationClass}/${values.generalModifier === '' ? 'NONE' : values.generalModifier}`;
}

function keyWhere(client: string, values: { chartOfAccounts: string; event: string; valuationClass: string; generalModifier: string }) {
  return and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, values.chartOfAccounts),
    eq(accountDetermination.event, values.event),
    eq(accountDetermination.valuationClass, values.valuationClass),
    eq(accountDetermination.generalModifier, values.generalModifier),
  );
}

type JudgedValues = Pick<
  z.infer<typeof determinationValuesSchema>,
  'chartOfAccounts' | 'event' | 'valuationClass' | 'generalModifier' | 'glAccount'
>;

/** Everything the database cannot judge, stated per failure (R-89). */
async function judge(tx: Tx, client: string, values: JudgedValues): Promise<void> {
  const entry = postingEvent(values.event);
  if (!entry) {
    throw new AccountDeterminationError(
      `Posting Event ${values.event} is not defined.`,
      `Choose one of the posting events: ${POSTING_EVENTS.map((candidate) => candidate.event).join(', ')}.`,
    );
  }

  const [chart] = await tx
    .select({ chartOfAccounts: chartOfAccounts.chartOfAccounts })
    .from(chartOfAccounts)
    .where(and(eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, values.chartOfAccounts)))
    .limit(1);
  if (!chart) {
    throw new AccountDeterminationError(
      `Chart of Accounts ${values.chartOfAccounts} is not defined in this tenant.`,
      'Choose a chart of accounts that stands, or define it under Chart of Accounts first.',
    );
  }

  if (!entry.usesValuationClass && values.valuationClass !== '') {
    throw new AccountDeterminationError(
      `Posting Event ${entry.event} does not use a valuation class.`,
      'Leave the Valuation Class blank for this event; its account does not split by class.',
    );
  }
  if (entry.usesValuationClass && values.valuationClass !== '') {
    const [standing] = await tx
      .select({ valuationClass: valuationClass.valuationClass })
      .from(valuationClass)
      .where(and(
        eq(valuationClass.client, client),
        eq(valuationClass.valuationClass, values.valuationClass),
        eq(valuationClass.isActive, true),
      ))
      .limit(1);
    if (!standing) {
      throw new AccountDeterminationError(
        `Valuation Class ${values.valuationClass} is not defined as an active class in this tenant.`,
        'Choose a valuation class that stands active, or leave it blank so the row covers any class.',
      );
    }
  }

  if (!entry.usesGeneralModifier && values.generalModifier !== '') {
    throw new AccountDeterminationError(
      `Posting Event ${entry.event} does not use a general modifier.`,
      'Leave the General Modifier blank for this event; its account does not split further.',
    );
  }

  const [account] = await tx
    .select({ glAccountType: glAccount.glAccountType })
    .from(glAccount)
    .where(and(
      eq(glAccount.client, client),
      eq(glAccount.chartOfAccounts, values.chartOfAccounts),
      eq(glAccount.accountNumber, values.glAccount),
    ))
    .limit(1);
  if (!account) {
    throw new AccountDeterminationError(
      `G/L Account ${values.glAccount} is not defined in chart ${values.chartOfAccounts}.`,
      'Choose an account that stands in the chart, or create it under G/L Accounts first.',
    );
  }
  if (account.glAccountType !== entry.expectedAccountKind) {
    const named = account.glAccountType === 'BALANCE_SHEET' ? 'a balance-sheet' : 'a profit-and-loss';
    const expected = entry.expectedAccountKind === 'BALANCE_SHEET' ? 'a balance-sheet' : 'a profit-and-loss';
    throw new AccountDeterminationError(
      `G/L Account ${values.glAccount} is ${named} account; Posting Event ${entry.event} expects ${expected} account.`,
      'Choose an account of the kind this event posts to.',
    );
  }
}

/**
 * Create a determination, or redirect the G/L account of one that stands.
 * Idempotent on change: repeating the stored account reports
 * `changed: false` and writes nothing but the activity completion.
 */
export async function saveAccountDetermination(raw: DeterminationInput): Promise<DeterminationSaveResult> {
  const parsed = determinationInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AccountDeterminationError(
      parsed.error.issues[0]?.message ?? 'The determination is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    await judge(tx, client, values);

    const [existing] = await tx
      .select()
      .from(accountDetermination)
      .where(keyWhere(client, values))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new AccountDeterminationError(
        `A determination for Posting Event ${values.event} in chart ${values.chartOfAccounts} already stands with these modifiers.`,
        'Change the determination that exists, or define the row under another modifier combination.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new AccountDeterminationError(
        `No determination for Posting Event ${values.event} in chart ${values.chartOfAccounts} stands with these modifiers.`,
        'Create the determination first; the key cannot be changed into existence, because the key is the condition.',
      );
    }

    const result: DeterminationSaveResult = {
      changed: true,
      chartOfAccounts: values.chartOfAccounts,
      event: values.event,
      glAccount: values.glAccount,
    };
    const objectKey = objectKeyFor(values);

    if (values.mode === 'CREATE') {
      await tx.insert(accountDetermination).values({
        client,
        chartOfAccounts: values.chartOfAccounts,
        event: values.event,
        valuationClass: values.valuationClass,
        generalModifier: values.generalModifier,
        glAccount: values.glAccount,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: {
          chartOfAccounts: values.chartOfAccounts,
          event: values.event,
          valuationClass: values.valuationClass,
          generalModifier: values.generalModifier,
          glAccount: values.glAccount,
        },
        fieldLabels: FIELD_LABELS,
        securityRelevantFields: ['glAccount'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (existing.glAccount === values.glAccount) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(accountDetermination)
      .set({ glAccount: values.glAccount, changedBy, changedAt: new Date() })
      .where(keyWhere(client, values));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { glAccount: existing.glAccount },
      after: { glAccount: values.glAccount },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: ['glAccount'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/**
 * Delete a determination. The deletion files what was removed, so the
 * audit trail keeps the account a posting would have derived after the
 * registry stops holding it.
 */
export async function deleteAccountDetermination(raw: DeterminationDeleteInput): Promise<{ deleted: true }> {
  const parsed = determinationDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AccountDeterminationError(
      parsed.error.issues[0]?.message ?? 'The determination deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(accountDetermination)
      .where(keyWhere(client, values))
      .for('update');
    if (!existing) {
      throw new AccountDeterminationError(
        `No determination for Posting Event ${values.event} in chart ${values.chartOfAccounts} stands with these modifiers.`,
        'Reload the determinations; the entry may already have been deleted.',
      );
    }

    await tx.delete(accountDetermination).where(keyWhere(client, values));

    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: objectKeyFor(values),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        chartOfAccounts: existing.chartOfAccounts,
        event: existing.event,
        valuationClass: existing.valuationClass,
        generalModifier: existing.generalModifier,
        glAccount: existing.glAccount,
      },
      fieldLabels: FIELD_LABELS,
      securityRelevantFields: ['glAccount'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}

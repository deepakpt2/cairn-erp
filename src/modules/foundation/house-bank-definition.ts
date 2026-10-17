import { z } from 'zod';
import { and, asc, count, eq, inArray } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { configActivityStatus } from '../../platform/tables/registry';
import { bankMaster, currency as currencyReference } from '../../platform/tables/reference';
import { glAccount } from '../finance/schema';
import { bankAccount, companyCode, houseBank } from './schema';

/**
 * FI12 Define House Banks — the read side (SCR-037 stage 1).
 *
 * A house bank is the tenant's own bank, named inside a company code, and the
 * accounts held at it. It refers to the global bank master (SCR-036) by bank
 * country and bank key and reads the bank's name, city and SWIFT code from
 * there as facts it does not own; each account under it carries the local
 * account number, an optional IBAN, a currency, and the G/L account the
 * bank's postings clear through.
 *
 * The contract the owner settled (R-86, with SCR-036): the house-bank key and
 * the account ID are immutable (renaming is create + delete); the bank
 * reference on a house bank may be corrected, as may an account's number,
 * IBAN, currency and G/L mapping; the G/L account must exist in the chart
 * assigned to the company code and be an asset balance-sheet account; a
 * house bank deletes only once its accounts are deleted, and an account —
 * referenced by nothing yet — deletes outright; a reason is mandatory on
 * every write with one change document per write, in the established shape.
 *
 * Stage 1 published the screen against an honestly empty list; stage 2
 * created the tables (migration 0045) and the reads below are real.
 */
export const ACTIVITY = 'CFG.FIN.HOUSEBANK.DEFINE';

export interface BankAccountRow {
  accountId: string;
  accountNumber: string;
  iban: string | null;
  currency: string;
  glAccount: string;
}

export interface HouseBankRow {
  companyCode: string;
  houseBankKey: string;
  /** The bank master entry this house bank names — displayed, not owned. */
  bankCountry: string;
  bankKey: string;
  bankName: string;
  bankCity: string | null;
  bankSwift: string | null;
  accounts: BankAccountRow[];
}

export interface CompanyChoice {
  companyCode: string;
  name: string;
  chartOfAccounts: string | null;
}

export interface BankChoice {
  bankCountry: string;
  bankKey: string;
  name: string;
}

/**
 * Every house bank the tenant holds, with its accounts. The display facts —
 * name, city, SWIFT — are joined from the bank master at read time and stored
 * nowhere here, so correcting them in the master corrects every house bank
 * that names the bank.
 */
export async function listHouseBanks(client: string): Promise<HouseBankRow[]> {
  return withTenant(client, async (tx) => {
    const [houseBanks, accounts] = await Promise.all([
      tx
        .select({
          companyCode: houseBank.companyCode,
          houseBankKey: houseBank.houseBankKey,
          bankCountry: houseBank.bankCountry,
          bankKey: houseBank.bankKey,
          bankName: bankMaster.name,
          bankCity: bankMaster.city,
          bankSwift: bankMaster.swift,
        })
        .from(houseBank)
        .innerJoin(
          bankMaster,
          and(
            eq(bankMaster.bankCountry, houseBank.bankCountry),
            eq(bankMaster.bankKey, houseBank.bankKey),
          ),
        )
        .where(eq(houseBank.client, client))
        .orderBy(asc(houseBank.companyCode), asc(houseBank.houseBankKey)),
      tx
        .select()
        .from(bankAccount)
        .where(eq(bankAccount.client, client))
        .orderBy(
          asc(bankAccount.companyCode),
          asc(bankAccount.houseBankKey),
          asc(bankAccount.accountId),
        ),
    ]);

    const accountsByHouse = new Map<string, BankAccountRow[]>();
    for (const account of accounts) {
      const key = `${account.companyCode}/${account.houseBankKey}`;
      const list = accountsByHouse.get(key) ?? [];
      list.push({
        accountId: account.accountId,
        accountNumber: account.accountNumber,
        iban: account.iban,
        currency: account.currency.trim(),
        glAccount: account.glAccount,
      });
      accountsByHouse.set(key, list);
    }

    return houseBanks.map((row) => ({
      companyCode: row.companyCode,
      houseBankKey: row.houseBankKey,
      bankCountry: row.bankCountry.trim(),
      bankKey: row.bankKey,
      bankName: row.bankName,
      bankCity: row.bankCity,
      bankSwift: row.bankSwift,
      accounts: accountsByHouse.get(`${row.companyCode}/${row.houseBankKey}`) ?? [],
    }));
  });
}

/** The company codes a house bank may be defined under, with their charts. */
export async function listHouseBankCompanies(client: string): Promise<CompanyChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        companyCode: companyCode.companyCode,
        name: companyCode.name,
        chartOfAccounts: companyCode.chartOfAccounts,
      })
      .from(companyCode)
      .orderBy(asc(companyCode.companyCode));
    return rows;
  });
}

/** The banks a house bank may name — the global bank master, read as-is. */
export async function listBankChoices(client: string): Promise<BankChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        bankCountry: bankMaster.bankCountry,
        bankKey: bankMaster.bankKey,
        name: bankMaster.name,
      })
      .from(bankMaster)
      .orderBy(asc(bankMaster.bankCountry), asc(bankMaster.bankKey));
    return rows.map((row) => ({ ...row, bankCountry: row.bankCountry.trim() }));
  });
}

export const HOUSE_BANK_OBJECT_CLASS = 'house_bank';
export const BANK_ACCOUNT_OBJECT_CLASS = 'bank_account';
const PREREQUISITES = ['CFG.ORG.COMPANYCODE.DEFINE'] as const;

export interface CurrencyChoice {
  code: string;
  name: string;
}

export interface GlAccountChoice {
  chartOfAccounts: string;
  accountNumber: string;
  name: string;
  accountType: string;
  isBalanceSheet: boolean;
}

/** The currencies a bank account may be held in: the active rows of the currency master. */
export async function listHouseBankCurrencies(client: string): Promise<CurrencyChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ code: currencyReference.code, name: currencyReference.name })
      .from(currencyReference)
      .where(eq(currencyReference.isActive, true))
      .orderBy(asc(currencyReference.code));
    return rows.map((row) => ({ code: row.code.trim(), name: row.name }));
  });
}

/**
 * The G/L accounts a bank account may clear through, with the properties the
 * asset balance-sheet rule reads — offered as value help so the screen can
 * present the valid accounts of a company code's chart rather than asking
 * the operator to guess one and be refused.
 */
export async function listGlAccountChoices(client: string): Promise<GlAccountChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        chartOfAccounts: glAccount.chartOfAccounts,
        accountNumber: glAccount.accountNumber,
        name: glAccount.name,
        accountType: glAccount.accountType,
        isBalanceSheet: glAccount.isBalanceSheet,
      })
      .from(glAccount)
      .where(eq(glAccount.client, client))
      .orderBy(asc(glAccount.chartOfAccounts), asc(glAccount.accountNumber));
    return rows;
  });
}

/**
 * FI12 — define house banks and their accounts (SCR-037 stage 3).
 *
 * Two writes at two levels, in the OBBO/OB08 shape, each completing the
 * activity on its first success — a tenant that has defined an account has
 * defined house banking. The rules the owner settled shape them (R-86).
 *
 * **Keys are immutable at both levels.** The screen says which of create or
 * change it is doing; renaming a house bank or an account is defining the
 * new one and, where the old should not stand, deleting it.
 *
 * A house bank **names a bank of the global master** (SCR-036): the entry
 * must exist, and the display facts are read from it at read time, never
 * stored here. The reference may be corrected on change.
 *
 * A bank account's **G/L account must be an asset balance-sheet account of
 * the chart assigned to its company code** — the rule is judged here rather
 * than in a check constraint because it reads two other tables, and each
 * failure is named on its own: no chart assigned, no such account, not an
 * asset, not balance-sheet. A mid-chart foreign account is precisely the
 * silent misposting this activity exists to prevent.
 *
 * A house bank **deletes only once its accounts are gone**; an account,
 * referenced by nothing yet, deletes outright. A **reason is mandatory on
 * every write**, one change document per write on the composite key, with
 * the bank reference and the G/L mapping flagged security-relevant: they
 * decide where a tenant's money is said to be.
 */
const upperKey = (max: number, message: string) =>
  z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(new RegExp(`^[A-Z0-9]{1,${max}}$`), message));

const reasonSchema = z
  .string()
  .trim()
  .min(1, 'A reason is required.')
  .max(500, 'The reason is at most 500 characters.');

const actorFields = {
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  changedBy: z.string().trim().min(1).max(60),
  reason: reasonSchema,
};

export const houseBankValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  companyCode: z.string().trim().min(1, 'A Company Code is required.').max(10),
  houseBankKey: upperKey(5, 'The House Bank key is up to five letters or digits.'),
  bankCountry: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'The Bank Country is the two-letter key from the country master.')),
  bankKey: upperKey(15, 'The Bank Key is up to fifteen letters or digits.'),
});

export const houseBankInputSchema = houseBankValuesSchema.extend(actorFields).strict();
export type HouseBankInput = z.input<typeof houseBankInputSchema>;

export const houseBankDeleteInputSchema = z.object({
  ...actorFields,
  companyCode: houseBankValuesSchema.shape.companyCode,
  houseBankKey: houseBankValuesSchema.shape.houseBankKey,
}).strict();
export type HouseBankDeleteInput = z.input<typeof houseBankDeleteInputSchema>;

export const bankAccountValuesSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  companyCode: houseBankValuesSchema.shape.companyCode,
  houseBankKey: houseBankValuesSchema.shape.houseBankKey,
  accountId: upperKey(5, 'The Account ID is up to five letters or digits.'),
  accountNumber: z
    .string()
    .trim()
    .min(1, 'An Account Number is required.')
    .max(18, 'The Account Number is at most eighteen characters.'),
  /** An empty IBAN clears it: the field is optional in the package and here. */
  iban: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value.toUpperCase().replace(/\s+/g, '')))
    .pipe(
      z
        .string()
        .regex(
          /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/,
          'The IBAN is two letters of country, two check digits, and the account body — fifteen to thirty-four characters in all.',
        )
        .nullable(),
    ),
  currency: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3,5}$/, 'A currency is three to five letters.')),
  glAccount: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, 'The G/L Account is up to ten letters or digits.')),
});

export const bankAccountInputSchema = bankAccountValuesSchema.extend(actorFields).strict();
export type BankAccountInput = z.input<typeof bankAccountInputSchema>;

export const bankAccountDeleteInputSchema = z.object({
  ...actorFields,
  companyCode: houseBankValuesSchema.shape.companyCode,
  houseBankKey: houseBankValuesSchema.shape.houseBankKey,
  accountId: bankAccountValuesSchema.shape.accountId,
}).strict();
export type BankAccountDeleteInput = z.input<typeof bankAccountDeleteInputSchema>;

export class HouseBankError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Review the house bank and try again.',
  ) {
    super(message);
    this.name = 'HouseBankError';
  }
}

export interface HouseBankSaveResult {
  changed: boolean;
  companyCode: string;
  houseBankKey: string;
  /** Bank accounts standing under the house bank at the moment of the write. */
  accounts: number;
}

export interface BankAccountSaveResult {
  changed: boolean;
  companyCode: string;
  houseBankKey: string;
  accountId: string;
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
    throw new HouseBankError(
      `House bank prerequisites are incomplete: ${missing.join(', ')}.`,
      'Define a Company Code in the configuration workbench first: a house bank is a company code\'s bank, and there is no company code until then.',
    );
  }
}

/** The company code the write names, or the refusal that it does not stand. */
async function requireCompany(tx: Tx, client: string, companyCodeKey: string) {
  const [company] = await tx
    .select()
    .from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, companyCodeKey)))
    .limit(1);
  if (!company) {
    throw new HouseBankError(
      `Company Code ${companyCodeKey} is not defined in this tenant.`,
      'Choose a company code the tenant holds; a house bank belongs to a company code.',
    );
  }
  return company;
}

async function countAccounts(tx: Tx, client: string, companyCodeKey: string, houseBankKey: string): Promise<number> {
  const [row] = await tx
    .select({ accounts: count() })
    .from(bankAccount)
    .where(and(
      eq(bankAccount.client, client),
      eq(bankAccount.companyCode, companyCodeKey),
      eq(bankAccount.houseBankKey, houseBankKey),
    ));
  return row?.accounts ?? 0;
}

function houseBankKeyOf(companyCodeKey: string, houseBankKey: string): string {
  return `${companyCodeKey}/${houseBankKey}`;
}

/**
 * Create a house bank under a company code, or change the bank it names.
 * Idempotent on change: repeating the stored reference reports
 * `changed: false` and writes nothing but the activity completion.
 */
export async function saveHouseBank(raw: HouseBankInput): Promise<HouseBankSaveResult> {
  const parsed = houseBankInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HouseBankError(
      parsed.error.issues[0]?.message ?? 'The house bank is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    await requireCompany(tx, client, values.companyCode);

    const [bank] = await tx
      .select({ name: bankMaster.name })
      .from(bankMaster)
      .where(and(eq(bankMaster.bankCountry, values.bankCountry), eq(bankMaster.bankKey, values.bankKey)))
      .limit(1);
    if (!bank) {
      throw new HouseBankError(
        `Bank ${values.bankKey} for ${values.bankCountry} is not defined in the bank master.`,
        'Define the bank in the bank master first, or choose a bank it holds; a house bank names a bank that exists.',
      );
    }

    const [existing] = await tx
      .select()
      .from(houseBank)
      .where(and(
        eq(houseBank.client, client),
        eq(houseBank.companyCode, values.companyCode),
        eq(houseBank.houseBankKey, values.houseBankKey),
      ))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new HouseBankError(
        `House Bank ${values.houseBankKey} is already defined for Company Code ${values.companyCode}.`,
        'Change the house bank that exists, or choose another house bank key.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new HouseBankError(
        `House Bank ${values.houseBankKey} is not defined for Company Code ${values.companyCode}.`,
        'Create the house bank first; a key cannot be changed into existence, because the key is the house bank.',
      );
    }

    const accounts = values.mode === 'CHANGE'
      ? await countAccounts(tx, client, values.companyCode, values.houseBankKey)
      : 0;
    const result: HouseBankSaveResult = {
      changed: true,
      companyCode: values.companyCode,
      houseBankKey: values.houseBankKey,
      accounts,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(houseBank).values({
        client,
        companyCode: values.companyCode,
        houseBankKey: values.houseBankKey,
        bankCountry: values.bankCountry,
        bankKey: values.bankKey,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: HOUSE_BANK_OBJECT_CLASS,
        objectKey: houseBankKeyOf(values.companyCode, values.houseBankKey),
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: {
          companyCode: values.companyCode,
          houseBankKey: values.houseBankKey,
          bankCountry: values.bankCountry,
          bankKey: values.bankKey,
        },
        fieldLabels: {
          companyCode: 'Company code',
          houseBankKey: 'House bank',
          bankCountry: 'Bank country',
          bankKey: 'Bank key',
        },
        securityRelevantFields: ['bankCountry', 'bankKey'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (
      existing.bankCountry.trim() === values.bankCountry
      && existing.bankKey === values.bankKey
    ) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(houseBank)
      .set({
        bankCountry: values.bankCountry,
        bankKey: values.bankKey,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(houseBank.client, client),
        eq(houseBank.companyCode, values.companyCode),
        eq(houseBank.houseBankKey, values.houseBankKey),
      ));

    await recordChange(tx, {
      client,
      objectClass: HOUSE_BANK_OBJECT_CLASS,
      objectKey: houseBankKeyOf(values.companyCode, values.houseBankKey),
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { bankCountry: existing.bankCountry.trim(), bankKey: existing.bankKey },
      after: { bankCountry: values.bankCountry, bankKey: values.bankKey, accounts },
      fieldLabels: {
        bankCountry: 'Bank country',
        bankKey: 'Bank key',
        accounts: 'Bank accounts standing under the house bank at the change',
      },
      securityRelevantFields: ['bankCountry', 'bankKey'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/** Delete a house bank, once its accounts are gone. */
export async function deleteHouseBank(raw: HouseBankDeleteInput): Promise<{ deleted: true }> {
  const parsed = houseBankDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HouseBankError(
      parsed.error.issues[0]?.message ?? 'The house bank deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(houseBank)
      .where(and(
        eq(houseBank.client, client),
        eq(houseBank.companyCode, values.companyCode),
        eq(houseBank.houseBankKey, values.houseBankKey),
      ))
      .for('update');
    if (!existing) {
      throw new HouseBankError(
        `House Bank ${values.houseBankKey} is not defined for Company Code ${values.companyCode}.`,
        'Reload the house banks; the entry may already have been deleted.',
      );
    }

    const accounts = await countAccounts(tx, client, values.companyCode, values.houseBankKey);
    if (accounts > 0) {
      throw new HouseBankError(
        `House Bank ${values.houseBankKey} for Company Code ${values.companyCode} has ${accounts} bank account(s) and cannot be deleted.`,
        'Delete the bank accounts under it first; a house bank removed from above its accounts would leave them naming a bank the tenant no longer holds.',
      );
    }

    await tx
      .delete(houseBank)
      .where(and(
        eq(houseBank.client, client),
        eq(houseBank.companyCode, values.companyCode),
        eq(houseBank.houseBankKey, values.houseBankKey),
      ));

    await recordChange(tx, {
      client,
      objectClass: HOUSE_BANK_OBJECT_CLASS,
      objectKey: houseBankKeyOf(values.companyCode, values.houseBankKey),
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        companyCode: existing.companyCode,
        houseBankKey: existing.houseBankKey,
        bankCountry: existing.bankCountry.trim(),
        bankKey: existing.bankKey,
      },
      fieldLabels: {
        companyCode: 'Company code',
        houseBankKey: 'House bank',
        bankCountry: 'Bank country',
        bankKey: 'Bank key',
      },
      securityRelevantFields: ['bankCountry', 'bankKey'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}

/** The currency must stand, active, in the currency master. */
async function assertCurrencyActive(tx: Tx, currency: string): Promise<void> {
  const [row] = await tx
    .select({ code: currencyReference.code, isActive: currencyReference.isActive })
    .from(currencyReference)
    .where(eq(currencyReference.code, currency))
    .limit(1);
  if (!row || row.code.trim() !== currency) {
    throw new HouseBankError(
      `Currency ${currency} is not defined in the currency master.`,
      'Choose a currency the master holds; an account in a currency that does not exist cannot be valued.',
    );
  }
  if (!row.isActive) {
    throw new HouseBankError(
      `Currency ${currency} is not active in the currency master.`,
      'Choose an active currency; an account in a retired currency would be offered long after the currency stopped being one.',
    );
  }
}

/**
 * The G/L rule, each failure named on its own (R-86): the company code has a
 * chart assigned; the account stands in that chart; it is an asset; it is a
 * balance-sheet account.
 */
async function assertGlAccount(tx: Tx, client: string, company: typeof companyCode.$inferSelect, glAccountNumber: string): Promise<void> {
  const chart = company.chartOfAccounts;
  if (!chart) {
    throw new HouseBankError(
      `Company Code ${company.companyCode} has no chart of accounts assigned.`,
      'Assign a chart of accounts to the company code first; without one there is no account a bank account could clear through.',
    );
  }

  const [account] = await tx
    .select()
    .from(glAccount)
    .where(and(
      eq(glAccount.client, client),
      eq(glAccount.chartOfAccounts, chart),
      eq(glAccount.accountNumber, glAccountNumber),
    ))
    .limit(1);
  if (!account) {
    throw new HouseBankError(
      `G/L Account ${glAccountNumber} is not defined in chart ${chart}, the chart of Company Code ${company.companyCode}.`,
      'Choose an account of that chart; a bank account clearing through another chart would post where the company code does not keep its books.',
    );
  }
  if (account.accountType !== 'ASSET') {
    throw new HouseBankError(
      `G/L Account ${glAccountNumber} is a ${account.accountType.toLowerCase()} account, not an asset account.`,
      'Bank balances are assets; choose an asset account of the chart.',
    );
  }
  if (!account.isBalanceSheet) {
    throw new HouseBankError(
      `G/L Account ${glAccountNumber} is not a balance-sheet account.`,
      'A bank balance carries forward; choose a balance-sheet account of the chart.',
    );
  }
}

/**
 * Create a bank account under a house bank, or change its number, IBAN,
 * currency and G/L mapping. Idempotent on change.
 */
export async function saveBankAccount(raw: BankAccountInput): Promise<BankAccountSaveResult> {
  const parsed = bankAccountInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HouseBankError(
      parsed.error.issues[0]?.message ?? 'The bank account is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);
    const company = await requireCompany(tx, client, values.companyCode);

    const [house] = await tx
      .select()
      .from(houseBank)
      .where(and(
        eq(houseBank.client, client),
        eq(houseBank.companyCode, values.companyCode),
        eq(houseBank.houseBankKey, values.houseBankKey),
      ))
      .limit(1);
    if (!house) {
      throw new HouseBankError(
        `House Bank ${values.houseBankKey} is not defined for Company Code ${values.companyCode}.`,
        'Create the house bank first; an account hangs under a house bank, not in the air.',
      );
    }

    await assertCurrencyActive(tx, values.currency);
    await assertGlAccount(tx, client, company, values.glAccount);

    const [existing] = await tx
      .select()
      .from(bankAccount)
      .where(and(
        eq(bankAccount.client, client),
        eq(bankAccount.companyCode, values.companyCode),
        eq(bankAccount.houseBankKey, values.houseBankKey),
        eq(bankAccount.accountId, values.accountId),
      ))
      .for('update');

    if (values.mode === 'CREATE' && existing) {
      throw new HouseBankError(
        `Bank Account ${values.accountId} is already defined under House Bank ${values.houseBankKey}.`,
        'Change the bank account that exists, or choose another account ID.',
      );
    }
    if (values.mode === 'CHANGE' && !existing) {
      throw new HouseBankError(
        `Bank Account ${values.accountId} is not defined under House Bank ${values.houseBankKey}.`,
        'Create the bank account first; a key cannot be changed into existence, because the key is the account.',
      );
    }

    const objectKey = `${houseBankKeyOf(values.companyCode, values.houseBankKey)}/${values.accountId}`;
    const result: BankAccountSaveResult = {
      changed: true,
      companyCode: values.companyCode,
      houseBankKey: values.houseBankKey,
      accountId: values.accountId,
    };

    if (values.mode === 'CREATE') {
      await tx.insert(bankAccount).values({
        client,
        companyCode: values.companyCode,
        houseBankKey: values.houseBankKey,
        accountId: values.accountId,
        accountNumber: values.accountNumber,
        iban: values.iban,
        currency: values.currency,
        glAccount: values.glAccount,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: BANK_ACCOUNT_OBJECT_CLASS,
        objectKey,
        changeType: 'CREATE',
        changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: {
          accountNumber: values.accountNumber,
          iban: values.iban,
          currency: values.currency,
          glAccount: values.glAccount,
        },
        fieldLabels: {
          accountNumber: 'Account number',
          iban: 'IBAN',
          currency: 'Currency',
          glAccount: 'G/L account',
        },
        securityRelevantFields: ['glAccount'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return result;
    }

    if (
      existing.accountNumber === values.accountNumber
      && existing.iban === values.iban
      && existing.currency.trim() === values.currency
      && existing.glAccount === values.glAccount
    ) {
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { ...result, changed: false };
    }

    await tx
      .update(bankAccount)
      .set({
        accountNumber: values.accountNumber,
        iban: values.iban,
        currency: values.currency,
        glAccount: values.glAccount,
        changedBy,
        changedAt: new Date(),
      })
      .where(and(
        eq(bankAccount.client, client),
        eq(bankAccount.companyCode, values.companyCode),
        eq(bankAccount.houseBankKey, values.houseBankKey),
        eq(bankAccount.accountId, values.accountId),
      ));

    await recordChange(tx, {
      client,
      objectClass: BANK_ACCOUNT_OBJECT_CLASS,
      objectKey,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        accountNumber: existing.accountNumber,
        iban: existing.iban,
        currency: existing.currency.trim(),
        glAccount: existing.glAccount,
      },
      after: {
        accountNumber: values.accountNumber,
        iban: values.iban,
        currency: values.currency,
        glAccount: values.glAccount,
      },
      fieldLabels: {
        accountNumber: 'Account number',
        iban: 'IBAN',
        currency: 'Currency',
        glAccount: 'G/L account',
      },
      securityRelevantFields: ['glAccount'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return result;
  });
}

/** Delete a bank account outright: nothing references one yet. */
export async function deleteBankAccount(raw: BankAccountDeleteInput): Promise<{ deleted: true }> {
  const parsed = bankAccountDeleteInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HouseBankError(
      parsed.error.issues[0]?.message ?? 'The bank account deletion is not valid.',
      'Correct the indicated value and submit again.',
    );
  }

  const { client, changedBy, reason, ...values } = parsed.data;

  return withTenant(client, async (tx) => {
    await assertPrerequisites(tx, client);

    const [existing] = await tx
      .select()
      .from(bankAccount)
      .where(and(
        eq(bankAccount.client, client),
        eq(bankAccount.companyCode, values.companyCode),
        eq(bankAccount.houseBankKey, values.houseBankKey),
        eq(bankAccount.accountId, values.accountId),
      ))
      .for('update');
    if (!existing) {
      throw new HouseBankError(
        `Bank Account ${values.accountId} is not defined under House Bank ${values.houseBankKey}.`,
        'Reload the house banks; the account may already have been deleted.',
      );
    }

    await tx
      .delete(bankAccount)
      .where(and(
        eq(bankAccount.client, client),
        eq(bankAccount.companyCode, values.companyCode),
        eq(bankAccount.houseBankKey, values.houseBankKey),
        eq(bankAccount.accountId, values.accountId),
      ));

    await recordChange(tx, {
      client,
      objectClass: BANK_ACCOUNT_OBJECT_CLASS,
      objectKey: `${houseBankKeyOf(values.companyCode, values.houseBankKey)}/${values.accountId}`,
      changeType: 'DELETE',
      changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: {
        accountNumber: existing.accountNumber,
        iban: existing.iban,
        currency: existing.currency.trim(),
        glAccount: existing.glAccount,
      },
      fieldLabels: {
        accountNumber: 'Account number',
        iban: 'IBAN',
        currency: 'Currency',
        glAccount: 'G/L account',
      },
      securityRelevantFields: ['glAccount'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { deleted: true as const };
  });
}

import { and, asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { bankMaster } from '../../platform/tables/reference';
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

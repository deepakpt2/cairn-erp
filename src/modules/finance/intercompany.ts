/**
 * Intercompany posting and OBYA clearing configuration — SCR-122
 * (FB01 / OBYA search aliases only).
 *
 * One submission posts two balanced journals in one transaction: the
 * sending document carries the operator's lines plus a clearing line on
 * the sending side's OBYA clearing account, the receiving document
 * carries the reversed operator lines plus its own OBYA clearing line.
 * Each document posts through the canonical posting engine, so period
 * validation, numbering, document flow and audit ride the canon — and
 * either document failing rolls the other back with it.
 *
 * Every intercompany line stamps the other company as its trading
 * partner (VBUND/RCOMP parity), so a consolidation elimination can read
 * the pair from the ledger. The OBYA balances are ordinary open-item
 * G/L balances, cleared by the standing FIN.GL.CLEAR screen when
 * settlement occurs — nothing IC-specific is added to clearing.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { companyCode as companyMaster, documentType, exchangeRate } from '../foundation/schema';
import {
  glAccount, glAccountCompany, intercompanyClearingConfig, intercompanyDocumentHeader, journalEntryLine,
} from './schema';

export const INTERCOMPANY_CAPABILITY = 'FIN.IC.POST';
export const INTERCOMPANY_CONFIG_CAPABILITY = 'CFG.FIN.IC.DEFINE';
const IC_CLASS = 'intercompany_posting';
const IC_CONFIG_CLASS = 'intercompany_clearing_config';

export class IntercompanyError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'IntercompanyError';
    this.remedy = remedy;
  }
}

export interface IntercompanyLineInput {
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: string;
  costCenter?: string;
  profitCenter?: string;
  businessPartner?: string;
  lineText?: string;
}

export interface IntercompanyPairConfig {
  sendingCompanyCode: string;
  receivingCompanyCode: string;
  sendingClearingGl: string | null;
  receivingClearingGl: string | null;
  defaultCurrency: string | null;
}

export interface IntercompanyPostingResult {
  sendingDocumentNumber: string;
  sendingFiscalYear: number;
  receivingDocumentNumber: string;
  receivingFiscalYear: number;
  sendingClearingAccount: string;
  receivingClearingAccount: string;
  currency: string;
  sendingLocalCurrency: string;
  receivingLocalCurrency: string;
}

/** Latest AVERAGE rate from a currency to the company's local currency on or before a date. */
async function rateToLocal(
  tx: Tx, client: string, currency: string, localCurrency: string, onDate: string,
): Promise<number | null> {
  if (currency === localCurrency) return 1;
  const [row] = await tx.select().from(exchangeRate).where(and(
    eq(exchangeRate.client, client),
    eq(exchangeRate.rateType, 'AVERAGE'),
    eq(exchangeRate.fromCurrency, currency),
    eq(exchangeRate.toCurrency, localCurrency),
  )).orderBy(sql`${exchangeRate.validFrom} desc`);
  if (!row || row.validFrom > onDate) return null;
  return Number(row.rate) * row.ratioTo / ratio(row.ratioFrom);
}

const ratio = (n: number) => (n === 0 ? 1 : n);

export async function listIntercompanyConfigs(client: string): Promise<IntercompanyPairConfig[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(intercompanyClearingConfig)
      .where(eq(intercompanyClearingConfig.client, client))
      .orderBy(intercompanyClearingConfig.sendingCompanyCode, intercompanyClearingConfig.receivingCompanyCode);
    return rows.map((r) => ({
      sendingCompanyCode: r.sendingCompanyCode,
      receivingCompanyCode: r.receivingCompanyCode,
      sendingClearingGl: r.sendingClearingGl,
      receivingClearingGl: r.receivingClearingGl,
      defaultCurrency: r.defaultCurrency,
    }));
  });
}

export async function saveIntercompanyConfig(input: {
  client: string; changedBy: string;
  sendingCompanyCode: string; receivingCompanyCode: string;
  sendingClearingGl?: string; receivingClearingGl?: string; defaultCurrency?: string;
}): Promise<IntercompanyPairConfig> {
  const sending = input.sendingCompanyCode.trim().toUpperCase();
  const receiving = input.receivingCompanyCode.trim().toUpperCase();
  if (!sending || !receiving) {
    throw new IntercompanyError('Both company codes stand required.', 'Name the sending and the receiving company.');
  }
  if (sending === receiving) {
    throw new IntercompanyError(
      `Company ${sending} cannot trade with itself.`,
      'Name two different company codes of the tenant.',
    );
  }
  return withTenant(input.client, async (tx) => {
    const sendingCompany = await getCompanyCode(tx, input.client, sending);
    const receivingCompany = await getCompanyCode(tx, input.client, receiving);
    for (const [key, company] of [[sending, sendingCompany], [receiving, receivingCompany]] as const) {
      if (!company) {
        throw new IntercompanyError(
          `Company code ${key} does not stand in this tenant.`,
          'Maintain the company code, then configure the pair.',
        );
      }
      if (!company.isActive) {
        throw new IntercompanyError(
          `Company code ${key} stands inactive.`,
          'Activate the company code, or choose another.',
        );
      }
    }
    const chart = sendingCompany!.chartOfAccounts ?? '';
    const toValidate = [
      ['sending', input.sendingClearingGl?.trim().toUpperCase()],
      ['receiving', input.receivingClearingGl?.trim().toUpperCase()],
    ] as const;
    for (const [side, account] of toValidate) {
      if (!account) continue;
      const [row] = await tx.select().from(glAccount).where(and(
        eq(glAccount.client, input.client),
        eq(glAccount.chartOfAccounts, side === 'sending' ? chart : (receivingCompany!.chartOfAccounts ?? '')),
        eq(glAccount.accountNumber, account),
      ));
      if (!row) {
        throw new IntercompanyError(
          `Clearing account ${account} does not stand in the ${side} company's chart.`,
          'Name an account of that chart, or leave the clearing account blank to use the company OBYA account.',
        );
      }
      if (row.accountType !== 'ASSET' && row.accountType !== 'LIABILITY') {
        throw new IntercompanyError(
          `Clearing account ${account} carries account type ${row.accountType}; an intercompany clearing account is a balance-sheet account.`,
          'Name an asset or liability account.',
        );
      }
    }
    await tx.insert(intercompanyClearingConfig).values({
      client: input.client, sendingCompanyCode: sending, receivingCompanyCode: receiving,
      sendingClearingGl: toValidate[0][1] ?? null,
      receivingClearingGl: toValidate[1][1] ?? null,
      defaultCurrency: input.defaultCurrency?.trim().toUpperCase() || null,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [
        intercompanyClearingConfig.client,
        intercompanyClearingConfig.sendingCompanyCode,
        intercompanyClearingConfig.receivingCompanyCode,
      ],
      set: {
        sendingClearingGl: toValidate[0][1] ?? null,
        receivingClearingGl: toValidate[1][1] ?? null,
        defaultCurrency: input.defaultCurrency?.trim().toUpperCase() || null,
        changedBy: input.changedBy, changedAt: new Date(),
      },
    });
    await recordChange(tx, {
      client: input.client, objectClass: IC_CONFIG_CLASS,
      objectKey: `${sending}/${receiving}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: INTERCOMPANY_CONFIG_CAPABILITY,
      after: {
        sending, receiving,
        sendingClearingGl: toValidate[0][1] ?? '', receivingClearingGl: toValidate[1][1] ?? '',
        defaultCurrency: input.defaultCurrency ?? '',
      },
    });
    return {
      sendingCompanyCode: sending, receivingCompanyCode: receiving,
      sendingClearingGl: toValidate[0][1] ?? null,
      receivingClearingGl: toValidate[1][1] ?? null,
      defaultCurrency: input.defaultCurrency?.trim().toUpperCase() || null,
    };
  });
}

export async function deleteIntercompanyConfig(input: {
  client: string; changedBy: string; sendingCompanyCode: string; receivingCompanyCode: string;
}): Promise<{ deleted: true }> {
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(intercompanyClearingConfig).where(and(
      eq(intercompanyClearingConfig.client, input.client),
      eq(intercompanyClearingConfig.sendingCompanyCode, input.sendingCompanyCode.toUpperCase()),
      eq(intercompanyClearingConfig.receivingCompanyCode, input.receivingCompanyCode.toUpperCase()),
    ));
    if (!standing) {
      throw new IntercompanyError(
        `No configuration stands for ${input.sendingCompanyCode} to ${input.receivingCompanyCode}.`,
        'Reload the pairs.',
      );
    }
    // The configuration is historical only once a posting used it: a pair that
    // has posted keeps its record, because the pairing rows cite it.
    const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(intercompanyDocumentHeader)
      .where(and(
        eq(intercompanyDocumentHeader.client, input.client),
        eq(intercompanyDocumentHeader.sendingCompanyCode, standing.sendingCompanyCode),
        eq(intercompanyDocumentHeader.receivingCompanyCode, standing.receivingCompanyCode),
      ));
    if ((used?.n ?? 0) > 0) {
      throw new IntercompanyError(
        `Configuration ${standing.sendingCompanyCode} to ${standing.receivingCompanyCode} has served ${used!.n} posting(s) and cannot be deleted.`,
        'The pair stands as history; define a new pair rather than removing this one.',
      );
    }
    await tx.delete(intercompanyClearingConfig).where(and(
      eq(intercompanyClearingConfig.client, input.client),
      eq(intercompanyClearingConfig.sendingCompanyCode, standing.sendingCompanyCode),
      eq(intercompanyClearingConfig.receivingCompanyCode, standing.receivingCompanyCode),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: IC_CONFIG_CLASS,
      objectKey: `${standing.sendingCompanyCode}/${standing.receivingCompanyCode}`,
      changeType: 'DELETE', changedBy: input.changedBy, transactionCode: INTERCOMPANY_CONFIG_CAPABILITY,
      before: {
        sending: standing.sendingCompanyCode, receiving: standing.receivingCompanyCode,
        sendingClearingGl: standing.sendingClearingGl ?? '', receivingClearingGl: standing.receivingClearingGl ?? '',
      },
    });
    return { deleted: true };
  });
}

/** The side's clearing account: the pair override first, the company OBYA account second. */
async function clearingAccountFor(
  tx: Tx, client: string, companyCodeKey: string, override: string | null,
): Promise<string> {
  if (override) return override;
  const company = await getCompanyCode(tx, client, companyCodeKey);
  const account = company?.intercompanyClearingAccount?.trim();
  if (!account) {
    throw new IntercompanyError(
      `Company ${companyCodeKey} carries no OBYA intercompany clearing account.`,
      'Maintain the clearing account on the company code, or configure the pair with one.',
    );
  }
  const [row] = await tx.select().from(glAccount).where(and(
    eq(glAccount.client, client),
    eq(glAccount.chartOfAccounts, company!.chartOfAccounts ?? ''),
    eq(glAccount.accountNumber, account),
  ));
  if (!row) {
    throw new IntercompanyError(
      `Intercompany clearing account ${account} of company ${companyCodeKey} does not stand in chart ${company!.chartOfAccounts}.`,
      'Maintain the account, then post.',
    );
  }
  const [segment] = await tx.select().from(glAccountCompany).where(and(
    eq(glAccountCompany.client, client),
    eq(glAccountCompany.companyCode, companyCodeKey),
    eq(glAccountCompany.glAccount, account),
  ));
  if (!segment) {
    throw new IntercompanyError(
      `Intercompany clearing account ${account} does not stand extended to company ${companyCodeKey}.`,
      'Extend the account to the company code, then post.',
    );
  }
  return account;
}

export async function postIntercompany(input: {
  client: string; changedBy: string;
  sendingCompanyCode: string; receivingCompanyCode: string;
  postingDate: string; documentDate: string;
  documentType: string; currency?: string; reference?: string;
  headerText?: string; confirmed: boolean; requestKey: string;
  lines: IntercompanyLineInput[];
}): Promise<IntercompanyPostingResult> {
  const sending = input.sendingCompanyCode.trim().toUpperCase();
  const receiving = input.receivingCompanyCode.trim().toUpperCase();
  if (!input.confirmed) {
    throw new IntercompanyError('The intercompany posting stands unconfirmed.', 'Tick the confirmation, then post.');
  }
  if (!sending || !receiving) {
    throw new IntercompanyError('Both company codes stand required.', 'Name the sending and the receiving company.');
  }
  if (sending === receiving) {
    throw new IntercompanyError(
      `Company ${sending} cannot trade with itself.`,
      'Name two different company codes of the tenant.',
    );
  }
  if (input.lines.length === 0) {
    throw new IntercompanyError('Enter at least one line.', 'Post the expense or balance the pair settles.');
  }
  for (const [label, value] of [['Posting date', input.postingDate], ['Document date', input.documentDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IntercompanyError(`${label} ${value} is not a calendar date.`);
  }
  if (!/^[A-Z0-9]{2}$/.test(input.documentType)) {
    throw new IntercompanyError(`Document type ${input.documentType} is not a two-character document type.`, 'Choose a configured document type.');
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/intercompany/${sending}/${receiving}`}, 0))`);

    const replay = input.requestKey
      ? await standingForRequestKey(tx, input.client, input.requestKey)
      : null;
    if (replay) return replay;

    const sendingCompany = await getCompanyCode(tx, input.client, sending);
    const receivingCompany = await getCompanyCode(tx, input.client, receiving);
    for (const [key, company] of [[sending, sendingCompany], [receiving, receivingCompany]] as const) {
      if (!company) {
        throw new IntercompanyError(`Company code ${key} does not stand in this tenant.`, 'Maintain the company code, then post.');
      }
      if (!company.isActive) {
        throw new IntercompanyError(`Company code ${key} stands inactive.`, 'Activate the company code, then post.');
      }
    }
    const [typeRow] = await tx.select().from(documentType).where(and(
      eq(documentType.client, input.client), eq(documentType.documentType, input.documentType),
    ));
    if (!typeRow) {
      throw new IntercompanyError(`Document type ${input.documentType} is not configured.`, 'Choose a configured document type (OBA7).');
    }

    const [pair] = await tx.select().from(intercompanyClearingConfig).where(and(
      eq(intercompanyClearingConfig.client, input.client),
      eq(intercompanyClearingConfig.sendingCompanyCode, sending),
      eq(intercompanyClearingConfig.receivingCompanyCode, receiving),
    ));
    const currency = (input.currency?.trim().toUpperCase()
      || pair?.defaultCurrency
      || sendingCompany!.currency);
    const sendingClearing = await clearingAccountFor(tx, input.client, sending, pair?.sendingClearingGl ?? null);
    const receivingClearing = await clearingAccountFor(tx, input.client, receiving, pair?.receivingClearingGl ?? null);

    const sendingRate = await rateToLocal(tx, input.client, currency, sendingCompany!.currency, input.postingDate);
    if (sendingRate === null) {
      throw new IntercompanyError(
        `No AVERAGE rate stands from ${currency} to ${sendingCompany!.currency} on or before ${input.postingDate}.`,
        'Maintain the exchange rate (SCR-034), then post.',
      );
    }
    const receivingRate = await rateToLocal(tx, input.client, currency, receivingCompany!.currency, input.postingDate);
    if (receivingRate === null) {
      throw new IntercompanyError(
        `No AVERAGE rate stands from ${currency} to ${receivingCompany!.currency} on or before ${input.postingDate}.`,
        'Maintain the exchange rate (SCR-034), then post.',
      );
    }

    // The operator's lines are the sending side's primary lines; the clearing
    // line balances the sending document, and the receiving document mirrors.
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const signed = input.lines.reduce((s, l) => s + (l.debitCredit === 'S' ? 1 : -1) * Number(l.amount), 0);
    if (!Number.isFinite(signed)) {
      throw new IntercompanyError('A line amount does not stand as a number.', 'Correct the amounts, then post.');
    }
    const signedRounded = round2(signed);
    if (signedRounded === 0) {
      throw new IntercompanyError(
        'The operator lines already balance, so no intercompany clearing remains.',
        'Enter the primary lines of the sending side only; the clearing lines are generated.',
      );
    }
    const clearingDirection: 'S' | 'H' = signedRounded > 0 ? 'H' : 'S';
    const clearingAmount = Math.abs(signedRounded).toFixed(2);

    const sendingPosition = await derivePosition(tx, input.client, sendingCompany!.fiscalYearVariant!, input.postingDate);
    const receivingPosition = await derivePosition(tx, input.client, receivingCompany!.fiscalYearVariant!, input.postingDate);

    const sendingJournal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: sending,
      documentType: input.documentType,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: sendingPosition.fiscalYear,
      postingPeriod: sendingPosition.period,
      currency,
      localCurrency: sendingCompany!.currency,
      exchangeRate: String(sendingRate),
      reference: input.reference,
      headerText: input.headerText ?? `Intercompany with ${receiving}`,
      lines: [
        ...input.lines.map((l) => ({
          glAccount: l.glAccount,
          debitCredit: l.debitCredit,
          amount: Number(l.amount).toFixed(2),
          ...(l.costCenter ? { costCenter: l.costCenter } : {}),
          ...(l.profitCenter ? { profitCenter: l.profitCenter } : {}),
          ...(l.businessPartner ? { businessPartner: l.businessPartner } : {}),
          ...(l.lineText ? { lineText: l.lineText } : {}),
        })),
        {
          glAccount: sendingClearing,
          debitCredit: clearingDirection,
          amount: clearingAmount,
          lineText: `Intercompany clearing with ${receiving}`,
        },
      ],
      origin: { documentClass: IC_CLASS, documentKey: `${sending}/${receiving}` },
      postedBy: input.changedBy,
      transactionCode: INTERCOMPANY_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new IntercompanyError(error.message, error.remedy);
      throw error;
    });

    const receivingJournal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: receiving,
      documentType: input.documentType,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: receivingPosition.fiscalYear,
      postingPeriod: receivingPosition.period,
      currency,
      localCurrency: receivingCompany!.currency,
      exchangeRate: String(receivingRate),
      reference: input.reference,
      headerText: input.headerText ?? `Intercompany with ${sending}`,
      lines: [
        ...input.lines.map((l) => ({
          glAccount: l.glAccount,
          debitCredit: l.debitCredit === 'S' ? 'H' as const : 'S' as const,
          amount: Number(l.amount).toFixed(2),
          ...(l.profitCenter ? { profitCenter: l.profitCenter } : {}),
          ...(l.businessPartner ? { businessPartner: l.businessPartner } : {}),
          ...(l.lineText ? { lineText: l.lineText } : {}),
        })),
        {
          glAccount: receivingClearing,
          debitCredit: clearingDirection === 'S' ? 'H' as const : 'S' as const,
          amount: clearingAmount,
          lineText: `Intercompany clearing with ${sending}`,
        },
      ],
      origin: { documentClass: IC_CLASS, documentKey: `${receiving}/${sending}` },
      postedBy: input.changedBy,
      transactionCode: INTERCOMPANY_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new IntercompanyError(error.message, error.remedy);
      throw error;
    });

    // Trading partner stamp (VBUND/RCOMP parity): every line names the other company.
    await tx.update(journalEntryLine).set({ tradingPartnerCompany: receiving }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, sendingJournal.documentNumber),
      eq(journalEntryLine.fiscalYear, sendingJournal.fiscalYear),
    ));
    await tx.update(journalEntryLine).set({ tradingPartnerCompany: sending }).where(and(
      eq(journalEntryLine.client, input.client),
      eq(journalEntryLine.documentNumber, receivingJournal.documentNumber),
      eq(journalEntryLine.fiscalYear, receivingJournal.fiscalYear),
    ));

    await tx.insert(intercompanyDocumentHeader).values({
      client: input.client,
      sendingCompanyCode: sending,
      documentNumber: sendingJournal.documentNumber,
      fiscalYear: sendingJournal.fiscalYear,
      receivingCompanyCode: receiving,
      partnerDocumentNumber: receivingJournal.documentNumber,
      partnerFiscalYear: receivingJournal.fiscalYear,
      postingDate: input.postingDate,
      documentDate: input.documentDate,
      currency,
      reference: input.reference ?? null,
      createdBy: input.changedBy,
    });

    await recordChange(tx, {
      client: input.client, objectClass: IC_CLASS,
      objectKey: `${sending}/${sendingJournal.documentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: INTERCOMPANY_CAPABILITY,
      after: {
        sending, receiving,
        sendingDocument: sendingJournal.documentNumber,
        receivingDocument: receivingJournal.documentNumber,
        sendingClearingAccount: sendingClearing,
        receivingClearingAccount: receivingClearing,
        currency, requestKey: input.requestKey,
        reference: input.reference ?? '',
        lines: input.lines.length,
      },
    });

    return {
      sendingDocumentNumber: sendingJournal.documentNumber,
      sendingFiscalYear: sendingJournal.fiscalYear,
      receivingDocumentNumber: receivingJournal.documentNumber,
      receivingFiscalYear: receivingJournal.fiscalYear,
      sendingClearingAccount: sendingClearing,
      receivingClearingAccount: receivingClearing,
      currency,
      sendingLocalCurrency: sendingCompany!.currency,
      receivingLocalCurrency: receivingCompany!.currency,
    };
  });
}

/** Replay lookup: one accepted submission key names one document pair. */
async function standingForRequestKey(
  tx: Tx, client: string, requestKey: string,
): Promise<IntercompanyPostingResult | null> {
  const rows = await tx.select().from(intercompanyDocumentHeader)
    .where(eq(intercompanyDocumentHeader.client, client));
  for (const row of rows) {
    const changes = await tx.execute(sql`
      select 1 from change_document_item i
      join change_document d on d.client = i.client and d.id = i.change_document_id
      where i.client = ${client} and d.object_class = ${IC_CLASS}
        and i.field_name = 'requestKey' and i.new_value = ${requestKey}
        and i.field_name in ('requestKey')
      limit 1
    `) as unknown as unknown[];
    if (changes.length === 0) continue;
    const [pair] = await tx.select().from(intercompanyDocumentHeader).where(and(
      eq(intercompanyDocumentHeader.client, client),
      eq(intercompanyDocumentHeader.documentNumber, row.documentNumber),
    ));
    if (!pair) return null;
    const sending = await getCompanyCode(tx, client, pair.sendingCompanyCode);
    const receiving = await getCompanyCode(tx, client, pair.receivingCompanyCode);
    const [config] = await tx.select().from(intercompanyClearingConfig).where(and(
      eq(intercompanyClearingConfig.client, client),
      eq(intercompanyClearingConfig.sendingCompanyCode, pair.sendingCompanyCode),
      eq(intercompanyClearingConfig.receivingCompanyCode, pair.receivingCompanyCode),
    ));
    return {
      sendingDocumentNumber: pair.documentNumber,
      sendingFiscalYear: pair.fiscalYear,
      receivingDocumentNumber: pair.partnerDocumentNumber,
      receivingFiscalYear: pair.partnerFiscalYear,
      sendingClearingAccount: config?.sendingClearingGl ?? sending?.intercompanyClearingAccount ?? '',
      receivingClearingAccount: config?.receivingClearingGl ?? receiving?.intercompanyClearingAccount ?? '',
      currency: pair.currency,
      sendingLocalCurrency: sending?.currency ?? pair.currency,
      receivingLocalCurrency: receiving?.currency ?? pair.currency,
    };
  }
  return null;
}

/** The company pairs standing in the tenant, for the posting screen's pickers. */
export async function listCompanyChoices(client: string): Promise<Array<{ companyCode: string; name: string; currency: string }>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      companyCode: companyMaster.companyCode, name: companyMaster.name, currency: companyMaster.currency,
    }).from(companyMaster).where(and(
      eq(companyMaster.client, client), eq(companyMaster.isActive, true),
    )).orderBy(companyMaster.companyCode);
    return rows;
  });
}

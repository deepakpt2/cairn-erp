import { fromScaled, toScaled } from '../../platform/posting/decimal';

export interface InstructionItem {
  itemNumber: number;
  companyCode: string;
  accountId: string;
  journalDocumentNumber: string;
  journalFiscalYear: number;
  journalLineNumber: number;
  invoiceNumber: string | null;
  currency: string;
  amount: string;
  dueDate: string | null;
  paymentMethod: string | null;
  exceptionCode: string | null;
}

export interface InstructionBankAmount {
  companyCode: string;
  supplier: string;
  currency: string;
  amount: string;
}

export interface InstructionRelease {
  status: string;
  groupCode: string | null;
  strategyCode: string | null;
  steps: string[];
  currentStep: number;
  changedAt?: string | null;
}

function canonicalAmount(value: string | number): string {
  try { return fromScaled(toScaled(String(value))); } catch { return String(value).trim(); }
}

/**
 * A stable canonical description of the exact material instruction a payment-run execution is
 * about. It includes the released proposal's source journal identities and allocated amounts, the
 * selected bank and its actual currency, the bank evidence, and the release state. Any material
 * change produces a different string; an identical retry reproduces it.
 */
export function paymentInstructionCanonical(input: {
  runDate: string;
  runId: string;
  houseBankKey: string;
  bankAccountId: string;
  bankCurrencies: Array<{ companyCode: string; currency: string; glAccount: string }>;
  items: InstructionItem[];
  bankAmounts?: InstructionBankAmount[];
  release: InstructionRelease | null;
}): string {
  const items = input.items.map((item) => ({
    itemNumber: item.itemNumber,
    companyCode: item.companyCode.trim().toUpperCase(),
    accountId: item.accountId.trim().toUpperCase(),
    journalDocumentNumber: item.journalDocumentNumber.trim(),
    journalFiscalYear: item.journalFiscalYear,
    journalLineNumber: item.journalLineNumber,
    invoiceNumber: item.invoiceNumber?.trim() ?? null,
    currency: item.currency.trim().toUpperCase(),
    amount: canonicalAmount(item.amount),
    dueDate: item.dueDate?.trim() ?? null,
    paymentMethod: item.paymentMethod?.trim().toUpperCase() ?? null,
    exceptionCode: item.exceptionCode?.trim().toUpperCase() ?? null,
  })).sort((a, b) => a.itemNumber - b.itemNumber
    || a.journalDocumentNumber.localeCompare(b.journalDocumentNumber)
    || a.journalFiscalYear - b.journalFiscalYear
    || a.journalLineNumber - b.journalLineNumber);

  const bankCurrencies = input.bankCurrencies.map((bank) => ({
    companyCode: bank.companyCode.trim().toUpperCase(),
    currency: bank.currency.trim().toUpperCase(),
    glAccount: bank.glAccount.trim(),
  })).sort((a, b) => a.companyCode.localeCompare(b.companyCode));

  const bankAmounts = (input.bankAmounts ?? []).map((row) => ({
    companyCode: row.companyCode.trim().toUpperCase(),
    supplier: row.supplier.trim().toUpperCase(),
    currency: row.currency.trim().toUpperCase(),
    amount: canonicalAmount(row.amount),
  })).sort((a, b) => `${a.companyCode}|${a.supplier}|${a.currency}`
    .localeCompare(`${b.companyCode}|${b.supplier}|${b.currency}`));

  return JSON.stringify({
    version: 1,
    runDate: input.runDate.trim(),
    runId: input.runId.trim().toUpperCase(),
    bank: {
      houseBankKey: input.houseBankKey.trim().toUpperCase(),
      accountId: input.bankAccountId.trim().toUpperCase(),
      currencies: bankCurrencies,
    },
    items,
    bankAmounts,
    release: input.release ? {
      status: input.release.status,
      groupCode: input.release.groupCode,
      strategyCode: input.release.strategyCode,
      steps: [...input.release.steps],
      currentStep: input.release.currentStep,
      changedAt: input.release.changedAt ?? null,
    } : null,
  });
}

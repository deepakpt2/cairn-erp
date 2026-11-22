'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EMPLOYEE_ROUTE } from '@/modules/people/employee-master';
import {
  BANK_MAINTAIN_CAPABILITY,
  BANK_REVEAL_CAPABILITY,
  EmployeeBankError,
  createEmployeeBank,
  endEmployeeBank,
  isEmployeeBankError,
  revealEmployeeBank,
} from '@/modules/people/employee-bank';
import { loadBankDataKeyring } from '@/platform/security/bank-data-keyring';

export interface BankActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** The full value, shown once after an audited reveal. */
  revealed?: string;
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

function refusal(error: unknown): BankActionState {
  if (isEmployeeBankError(error)) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

export async function addBankAction(_prev: BankActionState, form: FormData): Promise<BankActionState> {
  const session = await requireSession(EMPLOYEE_ROUTE);
  if (!can(session, BANK_MAINTAIN_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${BANK_MAINTAIN_CAPABILITY}.`, remedy: `Ask an administrator for ${BANK_MAINTAIN_CAPABILITY}.` };
  }
  try {
    const view = await createEmployeeBank({
      client: session.user.client,
      personnelNumber: text(form, 'personnelNumber'),
      beneficiaryName: text(form, 'beneficiaryName'),
      bankName: text(form, 'bankName'),
      bankCode: text(form, 'bankCode') || undefined,
      accountKind: (text(form, 'accountKind') || 'IBAN') as 'IBAN' | 'ACCOUNT',
      accountValue: text(form, 'accountValue'),
      country: text(form, 'country') || undefined,
      validFrom: text(form, 'validFrom'),
      validTo: text(form, 'validTo') || undefined,
      changedBy: session.user.username,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } }, loadBankDataKeyring());
    revalidatePath(EMPLOYEE_ROUTE);
    return { ok: true, message: `Added an account effective ${view.validFrom} (${view.maskedAccount}).` };
  } catch (error) {
    return refusal(error);
  }
}

export async function endBankAction(_prev: BankActionState, form: FormData): Promise<BankActionState> {
  const session = await requireSession(EMPLOYEE_ROUTE);
  if (!can(session, BANK_MAINTAIN_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${BANK_MAINTAIN_CAPABILITY}.`, remedy: `Ask an administrator for ${BANK_MAINTAIN_CAPABILITY}.` };
  }
  try {
    await endEmployeeBank({
      client: session.user.client,
      bankRecordId: text(form, 'bankRecordId'),
      validTo: text(form, 'validTo'),
      changedBy: session.user.username,
    }, { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } }, loadBankDataKeyring());
    revalidatePath(EMPLOYEE_ROUTE);
    return { ok: true, message: 'Account ended; it stays readable as history.' };
  } catch (error) {
    return refusal(error);
  }
}

export async function revealBankAction(_prev: BankActionState, form: FormData): Promise<BankActionState> {
  const session = await requireSession(EMPLOYEE_ROUTE);
  if (!can(session, BANK_REVEAL_CAPABILITY)) {
    return { ok: false, message: `You do not hold ${BANK_REVEAL_CAPABILITY}.`, remedy: `Ask an administrator for ${BANK_REVEAL_CAPABILITY}.` };
  }
  try {
    const revealed = await revealEmployeeBank(
      session.user.client,
      text(form, 'bankRecordId'),
      { purpose: text(form, 'purpose') || 'PAYROLL_SUPPORT', changedBy: session.user.username },
      { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
      loadBankDataKeyring(),
    );
    return { ok: true, message: 'Revealed (audited).', revealed: revealed.accountValue };
  } catch (error) {
    return refusal(error);
  }
}

export type { EmployeeBankError };

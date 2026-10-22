'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PARKED_JOURNAL_CAPABILITY,
  ParkedJournalError,
  completeParkedJournal,
  deleteParkedJournal,
  editParkedJournal,
  parkJournal,
  postParkedJournal,
  type ParkedLineInput,
} from '@/modules/finance/parked-journal';

export interface ParkedJournalActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/journal/park';
const POST_CAPABILITY = 'FIN.JOURNAL.POST';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): ParkedJournalActionState {
  if (error instanceof ParkedJournalError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function parseLines(form: FormData): ParkedLineInput[] {
  const raw = text(form, 'lines');
  if (!raw) return [];
  const rows = JSON.parse(raw) as Array<Record<string, string>>;
  return rows
    .filter((r) => r.glAccount || r.amount)
    .map((r) => ({
      glAccount: (r.glAccount ?? '').toUpperCase(),
      debitCredit: r.debitCredit === 'H' ? 'H' as const : 'S' as const,
      amount: Number(r.amount),
      costCenter: r.costCenter || undefined,
      profitCenter: r.profitCenter || undefined,
      taxCode: r.taxCode || undefined,
      assignment: r.assignment || undefined,
      lineText: r.lineText || undefined,
    }));
}

function headerFields(form: FormData) {
  return {
    companyCode: text(form, 'companyCode'),
    documentDate: text(form, 'documentDate'), postingDate: text(form, 'postingDate'),
    documentType: text(form, 'documentType').toUpperCase(),
    currency: text(form, 'currency').toUpperCase(),
    reference: text(form, 'reference') || undefined,
    headerText: text(form, 'headerText') || undefined,
    lines: parseLines(form),
  };
}

export async function parkAction(
  _previous: ParkedJournalActionState,
  form: FormData,
): Promise<ParkedJournalActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PARKED_JOURNAL_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the journal parking capability.' };
  }
  try {
    const parkedNumber = text(form, 'parkedNumber');
    if (parkedNumber) {
      await assertChangeForSession(session, { lockObject: 'PARKED_JOURNAL', argument: parkedNumber });
      const result = await editParkedJournal({
        client: session.user.client, changedBy: session.user.username,
        parkedNumber, expectedVersion: Number(text(form, 'version')),
        ...headerFields(form),
      });
      revalidatePath(ROUTE);
      return { ok: true, message: `Parked document ${result.parkedNumber} saved (version ${result.version}); it stands PARKED for re-judging.` };
    }
    const result = await parkJournal({
      client: session.user.client, changedBy: session.user.username,
      requestKey: text(form, 'requestKey') || crypto.randomUUID(),
      ...headerFields(form),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Document parked as ${result.parkedNumber}: debits ${result.totalDebit.toFixed(2)}, credits ${result.totalCredit.toFixed(2)}. No account has moved.`,
    };
  } catch (error) {
    return wrap(error);
  }
}

export async function completeAction(
  _previous: ParkedJournalActionState,
  form: FormData,
): Promise<ParkedJournalActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PARKED_JOURNAL_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the journal parking capability.' };
  }
  try {
    const parkedNumber = text(form, 'parkedNumber');
    await assertChangeForSession(session, { lockObject: 'PARKED_JOURNAL', argument: parkedNumber });
    const result = await completeParkedJournal({
      client: session.user.client, changedBy: session.user.username,
      parkedNumber: text(form, 'parkedNumber'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Parked document ${result.parkedNumber} stands COMPLETED and ready to post.` };
  } catch (error) {
    return wrap(error);
  }
}

export async function postAction(
  _previous: ParkedJournalActionState,
  form: FormData,
): Promise<ParkedJournalActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PARKED_JOURNAL_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the journal parking capability.' };
  }
  if (!can(session, POST_CAPABILITY)) {
    return { ok: false, message: 'Posting a parked document takes the journal posting capability, apart from parking.' };
  }
  try {
    const parkedNumber = text(form, 'parkedNumber');
    await assertChangeForSession(session, { lockObject: 'PARKED_JOURNAL', argument: parkedNumber });
    const result = await postParkedJournal({
      client: session.user.client, changedBy: session.user.username,
      parkedNumber: text(form, 'parkedNumber'),
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Parked document ${result.parkedNumber} posted as document ${result.postedDocumentNumber}.` };
  } catch (error) {
    return wrap(error);
  }
}

export async function deleteAction(
  _previous: ParkedJournalActionState,
  form: FormData,
): Promise<ParkedJournalActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, PARKED_JOURNAL_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the journal parking capability.' };
  }
  try {
    const parkedNumber = text(form, 'parkedNumber');
    await assertChangeForSession(session, { lockObject: 'PARKED_JOURNAL', argument: parkedNumber });
    const result = await deleteParkedJournal({
      client: session.user.client, changedBy: session.user.username,
      parkedNumber: text(form, 'parkedNumber'),
      reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Parked document ${result.parkedNumber} stands DELETED on record.` };
  } catch (error) {
    return wrap(error);
  }
}

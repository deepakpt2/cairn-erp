/**
 * Release of parked journal entries (category JOURNAL_ENTRY).
 *
 * A strategy claims a parked journal by its attributes (total debits, company code, document type,
 * currency). A claimed journal cannot be posted until it stands RELEASED, and the person who parked
 * it cannot release it. An edit after release acts were given sends the journal back to step one.
 * Direct posting through the journal entry screen is a separate authority (FIN.JOURNAL.POST) and is
 * not gated here: the strategy governs the park-then-post path.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import type { ReleaseAttributes } from '../foundation/release-strategy-definition';
import {
  RELEASE_CAPABILITIES, assertDocumentReleased, cancelDocumentRelease, getDocumentRelease,
  releaseDocument, syncDocumentRelease, ReleaseError, type DocumentReleaseState,
} from '../purchasing/release';
import { parkedJournalHeader, parkedJournalLine } from './schema';
import { withTenant } from '../../platform/db/client';

export const JOURNAL_RELEASE_CATEGORY = 'JOURNAL_ENTRY';
export const JOURNAL_RELEASE_CAPABILITY = RELEASE_CAPABILITIES.JOURNAL_ENTRY;

export async function parkedJournalAttributes(tx: Tx, client: string, parkedNumber: string): Promise<ReleaseAttributes | null> {
  const [header] = await tx.select().from(parkedJournalHeader).where(and(
    eq(parkedJournalHeader.client, client), eq(parkedJournalHeader.parkedNumber, parkedNumber),
  ));
  if (!header) return null;
  const lines = await tx.select().from(parkedJournalLine).where(and(
    eq(parkedJournalLine.client, client), eq(parkedJournalLine.parkedNumber, parkedNumber),
  ));
  const debits = lines.filter((l) => l.debitCredit === 'S').reduce((sum, l) => sum + Number(l.amount), 0);
  return {
    TOTAL_VALUE: Math.round(debits * 100) / 100,
    COMPANY_CODE: header.companyCode,
    DOCUMENT_TYPE: header.documentType,
    CURRENCY: header.currency,
  };
}

/** Re-determine the release of a parked journal. `restart` when the document was edited. */
export async function syncParkedJournalRelease(
  tx: Tx, client: string, parkedNumber: string, changedBy: string, restart = false,
): Promise<void> {
  const attributes = await parkedJournalAttributes(tx, client, parkedNumber);
  if (!attributes) return;
  await syncDocumentRelease(tx, client, JOURNAL_RELEASE_CATEGORY, parkedNumber, attributes, changedBy, { restart });
}

/** Posting gate: a claimed journal must stand released. */
export async function assertParkedJournalReleased(tx: Tx, client: string, parkedNumber: string): Promise<void> {
  await assertDocumentReleased(tx, client, JOURNAL_RELEASE_CATEGORY, parkedNumber, 'Parked document');
}

export function getParkedJournalRelease(client: string, parkedNumber: string): Promise<DocumentReleaseState> {
  return getDocumentRelease(client, JOURNAL_RELEASE_CATEGORY, parkedNumber);
}

async function openHeader(client: string, parkedNumber: string) {
  const [header] = await withTenant(client, (tx) => tx.select().from(parkedJournalHeader).where(and(
    eq(parkedJournalHeader.client, client), eq(parkedJournalHeader.parkedNumber, parkedNumber),
  )));
  if (!header) throw new ReleaseError(`Parked document ${parkedNumber} does not exist.`);
  if (header.status !== 'PARKED' && header.status !== 'COMPLETED') {
    throw new ReleaseError(`Parked document ${parkedNumber} stands ${header.status.toLowerCase()}; it takes no release act.`);
  }
  return header;
}

export async function releaseParkedJournal(input: {
  client: string; changedBy: string; parkedNumber: string; releaseCode: string;
}): Promise<DocumentReleaseState> {
  const header = await openHeader(input.client, input.parkedNumber);
  return releaseDocument({
    client: input.client, changedBy: input.changedBy, documentCategory: JOURNAL_RELEASE_CATEGORY,
    documentNumber: input.parkedNumber, releaseCode: input.releaseCode,
    preparedBy: header.createdBy, objectKey: `${header.companyCode}/${input.parkedNumber}`,
  });
}

export async function cancelParkedJournalRelease(input: {
  client: string; changedBy: string; parkedNumber: string;
}): Promise<DocumentReleaseState> {
  const header = await openHeader(input.client, input.parkedNumber);
  return cancelDocumentRelease({
    client: input.client, changedBy: input.changedBy, documentCategory: JOURNAL_RELEASE_CATEGORY,
    documentNumber: input.parkedNumber, objectKey: `${header.companyCode}/${input.parkedNumber}`,
  });
}

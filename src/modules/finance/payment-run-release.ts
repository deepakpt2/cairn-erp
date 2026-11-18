/**
 * Release of payment runs (category PAYMENT_RUN).
 *
 * The proposal of a run is judged by a release strategy on its total (the items that will pay),
 * company code and currency. A claimed run cannot be executed until it stands RELEASED, and the
 * person who generated the proposal cannot release it. Regenerating the proposal after release acts
 * were given sends the run back to step one, because those acts judged a different proposal.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import type { ReleaseAttributes } from '../foundation/release-strategy-definition';
import {
  RELEASE_CAPABILITIES, assertDocumentReleased, cancelDocumentRelease, getDocumentRelease,
  releaseDocument, syncDocumentRelease, ReleaseError, type DocumentReleaseState,
} from '../purchasing/release';
import { paymentRun } from './schema';
import { assertNoActivePaymentOperation, type PaymentRunView } from './payment-run';

export const PAYMENT_RUN_RELEASE_CATEGORY = 'PAYMENT_RUN';
export const PAYMENT_RUN_RELEASE_CAPABILITY = RELEASE_CAPABILITIES.PAYMENT_RUN;

/** The key a run is released under: its date and identification. */
export const paymentRunReleaseKey = (runDate: string, runId: string) => `${runDate}/${runId}`;

export function paymentRunAttributes(run: PaymentRunView): ReleaseAttributes {
  const payable = run.proposal.filter((item) => !item.exceptionCode);
  const attributes: ReleaseAttributes = {
    TOTAL_VALUE: Math.round(payable.reduce((sum, item) => sum + Number(item.amount), 0) * 100) / 100,
  };
  const companies = [...new Set(payable.map((item) => item.companyCode))];
  if (companies.length === 1) attributes.COMPANY_CODE = companies[0];
  const currencies = [...new Set(payable.map((item) => item.currency))];
  if (currencies.length === 1) attributes.CURRENCY = currencies[0];
  return attributes;
}

/** Re-determine the release of a run after its proposal was generated. */
export async function syncPaymentRunRelease(
  tx: Tx, client: string, run: PaymentRunView, changedBy: string,
): Promise<void> {
  await syncDocumentRelease(
    tx, client, PAYMENT_RUN_RELEASE_CATEGORY, paymentRunReleaseKey(run.runDate, run.runId),
    paymentRunAttributes(run), changedBy, { restart: true },
  );
}

/** Execution gate: a claimed run must stand released. */
export async function assertPaymentRunReleased(tx: Tx, client: string, runDate: string, runId: string): Promise<void> {
  await assertDocumentReleased(tx, client, PAYMENT_RUN_RELEASE_CATEGORY, paymentRunReleaseKey(runDate, runId), 'Payment run');
}

export function getPaymentRunRelease(client: string, runDate: string, runId: string): Promise<DocumentReleaseState> {
  return getDocumentRelease(client, PAYMENT_RUN_RELEASE_CATEGORY, paymentRunReleaseKey(runDate, runId));
}

async function proposedRun(client: string, runDate: string, runId: string) {
  const [run] = await withTenant(client, (tx) => tx.select().from(paymentRun).where(and(
    eq(paymentRun.client, client), eq(paymentRun.runDate, runDate), eq(paymentRun.runId, runId),
  )));
  if (!run) throw new ReleaseError(`Payment run ${paymentRunReleaseKey(runDate, runId)} does not exist.`);
  if (run.status !== 'PROPOSAL') {
    throw new ReleaseError(`Payment run ${paymentRunReleaseKey(runDate, runId)} stands ${run.status.toLowerCase()}; only a proposal takes a release act.`);
  }
  // A release act on a proposal that is being replaced, or paid, would judge the wrong thing. (The
  // execution re-checks the release itself at its posting boundary, so this is the early, kind refusal.)
  await withTenant(client, (tx) => assertNoActivePaymentOperation(tx, client, runDate, runId, 'released or un-released')).catch((error: unknown) => {
    if (error instanceof Error && error.name === 'PaymentRunError') throw new ReleaseError(error.message, (error as { remedy?: string }).remedy);
    throw error;
  });
  return run;
}

export async function releasePaymentRun(input: {
  client: string; changedBy: string; runDate: string; runId: string; releaseCode: string;
}): Promise<DocumentReleaseState> {
  const run = await proposedRun(input.client, input.runDate, input.runId);
  const key = paymentRunReleaseKey(input.runDate, input.runId);
  return releaseDocument({
    client: input.client, changedBy: input.changedBy, documentCategory: PAYMENT_RUN_RELEASE_CATEGORY,
    documentNumber: key, releaseCode: input.releaseCode,
    // Whoever last generated the proposal prepared what is being released.
    preparedBy: run.changedBy ?? run.createdBy, objectKey: key,
  });
}

export async function cancelPaymentRunRelease(input: {
  client: string; changedBy: string; runDate: string; runId: string;
}): Promise<DocumentReleaseState> {
  await proposedRun(input.client, input.runDate, input.runId);
  const key = paymentRunReleaseKey(input.runDate, input.runId);
  return cancelDocumentRelease({
    client: input.client, changedBy: input.changedBy, documentCategory: PAYMENT_RUN_RELEASE_CATEGORY,
    documentNumber: key, objectKey: key,
  });
}

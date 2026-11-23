/**
 * Background payment run (F110): proposal and execution as jobs.
 *
 * ## Proposal: stage, then publish
 *
 * Submission records ONE operation and ONE job and returns QUEUED. The job freezes the open items into
 * `payment_proposal_stage`, prepares each (supplier block, payment method) in chunks, and then ONE
 * transaction replaces the run's proposal, moves the run to PROPOSAL and restarts its release
 * (`syncPaymentRunRelease`, restart:true). Until that transaction commits a reader sees the previous
 * proposal and the release that belongs to it; after it, the new proposal and a release at step one.
 * There is no moment with a new proposal and an old release, or the other way round.
 *
 * ## Execution: one transaction, exactly the foreground one
 *
 * Posting the payments and clearing the items stays all-or-nothing in ONE transaction: it is
 * `executePaymentRun` itself, not a second implementation. The job adds two hooks in that same
 * transaction: before anything is read, it fences the lease and re-judges the submitting user against the
 * CURRENT database; after everything is cleared, it records the operation SUCCEEDED. The payments and the
 * record that they were made therefore commit together or not at all, which is why a worker killed at any
 * point replays safely: either nothing happened, or the operation already says SUCCEEDED.
 *
 * The existing release requirement, supplier and bank checks, open-item revalidation and posting-period
 * checks all run inside that transaction, at the posting boundary. Nothing is auto-approved: execution is
 * queued only by a person, only after release, and the release is checked again when the job runs.
 *
 * ## What the generic job tables hold
 *
 * The queue carries the operation id only. Errors (which can name a supplier) are on the operation row and
 * shown on the payment-run screen; the job runner records a fixed generic sentence.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { assertActorCan, JobActorError, loadJobActor } from '../../platform/job/actor';
import { enqueue, requestCancel } from '../../platform/job/queue';
import { LeaseLostError, type ChunkResult, type JobContext } from '../../platform/job/types';
import { activePaymentOperation, bankAmountSignature, executePaymentRun, loadRun, openItems, PAYMENT_RUN_CAPABILITY, PaymentRunError, RUN_CLASS, runKey, supplierMethods, type PaymentRunView } from './payment-run';
import { assertPaymentRunReleased, syncPaymentRunRelease } from './payment-run-release';
import { bankAccount } from '../foundation/schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { paymentProposalItem, paymentRun } from './schema';
import { and, eq } from 'drizzle-orm';

export const PAYMENT_PROPOSAL_JOB = 'PAYMENT.RUN.PROPOSAL';
export const PAYMENT_EXECUTE_JOB = 'PAYMENT.RUN.EXECUTE';

export interface PaymentOperationView {
  operationId: string;
  runDate: string;
  runId: string;
  kind: 'PROPOSAL' | 'EXECUTE';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  itemsTotal: number;
  itemsDone: number;
  errorCode: string | null;
  errorText: string | null;
  jobStatus: string | null;
  createdAt: string;
  finishedAt: string | null;
  requestedBy: string;
}

type OpRow = {
  operation_id: string; run_date: string; run_id: string; kind: string; status: string; items_total: number; items_done: number;
  error_code: string | null; error_text: string | null; created_at: Date | string; finished_at: Date | string | null;
  requested_by: string; requested_by_user: string; job_run_id: string | null; house_bank_key: string | null; bank_account_id: string | null;
  bank_amounts: Array<{ companyCode: string; supplier: string; currency: string; amount: string }> | null;
  job_status?: string | null;
};
const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const dateOnly = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function viewOfRow(r: OpRow): PaymentOperationView {
  return {
    operationId: r.operation_id, runDate: dateOnly(r.run_date), runId: r.run_id,
    kind: r.kind as PaymentOperationView['kind'], status: r.status as PaymentOperationView['status'],
    itemsTotal: Number(r.items_total), itemsDone: Number(r.items_done),
    errorCode: r.error_code, errorText: r.error_text, jobStatus: r.job_status ?? null,
    createdAt: iso(r.created_at)!, finishedAt: iso(r.finished_at), requestedBy: r.requested_by,
  };
}

async function loadOp(tx: Tx, client: string, operationId: string, lock = false): Promise<OpRow | null> {
  const rows = (await tx.execute(lock
    ? sql`select o.*, j.status as job_status from payment_run_operation o left join job_run j on j.client = o.client and j.id = o.job_run_id
           where o.client = ${client} and o.operation_id = ${operationId} for update of o`
    : sql`select o.*, j.status as job_status from payment_run_operation o left join job_run j on j.client = o.client and j.id = o.job_run_id
           where o.client = ${client} and o.operation_id = ${operationId}`)) as unknown as OpRow[];
  return rows[0] ?? null;
}

const lockKey = (client: string, runDate: string, runId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/payrun/${runDate}/${runId}`}, 0))`;

/** Capability and company reach, as the submitting user stands NOW. Used at submission and again by the job. */
async function assertPaymentAuthority(tx: Tx, client: string, userId: string, run: PaymentRunView): Promise<{ id: string; username: string }> {
  const actor = await loadJobActor(tx, client, userId).catch(refuse);
  await assertActorCan(tx, client, actor, PAYMENT_RUN_CAPABILITY).catch(refuse);
  for (const company of run.companies) {
    await assertActorCan(tx, client, actor, PAYMENT_RUN_CAPABILITY, { companyCode: company.companyCode }).catch(refuse);
  }
  return actor;
}

function refuse(error: unknown): never {
  if (error instanceof JobActorError) throw new PaymentRunError(error.message, 'Ask an administrator for the payment run authority, then submit again.');
  throw error;
}

async function insertOperation(
  tx: Tx,
  input: {
    client: string; runDate: string; runId: string; kind: 'PROPOSAL' | 'EXECUTE';
    requestedBy: string; actorUserId: string; houseBankKey?: string; bankAccountId?: string;
    bankAmounts?: Array<{ companyCode: string; supplier: string; currency: string; amount: string }>;
  },
): Promise<PaymentOperationView> {
  const operationId = randomUUID();
  await tx.execute(sql`
    insert into payment_run_operation (client, operation_id, run_date, run_id, kind, status, request_key, requested_by, requested_by_user, house_bank_key, bank_account_id, bank_amounts)
    values (${input.client}, ${operationId}, ${input.runDate}, ${input.runId}, ${input.kind}, 'QUEUED', ${`pay-${operationId}`}, ${input.requestedBy}, ${input.actorUserId},
            ${input.houseBankKey ?? null}, ${input.bankAccountId ?? null},
            ${input.bankAmounts && input.bankAmounts.length > 0 ? JSON.stringify(input.bankAmounts) : null}::jsonb)
  `);
  // Only the operation id travels in the queue; the bank choice stays on the operation row.
  const job = await enqueue(tx, {
    client: input.client,
    jobCode: input.kind === 'PROPOSAL' ? PAYMENT_PROPOSAL_JOB : PAYMENT_EXECUTE_JOB,
    parameters: { operationId },
    triggeredBy: input.actorUserId,
    idempotencyKey: `payment-op:${operationId}`,
  });
  await tx.execute(sql`update payment_run_operation set job_run_id = ${job.id} where client = ${input.client} and operation_id = ${operationId}`);
  return viewOfRow((await loadOp(tx, input.client, operationId))!);
}

// ── Submission ──────────────────────────────────────────────────────────────

export interface SubmitProposalInput { client: string; changedBy: string; actorUserId: string; runDate: string; runId: string }

/** Queue a (re)generation of the proposal. A second click while one is queued or running returns that one. */
export async function submitPaymentProposal(input: SubmitProposalInput): Promise<PaymentOperationView> {
  return withTenant(input.client, async (tx) => {
    await tx.execute(lockKey(input.client, input.runDate, input.runId));
    const run = await loadRun(tx, input.client, input.runDate, input.runId);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} does not exist.`);
    if (run.status === 'EXECUTED') throw new PaymentRunError('An executed run is history; its proposal cannot be regenerated.');
    if (run.status === 'CANCELLED') throw new PaymentRunError('A cancelled run cannot propose payments.');
    const active = await activePaymentOperation(tx, input.client, input.runDate, input.runId);
    if (active) {
      if (active.kind === 'PROPOSAL') return viewOfRow((await loadOp(tx, input.client, active.operationId))!);
      throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} has a background execution in progress.`, 'Wait for it to finish.');
    }
    const actor = await assertPaymentAuthority(tx, input.client, input.actorUserId, run);
    return insertOperation(tx, { client: input.client, runDate: input.runDate, runId: input.runId, kind: 'PROPOSAL', requestedBy: input.changedBy, actorUserId: actor.id });
  });
}

export interface SubmitExecutionInput extends SubmitProposalInput {
  houseBankKey: string;
  bankAccountId: string;
  /** The complete actual bank-account-currency evidence, one entry per resulting group. */
  bankAmounts?: Array<{ companyCode: string; supplier: string; currency: string; amount: string }>;
}

/** Queue the execution of a proposal that stands RELEASED. Nothing is posted until the job commits. */
export async function submitPaymentExecution(input: SubmitExecutionInput): Promise<PaymentOperationView> {
  return withTenant(input.client, async (tx) => {
    await tx.execute(lockKey(input.client, input.runDate, input.runId));
    const run = await loadRun(tx, input.client, input.runDate, input.runId);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} does not exist.`);
    if (run.status === 'EXECUTED') throw new PaymentRunError('This run has already been executed; payments cannot be posted twice.');
    if (run.status !== 'PROPOSAL') throw new PaymentRunError('Create the proposal before executing.', 'Generate the proposal, review it, then execute.');
    if (run.proposal.filter((p) => !p.exceptionCode).length === 0) {
      throw new PaymentRunError('The proposal carries no payable items.', 'Resolve the exceptions or widen the selection.');
    }
    const houseBankKey = input.houseBankKey.trim().toUpperCase();
    const bankAccountId = input.bankAccountId.trim().toUpperCase();
    const active = await activePaymentOperation(tx, input.client, input.runDate, input.runId);
    if (active) {
      if (active.kind === 'EXECUTE') {
        const sameInstruction = active.houseBankKey === houseBankKey
          && active.bankAccountId === bankAccountId
          && bankAmountSignature(active.bankAmounts) === bankAmountSignature(input.bankAmounts);
        if (sameInstruction) return viewOfRow((await loadOp(tx, input.client, active.operationId))!);
        throw new PaymentRunError(
          `An execution is already queued for payment run ${runKey(input.runDate, input.runId)} with a different bank or actual-bank-amount instruction.`,
          'Cancel that execution or wait for it to finish. A different instruction is not a replay and is not accepted by the queued operation.',
        );
      }
      throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} has a background proposal in progress.`, 'Wait for it to finish.');
    }
    // Early, kind refusals. The job checks all of this again, at the posting boundary.
    await assertPaymentRunReleased(tx, input.client, input.runDate, input.runId).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'ReleaseError') throw new PaymentRunError(error.message, (error as { remedy?: string }).remedy);
      throw error;
    });
    const actor = await assertPaymentAuthority(tx, input.client, input.actorUserId, run);
    for (const company of new Set(run.proposal.filter((p) => !p.exceptionCode).map((p) => p.companyCode))) {
      const [bank] = await tx.select().from(bankAccount).where(and(
        eq(bankAccount.client, input.client), eq(bankAccount.companyCode, company),
        eq(bankAccount.houseBankKey, houseBankKey), eq(bankAccount.accountId, bankAccountId),
      ));
      if (!bank) {
        throw new PaymentRunError(
          `House bank ${houseBankKey} account ${bankAccountId} does not stand for company ${company}.`,
          'Choose a standing house-bank account for the paying company.',
        );
      }
    }
    return insertOperation(tx, {
      client: input.client, runDate: input.runDate, runId: input.runId, kind: 'EXECUTE',
      requestedBy: input.changedBy, actorUserId: actor.id, houseBankKey, bankAccountId,
      bankAmounts: input.bankAmounts,
    });
  });
}

/** Cancel a queued or running operation. A queued one is cancelled outright; a running proposal stops at its next chunk; an execution already inside its transaction finishes or rolls back whole. */
export async function cancelPaymentOperation(input: { client: string; operationId: string; changedBy: string; actorUserId: string }): Promise<PaymentOperationView> {
  return withTenant(input.client, async (tx) => {
    const op = await loadOp(tx, input.client, input.operationId, true);
    if (!op) throw new PaymentRunError(`Operation ${input.operationId} does not exist.`);
    const run = await loadRun(tx, input.client, dateOnly(op.run_date), op.run_id);
    if (run) await assertPaymentAuthority(tx, input.client, input.actorUserId, run);
    if (op.status !== 'QUEUED' && op.status !== 'RUNNING') throw new PaymentRunError(`The ${op.kind.toLowerCase()} is already ${op.status.toLowerCase()}.`);
    if (op.status === 'QUEUED') {
      await tx.execute(sql`
        update payment_run_operation set status = 'CANCELLED', error_code = 'CANCELLED',
               error_text = 'Cancelled before it started. Nothing was changed on the run.', finished_at = now(), changed_at = now()
         where client = ${input.client} and operation_id = ${op.operation_id}
      `);
    }
    if (op.job_run_id) await requestCancel(tx, input.client, op.job_run_id);
    return viewOfRow((await loadOp(tx, input.client, op.operation_id))!);
  });
}

export async function listPaymentOperations(client: string, runDate: string, runId: string, limit = 1): Promise<PaymentOperationView[]> {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select o.*, j.status as job_status from payment_run_operation o left join job_run j on j.client = o.client and j.id = o.job_run_id
       where o.client = ${client} and o.run_date = ${runDate} and o.run_id = ${runId} order by o.created_at desc limit ${limit}
    `)) as unknown as OpRow[];
    return rows.map(viewOfRow);
  });
}

export async function getPaymentOperation(client: string, operationId: string): Promise<PaymentOperationView | null> {
  return withTenant(client, async (tx) => {
    const op = await loadOp(tx, client, operationId);
    return op ? viewOfRow(op) : null;
  });
}

// ── The jobs ────────────────────────────────────────────────────────────────

/** What the job runner records: fixed words. The reason (which can name a supplier) is on the operation row. */
class PaymentJobError extends Error {
  constructor(operationId: string, code: string) {
    super(`Payment operation ${operationId} ended with ${code}. The reason is on the payment run screen.`);
    this.name = 'PaymentJobError';
  }
}

function operationIdOf(ctx: JobContext): string {
  const id = String(ctx.parameters.operationId ?? '');
  if (!id) throw new PaymentJobError('(none)', 'NO_OPERATION');
  return id;
}

async function failOperation(ctx: JobContext, operationId: string, code: string, message: string): Promise<void> {
  await withTenant(ctx.client, async (tx) => {
    await ctx.fence(tx);
    await tx.execute(sql`delete from payment_proposal_stage where client = ${ctx.client} and operation_id = ${operationId}`);
    await tx.execute(sql`
      update payment_run_operation set status = 'FAILED', error_code = ${code.slice(0, 40)}, error_text = ${message.slice(0, 400)}, finished_at = now(), changed_at = now()
       where client = ${ctx.client} and operation_id = ${operationId} and status in ('QUEUED', 'RUNNING')
    `);
  }).catch((error) => {
    if (error instanceof LeaseLostError) throw error;
    // The job-ended trigger records the failure anyway.
  });
}

function codeOf(error: unknown): string {
  if (error instanceof PaymentRunError) return 'PAYMENT_RUN';
  return (error as { code?: string } | null)?.code ?? 'ERROR';
}

/** One chunk of PAYMENT.RUN.PROPOSAL. Replay-safe: the stage rows and the operation status are the checkpoint. */
export async function runPaymentProposalChunk(ctx: JobContext): Promise<ChunkResult> {
  const operationId = operationIdOf(ctx);
  try {
    return await proposalChunk(ctx, operationId);
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof PaymentJobError) throw error;
    await failOperation(ctx, operationId, codeOf(error), error instanceof Error ? error.message : String(error));
    throw new PaymentJobError(operationId, codeOf(error));
  }
}

async function proposalChunk(ctx: JobContext, operationId: string): Promise<ChunkResult> {
  const client = ctx.client;

  const started = await withTenant(client, async (tx): Promise<ChunkResult | 'calc'> => {
    await ctx.fence(tx);
    const op = await loadOp(tx, client, operationId, true);
    if (!op || op.kind !== 'PROPOSAL') throw new PaymentRunError(`Operation ${operationId} is not a proposal.`);
    if (op.status === 'SUCCEEDED') return { cursor: null, processed: 0, progressText: 'Already completed.' };
    if (op.status === 'FAILED' || op.status === 'CANCELLED') {
      throw new PaymentRunError(`This proposal already ${op.status.toLowerCase()}${op.error_text ? `: ${op.error_text}` : ''}. A retry is not resumed.`, 'Create the proposal again from the payment run screen.');
    }
    const runDate = dateOnly(op.run_date);
    await tx.execute(lockKey(client, runDate, op.run_id));
    const run = await loadRun(tx, client, runDate, op.run_id);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(runDate, op.run_id)} does not exist.`);
    await assertPaymentAuthority(tx, client, op.requested_by_user, run);
    if (run.status === 'EXECUTED' || run.status === 'CANCELLED') throw new PaymentRunError(`The run stands ${run.status.toLowerCase()}; its proposal cannot be regenerated.`);
    if (op.status === 'RUNNING') return 'calc';

    // Freeze the population now: the open items as they stand, numbered once.
    const items = (await openItems(tx, client, run)).filter((item) => !(item.dueDate && item.dueDate > run.nextPaymentDate));
    for (let i = 0; i < items.length; i += 500) {
      const part = items.slice(i, i + 500);
      await tx.execute(sql`
        insert into payment_proposal_stage (client, operation_id, item_number, state, payload)
        values ${sql.join(part.map((item, index) => sql`(${client}, ${operationId}, ${i + index + 1}, 'PENDING', ${JSON.stringify(item)}::jsonb)`), sql`, `)}
        on conflict do nothing
      `);
    }
    await tx.execute(sql`
      update payment_run_operation set status = 'RUNNING', started_at = now(), changed_at = now(), items_total = ${items.length}
       where client = ${client} and operation_id = ${operationId}
    `);
    return 'calc';
  });
  if (started !== 'calc') return started;

  // ── prepare: supplier block and payment method, one transaction per chunk ──
  const chunk = await withTenant(client, async (tx) => {
    await ctx.fence(tx);
    const op = (await loadOp(tx, client, operationId, true))!;
    if (op.status !== 'RUNNING') throw new PaymentRunError(`This ${op.kind.toLowerCase()} is ${op.status.toLowerCase()}.`);
    const runDate = dateOnly(op.run_date);
    const run = await loadRun(tx, client, runDate, op.run_id);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(runDate, op.run_id)} does not exist.`);
    await assertPaymentAuthority(tx, client, op.requested_by_user, run);
    const pending = (await tx.execute(sql`
      select item_number, payload from payment_proposal_stage
       where client = ${client} and operation_id = ${operationId} and state = 'PENDING' order by item_number limit ${ctx.chunkSize}
    `)) as unknown as Array<{ item_number: number; payload: Record<string, unknown> }>;
    for (const row of pending) {
      const item = row.payload as { companyCode: string; accountId: string; dueDate: string | null };
      const [supplier] = await tx.select().from(supplierCompany).where(and(
        eq(supplierCompany.client, client), eq(supplierCompany.partnerNumber, item.accountId), eq(supplierCompany.companyCode, item.companyCode),
      ));
      let exceptionCode: string | null = null;
      let exceptionText: string | null = null;
      let method: string | null = null;
      if (supplier?.isBlocked) {
        exceptionCode = 'SUPPLIER_BLOCKED';
        exceptionText = `Supplier ${item.accountId} is blocked for company ${item.companyCode}.`;
      } else {
        const allowed = supplierMethods(supplier?.paymentMethods ?? null);
        method = run.methods.find((m) => allowed.length === 0 || allowed.includes(m)) ?? null;
        if (!method) {
          exceptionCode = 'NO_PAYMENT_METHOD';
          exceptionText = `None of the run's methods stands for supplier ${item.accountId}.`;
        }
      }
      await tx.execute(sql`
        update payment_proposal_stage
           set state = 'READY', payload = ${JSON.stringify({ ...row.payload, method, exceptionCode, exceptionText })}::jsonb
         where client = ${client} and operation_id = ${operationId} and item_number = ${row.item_number}
      `);
    }
    const left = (await tx.execute(sql`
      select count(*) filter (where state = 'PENDING')::int as pending, count(*) filter (where state = 'READY')::int as done
        from payment_proposal_stage where client = ${client} and operation_id = ${operationId}
    `)) as unknown as Array<{ pending: number; done: number }>;
    await tx.execute(sql`update payment_run_operation set items_done = ${Number(left[0]!.done)}, changed_at = now() where client = ${client} and operation_id = ${operationId}`);
    return { pending: Number(left[0]!.pending), done: Number(left[0]!.done), processed: pending.length };
  });
  if (chunk.pending > 0) {
    return { cursor: { phase: 'prepare' }, processed: chunk.processed, progressText: `Prepared ${chunk.done} items so far.` };
  }

  // ── publish: ONE transaction replaces the proposal, moves the run to PROPOSAL, and restarts its release ──
  const items = await withTenant(client, async (tx) => {
    await ctx.fence(tx);
    const op = (await loadOp(tx, client, operationId, true))!;
    if (op.status === 'SUCCEEDED') return Number(op.items_total);
    if (op.status !== 'RUNNING') throw new PaymentRunError(`This ${op.kind.toLowerCase()} is ${op.status.toLowerCase()}.`);
    const runDate = dateOnly(op.run_date);
    await tx.execute(lockKey(client, runDate, op.run_id));
    const run = await loadRun(tx, client, runDate, op.run_id);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(runDate, op.run_id)} does not exist.`);
    const actor = await assertPaymentAuthority(tx, client, op.requested_by_user, run);
    if (run.status === 'EXECUTED' || run.status === 'CANCELLED') throw new PaymentRunError(`The run stands ${run.status.toLowerCase()}; its proposal cannot be replaced.`);
    const staged = (await tx.execute(sql`
      select item_number, state, payload from payment_proposal_stage where client = ${client} and operation_id = ${operationId} order by item_number
    `)) as unknown as Array<{ item_number: number; state: string; payload: Record<string, unknown> }>;
    if (staged.some((s) => s.state !== 'READY')) throw new PaymentRunError('The proposal is not finished; nothing was published.');

    await tx.delete(paymentProposalItem).where(and(
      eq(paymentProposalItem.client, client), eq(paymentProposalItem.runDate, runDate), eq(paymentProposalItem.runId, op.run_id),
    ));
    for (const s of staged) {
      const p = s.payload as {
        companyCode: string; accountId: string; journalDocumentNumber: string; journalFiscalYear: number; journalLineNumber: number;
        invoiceNumber: string | null; currency: string; amount: number; dueDate: string | null;
        method: string | null; exceptionCode: string | null; exceptionText: string | null;
      };
      await tx.insert(paymentProposalItem).values({
        client, runDate, runId: op.run_id, itemNumber: s.item_number,
        companyCode: p.companyCode,
        payingCompanyCode: run.companies.find((c) => c.companyCode === p.companyCode)?.payingCompanyCode ?? p.companyCode,
        accountType: 'K', accountId: p.accountId,
        journalDocumentNumber: p.journalDocumentNumber, journalFiscalYear: p.journalFiscalYear, journalLineNumber: p.journalLineNumber,
        invoiceNumber: p.invoiceNumber, currency: p.currency, amount: String(p.amount), dueDate: p.dueDate,
        paymentMethod: p.method, exceptionCode: p.exceptionCode, exceptionText: p.exceptionText, createdBy: actor.username,
      });
    }
    await tx.update(paymentRun).set({ status: 'PROPOSAL', changedBy: actor.username, changedAt: new Date() })
      .where(and(eq(paymentRun.client, client), eq(paymentRun.runDate, runDate), eq(paymentRun.runId, op.run_id)));
    await recordChange(tx, {
      client, objectClass: RUN_CLASS, objectKey: runKey(runDate, op.run_id), changeType: 'CHANGE',
      changedBy: actor.username, transactionCode: PAYMENT_RUN_CAPABILITY, after: { status: 'PROPOSAL', items: staged.length, operation: operationId },
    });
    const proposed = (await loadRun(tx, client, runDate, op.run_id))!;
    // In the same transaction as the new proposal: the old release is invalidated and the run restarts at step one.
    await syncPaymentRunRelease(tx, client, proposed, actor.username);
    await tx.execute(sql`delete from payment_proposal_stage where client = ${client} and operation_id = ${operationId}`);
    await tx.execute(sql`
      update payment_run_operation set status = 'SUCCEEDED', items_done = ${staged.length}, finished_at = now(), changed_at = now()
       where client = ${client} and operation_id = ${operationId}
    `);
    return staged.length;
  });
  return { cursor: null, processed: items, progressText: `Published a proposal of ${items} items.` };
}

/** PAYMENT.RUN.EXECUTE: the foreground execution, as the submitting user, with the operation recorded in its own transaction. */
export async function runPaymentExecuteChunk(ctx: JobContext): Promise<ChunkResult> {
  const operationId = operationIdOf(ctx);
  const client = ctx.client;
  try {
    const op = await withTenant(client, async (tx) => {
      await ctx.fence(tx);
      const found = await loadOp(tx, client, operationId, true);
      if (!found || found.kind !== 'EXECUTE') throw new PaymentRunError(`Operation ${operationId} is not an execution.`);
      if (found.status === 'FAILED' || found.status === 'CANCELLED') {
        throw new PaymentRunError(`This execution already ${found.status.toLowerCase()}${found.error_text ? `: ${found.error_text}` : ''}. A retry is not resumed.`, 'Execute the run again from the payment run screen.');
      }
      if (found.status === 'QUEUED') {
        await tx.execute(sql`update payment_run_operation set status = 'RUNNING', started_at = now(), changed_at = now() where client = ${client} and operation_id = ${operationId}`);
      }
      return found;
    });
    if (op.status === 'SUCCEEDED') return { cursor: null, processed: 0, progressText: 'Already executed.' };

    const runDate = dateOnly(op.run_date);
    let actorName = op.requested_by;
    await executePaymentRun({
      client, changedBy: op.requested_by, runDate, runId: op.run_id,
      houseBankKey: String(op.house_bank_key), bankAccountId: String(op.bank_account_id),
      bankAmounts: op.bank_amounts ?? undefined,
      exceptOperationId: operationId,
      beforeExecute: async (tx) => {
        await ctx.fence(tx);
        const current = await loadOp(tx, client, operationId, true);
        if (!current || current.status === 'SUCCEEDED') throw new PaymentRunError('This execution already completed; nothing is posted again.');
        if (current.status !== 'RUNNING') throw new PaymentRunError(`This execution is ${current.status.toLowerCase()}.`);
        const run = await loadRun(tx, client, runDate, op.run_id);
        if (run) actorName = (await assertPaymentAuthority(tx, client, op.requested_by_user, run)).username;
      },
      afterExecute: async (tx) => {
        await tx.execute(sql`
          update payment_run_operation set status = 'SUCCEEDED', items_done = items_total, finished_at = now(), changed_at = now()
           where client = ${client} and operation_id = ${operationId} and status = 'RUNNING'
        `);
      },
    });
    void actorName;
    return { cursor: null, processed: 1, progressText: 'Payments posted.' };
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof PaymentJobError) throw error;
    // The execution is one transaction, so a refusal or any error before COMMIT posted nothing. An error
    // AFTER commit (the connection dropped on the acknowledgement) is the one case that is not what it
    // seems, so the run is read back before the operation is called failed.
    const executed = await withTenant(client, async (tx) => {
      await ctx.fence(tx);
      const found = await loadOp(tx, client, operationId, true);
      if (found?.status === 'SUCCEEDED') return true;
      const run = found ? await loadRun(tx, client, dateOnly(found.run_date), found.run_id) : null;
      if (found && run?.status === 'EXECUTED') {
        await tx.execute(sql`update payment_run_operation set status = 'SUCCEEDED', finished_at = now(), changed_at = now() where client = ${client} and operation_id = ${operationId} and status in ('QUEUED', 'RUNNING')`);
        return true;
      }
      return false;
    });
    if (executed) return { cursor: null, processed: 1, progressText: 'Payments posted.' };
    await failOperation(ctx, operationId, codeOf(error), `${error instanceof Error ? error.message : String(error)} Nothing was posted.`);
    throw new PaymentJobError(operationId, codeOf(error));
  }
}

export type { PaymentRunView };

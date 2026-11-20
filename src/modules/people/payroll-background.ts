/**
 * Background payroll: proposal, recalculation, and the separately requested posting of a released run.
 *
 * ## What is queued, and what is not
 *
 * Submission checks the signed-in user's authority and Company Code scope (the same judgement the
 * foreground services make), then records ONE operation row and ONE job in the same transaction and
 * returns QUEUED. No employee is selected and nothing is calculated in the request. The job carries only
 * the operation id: no company, period, employee, amount, session or credential.
 *
 * Release stays an explicit human action, and so does paying salaries (`paySalaryRun` is untouched). A
 * calculation never releases and never posts; a posting job posts exactly the run a person asked to post.
 *
 * ## Calculation: stage, then publish
 *
 *  1. INIT    freeze the employee population and the off-cycle coverage into `payroll_calc_stage`.
 *  2. CALC    in chunks, one transaction per chunk: calculate each employee (or record the named
 *             exception) into the stage. The run's real results are not touched, so a reader, or a
 *             failed or cancelled operation, always sees the previous valid proposal.
 *  3. PUBLISH ONE transaction under the period lock replaces the run's results and exceptions from the
 *             stage, updates the counts, writes the change document as the original actor, and marks
 *             the operation SUCCEEDED. The coverage trigger and the released-result protection still
 *             apply to every insert and delete.
 *
 * The stage rows and the operation status are the checkpoint, committed atomically with the work, so a
 * worker killed anywhere replays safely: a chunk that did not commit is simply repeated; one that did is
 * not (its stage rows are no longer PENDING); a publish that committed is recognised (operation
 * SUCCEEDED) and not repeated.
 *
 * ## Authority
 *
 * The job acts as the user who submitted it, never as a session. Every chunk, and the publish, re-judges
 * that user against the CURRENT database (active, unlocked, holds the capability, Company Code scope) with
 * the job's own lease as the credential (`ServiceAuthorityContext.jobLease`). A revoked, deactivated or
 * out-of-scope user fails closed; the operation says why on the payroll screen. The capability-array
 * shortcut of `PayrollAccess` is never used here.
 *
 * ## What the generic job tables may not hold
 *
 * Errors are written in full to the operation (a payroll table, read through the payroll screen). What
 * the job runner records and the job monitor shows is a fixed generic sentence plus counts.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { enqueue, requestCancel } from '../../platform/job/queue';
import { LeaseLostError, type ChunkResult, type JobContext } from '../../platform/job/types';
import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import {
  EXECUTE,
  PAYROLL_RUN_CAPABILITY,
  PAYROLL_RUN_ROUTE,
  PayrollRunError,
  activeOperation,
  assertCalculationSettled,
  assertPeriodOpen,
  assertProposed,
  coverageOf,
  daysBetween,
  judge,
  loadRun,
  lockPeriod,
  parse,
  proposeInput,
  refuse,
  runRowFrom,
  selectEmployees,
  computeResultDraft,
  translateTrigger,
  type ResultDraft,
} from './payroll-run';
import { type PayrollAccess, assertCompanyScope } from './payroll-access';
import { PAYROLL_POST_CAPABILITY, PayrollPostingError, postPayrollRun } from './payroll-posting';
import { validateEmployeeForRun } from './payroll-structure';
import { PAYROLL_RUN_OBJECT_CLASS, payrollResult, payrollResultLine, payrollRun, payrollRunException } from './schema';

export const PAYROLL_CALC_JOB = 'PAYROLL.RUN.CALC';
export const PAYROLL_POST_JOB = 'PAYROLL.RUN.POST';

export interface PayrollOperationView {
  operationId: string;
  runId: string;
  kind: 'PROPOSE' | 'RECALCULATE' | 'POST';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  employeesTotal: number;
  employeesDone: number;
  errorCode: string | null;
  errorText: string | null;
  /** The job's own state, for a person who can see the monitor to cross-check; never data. */
  jobStatus: string | null;
  jobId: string | null;
  createdAt: string;
  finishedAt: string | null;
  requestedBy: string;
}

type OpRow = {
  operation_id: string; run_id: string; kind: string; status: string; employees_total: number; employees_done: number;
  error_code: string | null; error_text: string | null; created_at: Date | string; finished_at: Date | string | null;
  requested_by: string; requested_by_user: string; job_run_id: string | null; request_key: string; job_status?: string | null;
};

const iso = (v: Date | string | null): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

function viewOfRow(r: OpRow): PayrollOperationView {
  return {
    operationId: r.operation_id,
    runId: r.run_id,
    kind: r.kind as PayrollOperationView['kind'],
    status: r.status as PayrollOperationView['status'],
    employeesTotal: Number(r.employees_total),
    employeesDone: Number(r.employees_done),
    errorCode: r.error_code,
    errorText: r.error_text,
    jobStatus: r.job_status ?? null,
    jobId: r.job_run_id,
    createdAt: iso(r.created_at)!,
    finishedAt: iso(r.finished_at),
    requestedBy: r.requested_by,
  };
}

async function loadOp(tx: Tx, client: string, operationId: string, lock = false): Promise<OpRow | null> {
  const rows = (await tx.execute(lock
    ? sql`select o.*, j.status as job_status from payroll_run_operation o left join job_run j on j.client = o.client and j.id = o.job_run_id
           where o.client = ${client} and o.operation_id = ${operationId} for update of o`
    : sql`select o.*, j.status as job_status from payroll_run_operation o left join job_run j on j.client = o.client and j.id = o.job_run_id
           where o.client = ${client} and o.operation_id = ${operationId}`)) as unknown as OpRow[];
  return rows[0] ?? null;
}

async function insertOperation(
  tx: Tx,
  input: { client: string; runId: string; kind: 'PROPOSE' | 'RECALCULATE' | 'POST'; requestKey: string; requestedBy: string; actorUserId: string; jobCode: string },
): Promise<PayrollOperationView> {
  const operationId = randomUUID();
  await tx.execute(sql`
    insert into payroll_run_operation (client, operation_id, run_id, kind, status, request_key, requested_by, requested_by_user)
    values (${input.client}, ${operationId}, ${input.runId}, ${input.kind}, 'QUEUED', ${input.requestKey}, ${input.requestedBy}, ${input.actorUserId})
  `);
  // Only the operation id travels in the queue. triggered_by is the durable user the job acts for.
  const job = await enqueue(tx, {
    client: input.client,
    jobCode: input.jobCode,
    parameters: { operationId },
    triggeredBy: input.actorUserId,
    idempotencyKey: `payroll-op:${operationId}`,
  });
  await tx.execute(sql`
    update payroll_run_operation set job_run_id = ${job.id} where client = ${input.client} and operation_id = ${operationId}
  `);
  return viewOfRow((await loadOp(tx, input.client, operationId))!);
}

// ── Submission ──────────────────────────────────────────────────────────────

export interface SubmitProposalInput {
  client: string;
  changedBy: string;
  /** The durable id of the submitting user. */
  actorUserId: string;
  companyCode: string;
  fiscalYear: number | string;
  period: number | string;
  requestKey?: string;
}

/** Queue a proposal: creates the PROPOSED run (not yet calculated) and its operation, and returns QUEUED. */
export async function submitPayrollProposal(input: SubmitProposalInput, access: PayrollAccess): Promise<PayrollOperationView> {
  const parsed = parse(proposeInput, { ...input });
  return withTenant(parsed.client, async (tx) => {
    const grant = await judge(tx, parsed.client, access, EXECUTE);
    assertCompanyScope(grant, parsed.companyCode, refuse);
    const requestKey = parsed.requestKey || `propose-${randomUUID()}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-op-submit:${parsed.client}:${requestKey}`}, 0))`);
    const replay = (await tx.execute(sql`
      select o.*, j.status as job_status, r.company_code, r.fiscal_year, r.period
        from payroll_run_operation o
        join payroll_run r on r.client = o.client and r.run_id = o.run_id
        left join job_run j on j.client = o.client and j.id = o.job_run_id
       where o.client = ${parsed.client} and o.request_key = ${requestKey}
    `)) as unknown as Array<OpRow & { company_code: string; fiscal_year: number; period: number }>;
    if (replay[0]) {
      if (replay[0].company_code !== parsed.companyCode || replay[0].fiscal_year !== parsed.fiscalYear || replay[0].period !== parsed.period) {
        refuse('REQUEST_REUSED', 'This request already proposed a different company or period.', 'Use a new request. A retry cannot change the scope.');
      }
      return viewOfRow(replay[0]);
    }
    await lockPeriod(tx, parsed.client, parsed.companyCode, parsed.fiscalYear, parsed.period);
    const { company, dates } = await assertPeriodOpen(tx, parsed.client, parsed.companyCode, parsed.fiscalYear, parsed.period);
    const runId = randomUUID();
    await tx.insert(payrollRun).values({
      client: parsed.client, runId, companyCode: parsed.companyCode, fiscalYear: parsed.fiscalYear, period: parsed.period,
      periodFrom: dates.from, periodTo: dates.to, totalDays: daysBetween(dates.from, dates.to),
      currency: String(company.currency).trim(), status: 'PROPOSED', calculatedBy: parsed.changedBy,
      requestKey: requestKey.slice(0, 64), createdBy: parsed.changedBy,
    });
    const op = await insertOperation(tx, {
      client: parsed.client, runId, kind: 'PROPOSE', requestKey, requestedBy: parsed.changedBy,
      actorUserId: input.actorUserId, jobCode: PAYROLL_CALC_JOB,
    });
    await recordChange(tx, {
      client: parsed.client, objectClass: PAYROLL_RUN_OBJECT_CLASS, objectKey: runId, changeType: 'CREATE',
      changedBy: parsed.changedBy, transactionCode: PAYROLL_RUN_CAPABILITY,
      after: { companyCode: parsed.companyCode, fiscalYear: parsed.fiscalYear, period: parsed.period, calculation: 'QUEUED' },
    });
    return op;
  });
}

export interface SubmitRunActionInput {
  client: string;
  changedBy: string;
  actorUserId: string;
  runId: string;
}

/** Queue a recalculation of a PROPOSED run. A second click while one is queued or running returns that one. */
export async function submitPayrollRecalculation(input: SubmitRunActionInput, access: PayrollAccess): Promise<PayrollOperationView> {
  return withTenant(input.client, async (tx) => {
    const grant = await judge(tx, input.client, access, EXECUTE);
    const standing = await loadRun(tx, input.client, input.runId);
    assertCompanyScope(grant, standing.companyCode, refuse);
    await lockPeriod(tx, input.client, standing.companyCode, standing.fiscalYear, standing.period);
    const row = await loadRun(tx, input.client, input.runId);
    assertProposed(row, 'recalculated');
    const active = await activeOperation(tx, input.client, row.runId);
    if (active) {
      if (active.kind === 'RECALCULATE' || active.kind === 'PROPOSE') return viewOfRow((await loadOp(tx, input.client, active.operationId))!);
      refuse('OPERATION_ACTIVE', `Run ${row.runId} has a background ${active.kind.toLowerCase()} in progress.`, 'Wait for it to finish.');
    }
    await assertPeriodOpen(tx, input.client, row.companyCode, row.fiscalYear, row.period);
    return insertOperation(tx, {
      client: input.client, runId: row.runId, kind: 'RECALCULATE', requestKey: `recalc-${row.runId}-${randomUUID()}`,
      requestedBy: input.changedBy, actorUserId: input.actorUserId, jobCode: PAYROLL_CALC_JOB,
    });
  });
}

export interface SubmitPostingInput extends SubmitRunActionInput {
  authorization: ServiceAuthorityContext;
}

/** Queue the posting of a RELEASED run. The run is posted once, as one journal, by the job. */
export async function submitPayrollPosting(input: SubmitPostingInput): Promise<PayrollOperationView> {
  return withTenant(input.client, async (tx) => {
    for (const capability of [PAYROLL_POST_CAPABILITY, 'FIN.JOURNAL.POST']) {
      const verdict = await verifyServiceAuthorityInTx(tx, input.client, input.authorization, capability, { requirePlantScope: false });
      if (!verdict.ok) {
        refuse('PAYROLL_AUTHORITY', verdict.refusal.message.startsWith('You do not hold the authority')
          ? `You do not hold the authority to post payroll (${capability}).`
          : verdict.refusal.message, verdict.refusal.remedy);
      }
      if (capability === PAYROLL_POST_CAPABILITY) {
        const standing = await loadRun(tx, input.client, input.runId);
        assertCompanyScope({ restrictions: verdict.restrictions }, standing.companyCode, refuse);
      }
    }
    const standing = await loadRun(tx, input.client, input.runId);
    await lockPeriod(tx, input.client, standing.companyCode, standing.fiscalYear, standing.period);
    const row = await loadRun(tx, input.client, input.runId);
    if (row.documentNumber || row.status === 'POSTED') {
      refuse('RUN_POSTED', `Payroll run ${row.runId} is already posted as document ${row.documentNumber}.`, 'A run is posted once.');
    }
    if (row.status !== 'RELEASED') {
      refuse('RUN_NOT_RELEASED', `This run has not been released (run ${row.runId} is ${row.status}).`, `Review and release it at ${PAYROLL_RUN_ROUTE}?run=${row.runId}, then post.`);
    }
    const active = await activeOperation(tx, input.client, row.runId);
    if (active) {
      if (active.kind === 'POST') return viewOfRow((await loadOp(tx, input.client, active.operationId))!);
      refuse('OPERATION_ACTIVE', `Run ${row.runId} has a background ${active.kind.toLowerCase()} in progress.`, 'Wait for it to finish.');
    }
    await assertCalculationSettled(tx, input.client, row.runId);
    return insertOperation(tx, {
      client: input.client, runId: row.runId, kind: 'POST', requestKey: `post-${row.runId}-${randomUUID()}`,
      requestedBy: input.changedBy, actorUserId: input.actorUserId, jobCode: PAYROLL_POST_JOB,
    });
  });
}

/**
 * Cancel a queued or running operation from the payroll screen. A queued one is cancelled outright. A
 * running calculation stops at its next chunk boundary and leaves the previous proposal untouched; a
 * posting that has already started is one atomic transaction and finishes or rolls back whole.
 */
export async function cancelPayrollOperation(
  input: { client: string; operationId: string; changedBy: string },
  access: PayrollAccess,
): Promise<PayrollOperationView> {
  return withTenant(input.client, async (tx) => {
    const grant = await judge(tx, input.client, access, EXECUTE);
    const op = await loadOp(tx, input.client, input.operationId, true);
    if (!op) refuse('OPERATION_UNKNOWN', `Operation ${input.operationId} does not exist.`);
    const run = await loadRun(tx, input.client, op.run_id);
    assertCompanyScope(grant, run.companyCode, refuse);
    if (op.status !== 'QUEUED' && op.status !== 'RUNNING') {
      refuse('OPERATION_FINISHED', `The ${op.kind.toLowerCase()} is already ${op.status.toLowerCase()}.`);
    }
    if (op.status === 'QUEUED') {
      await tx.execute(sql`
        update payroll_run_operation set status = 'CANCELLED', error_code = 'CANCELLED', error_text = 'Cancelled before it started. Nothing was changed on the run.',
               finished_at = now(), changed_at = now()
         where client = ${input.client} and operation_id = ${op.operation_id}
      `);
    }
    if (op.job_run_id) await requestCancel(tx, input.client, op.job_run_id);
    return viewOfRow((await loadOp(tx, input.client, op.operation_id))!);
  });
}

/** The operations of one run, newest first, for the payroll screen. Judged like reading the run. */
export async function listPayrollOperations(client: string, runId: string, access: PayrollAccess, limit = 5): Promise<PayrollOperationView[]> {
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, [PAYROLL_RUN_CAPABILITY]);
    const run = await loadRun(tx, client, runId);
    assertCompanyScope(grant, run.companyCode, refuse);
    const rows = (await tx.execute(sql`
      select o.*, j.status as job_status
        from payroll_run_operation o left join job_run j on j.client = o.client and j.id = o.job_run_id
       where o.client = ${client} and o.run_id = ${runId}
       order by o.created_at desc limit ${limit}
    `)) as unknown as OpRow[];
    return rows.map(viewOfRow);
  });
}

/** One operation, for polling. */
export async function getPayrollOperation(client: string, operationId: string, access: PayrollAccess): Promise<PayrollOperationView | null> {
  return withTenant(client, async (tx) => {
    const grant = await judge(tx, client, access, [PAYROLL_RUN_CAPABILITY]);
    const op = await loadOp(tx, client, operationId);
    if (!op) return null;
    const run = await loadRun(tx, client, op.run_id);
    assertCompanyScope(grant, run.companyCode, refuse);
    return viewOfRow(op);
  });
}

// ── The jobs ────────────────────────────────────────────────────────────────

/**
 * What the job runner records. Fixed words: the real reason, which can name an employee, is on the
 * operation row.
 */
class PayrollJobError extends Error {
  constructor(operationId: string, code: string) {
    super(`Payroll operation ${operationId} ended with ${code}. The reason is on the payroll run screen.`);
    this.name = 'PayrollJobError';
  }
}

function authorityOf(ctx: JobContext, op: OpRow): { authorization: ServiceAuthorityContext } {
  return { authorization: { userId: op.requested_by_user, sessionId: '', jobLease: { runId: ctx.runId, epoch: ctx.epoch } } };
}

async function failOperation(ctx: JobContext, operationId: string, code: string, message: string): Promise<void> {
  await withTenant(ctx.client, async (tx) => {
    await ctx.fence(tx);
    await tx.execute(sql`delete from payroll_calc_stage where client = ${ctx.client} and operation_id = ${operationId}`);
    await tx.execute(sql`
      update payroll_run_operation
         set status = 'FAILED', error_code = ${code.slice(0, 32)}, error_text = ${message.slice(0, 400)}, finished_at = now(), changed_at = now()
       where client = ${ctx.client} and operation_id = ${operationId} and status in ('QUEUED', 'RUNNING')
    `);
  }).catch((error) => {
    if (error instanceof LeaseLostError) throw error;
    // The job-ended trigger records the failure anyway.
  });
}

function operationIdOf(ctx: JobContext): string {
  const id = String(ctx.parameters.operationId ?? '');
  if (!id) throw new PayrollJobError('(none)', 'NO_OPERATION');
  return id;
}

const DONE: ChunkResult = { cursor: null, processed: 0 };

/** One chunk of PAYROLL.RUN.CALC. Replay-safe: see the module comment. */
export async function runPayrollCalcChunk(ctx: JobContext): Promise<ChunkResult> {
  const operationId = operationIdOf(ctx);
  try {
    return await calcChunk(ctx, operationId);
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof PayrollJobError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string } | null)?.code ?? 'ERROR';
    await failOperation(ctx, operationId, code, message);
    throw new PayrollJobError(operationId, code);
  }
}

async function calcChunk(ctx: JobContext, operationId: string): Promise<ChunkResult> {
  const client = ctx.client;

  // ── INIT (and the replay / refusal checks) ──
  const started = await withTenant(client, async (tx): Promise<ChunkResult | 'calc'> => {
    await ctx.fence(tx);
    const op = await loadOp(tx, client, operationId, true);
    if (!op || (op.kind !== 'PROPOSE' && op.kind !== 'RECALCULATE')) refuse('OPERATION_UNKNOWN', `Operation ${operationId} is not a calculation.`);
    if (op.status === 'SUCCEEDED') return { cursor: null, processed: 0, progressText: 'Already completed.' };
    if (op.status === 'FAILED' || op.status === 'CANCELLED') {
      refuse('OPERATION_ENDED', `This ${op.kind.toLowerCase()} already ${op.status.toLowerCase()}${op.error_text ? `: ${op.error_text}` : ''}. A retry is not resumed.`, `Recalculate the run at ${PAYROLL_RUN_ROUTE}?run=${op.run_id} to start a new calculation.`);
    }
    const access = authorityOf(ctx, op);
    const grant = await judge(tx, client, access, EXECUTE);
    const standing = await loadRun(tx, client, op.run_id);
    assertCompanyScope(grant, standing.companyCode, refuse);
    if (op.status === 'RUNNING') return 'calc';

    await lockPeriod(tx, client, standing.companyCode, standing.fiscalYear, standing.period);
    const row = await loadRun(tx, client, op.run_id);
    assertProposed(row, 'recalculated');
    await assertPeriodOpen(tx, client, row.companyCode, row.fiscalYear, row.period);
    const run = runRowFrom(row);
    // Freeze the population and the coverage now. Chunks calculate THIS list, and publish replaces the
    // results with exactly this list, so an employee who joins mid-calculation is caught by release.
    const selected = await selectEmployees(tx, client, run);
    const covered = await coverageOf(tx, client, run, run.runId);
    for (let i = 0; i < selected.length; i += 500) {
      const part = selected.slice(i, i + 500);
      await tx.execute(sql`
        insert into payroll_calc_stage (client, operation_id, personnel_number, outcome, covered_by)
        values ${sql.join(part.map((pn) => sql`(${client}, ${operationId}, ${pn}, ${covered.has(pn) ? 'COVERED' : 'PENDING'}, ${covered.get(pn) ?? null})`), sql`, `)}
        on conflict do nothing
      `);
    }
    await tx.execute(sql`
      update payroll_run_operation
         set status = 'RUNNING', started_at = now(), changed_at = now(),
             employees_total = ${selected.filter((pn) => !covered.has(pn)).length}
       where client = ${client} and operation_id = ${operationId}
    `);
    return 'calc';
  });
  if (started !== 'calc') return started;

  // ── CALC: one transaction per chunk; the stage rows are the checkpoint ──
  const chunk = await withTenant(client, async (tx) => {
    await ctx.fence(tx);
    const op = (await loadOp(tx, client, operationId, true))!;
    if (op.status !== 'RUNNING') refuse('OPERATION_ENDED', `This ${op.kind.toLowerCase()} is ${op.status.toLowerCase()}.`);
    const grant = await judge(tx, client, authorityOf(ctx, op), EXECUTE);
    const row = await loadRun(tx, client, op.run_id);
    assertCompanyScope(grant, row.companyCode, refuse);
    assertProposed(row, 'recalculated');
    const run = runRowFrom(row);
    const pending = (await tx.execute(sql`
      select personnel_number from payroll_calc_stage
       where client = ${client} and operation_id = ${operationId} and outcome = 'PENDING'
       order by personnel_number limit ${ctx.chunkSize}
    `)) as unknown as Array<{ personnel_number: string }>;
    for (const { personnel_number: pn } of pending) {
      const readiness = await validateEmployeeForRun(tx, client, pn, run.periodFrom, run.periodTo);
      let reasons: Array<{ code: string; message: string; remedy?: string }> = readiness.reasons;
      let draft: ResultDraft | null = null;
      if (readiness.ready) {
        try {
          draft = await tx.transaction((inner) => computeResultDraft(inner, client, run, { personnelNumber: pn }, op.requested_by));
        } catch (error) {
          if (!(error instanceof PayrollRunError)) throw error;
          reasons = [{ code: error.code, message: error.message, remedy: error.remedy }];
        }
      }
      await tx.execute(draft
        ? sql`update payroll_calc_stage set outcome = 'RESULT', payload = ${JSON.stringify({ result: draft.result, lines: draft.lines })}::jsonb
               where client = ${client} and operation_id = ${operationId} and personnel_number = ${pn}`
        : sql`update payroll_calc_stage set outcome = 'EXCEPTION', payload = ${JSON.stringify({ reasons })}::jsonb
               where client = ${client} and operation_id = ${operationId} and personnel_number = ${pn}`);
    }
    const left = (await tx.execute(sql`
      select count(*) filter (where outcome = 'PENDING')::int as pending, count(*) filter (where outcome in ('RESULT', 'EXCEPTION'))::int as done
        from payroll_calc_stage where client = ${client} and operation_id = ${operationId}
    `)) as unknown as Array<{ pending: number; done: number }>;
    await tx.execute(sql`
      update payroll_run_operation set employees_done = ${Number(left[0]!.done)}, changed_at = now()
       where client = ${client} and operation_id = ${operationId}
    `);
    return { pending: Number(left[0]!.pending), done: Number(left[0]!.done), processed: pending.length };
  });
  if (chunk.pending > 0) {
    return {
      cursor: { phase: 'calc' },
      processed: chunk.processed,
      // Counts only. The total is frozen at the start, so the progress is real.
      progressText: `Calculated ${chunk.done} employees so far.`,
    };
  }

  // ── PUBLISH: one transaction replaces the run's results from the stage ──
  const published = await withTenant(client, async (tx) => {
    await ctx.fence(tx);
    const op = (await loadOp(tx, client, operationId, true))!;
    if (op.status === 'SUCCEEDED') return { employees: op.employees_done, exceptions: 0, allCovered: false };
    if (op.status !== 'RUNNING') refuse('OPERATION_ENDED', `This ${op.kind.toLowerCase()} is ${op.status.toLowerCase()}.`);
    const grant = await judge(tx, client, authorityOf(ctx, op), EXECUTE);
    const standing = await loadRun(tx, client, op.run_id);
    assertCompanyScope(grant, standing.companyCode, refuse);
    await lockPeriod(tx, client, standing.companyCode, standing.fiscalYear, standing.period);
    const row = await loadRun(tx, client, op.run_id);
    assertProposed(row, 'recalculated');
    await assertPeriodOpen(tx, client, row.companyCode, row.fiscalYear, row.period);

    const staged = (await tx.execute(sql`
      select personnel_number, outcome, covered_by, payload from payroll_calc_stage
       where client = ${client} and operation_id = ${operationId} order by personnel_number
    `)) as unknown as Array<{ personnel_number: string; outcome: string; covered_by: string | null; payload: { result?: ResultDraft['result']; lines?: ResultDraft['lines']; reasons?: Array<{ code: string; message: string; remedy?: string }> } | null }>;
    if (staged.some((s) => s.outcome === 'PENDING')) refuse('STAGE_INCOMPLETE', 'The calculation is not finished; nothing was published.');

    const covered = staged.filter((s) => s.outcome === 'COVERED');
    if (op.kind === 'PROPOSE' && covered.length > 0 && covered.length === staged.length) {
      // Same outcome as the foreground refusal: there is nothing for this run to pay. The empty run is
      // closed rather than left as a PROPOSED shell, and the operation says why.
      const covering = [...new Set(covered.map((c) => c.covered_by!))].sort();
      const message = `Run ${covering.join(', ')} already covers every employee for period ${row.period}/${row.fiscalYear} of company ${row.companyCode}; there is nothing for another run to pay.`;
      await tx.execute(sql`delete from payroll_calc_stage where client = ${client} and operation_id = ${operationId}`);
      await tx.execute(sql`
        update payroll_run_operation set status = 'FAILED', error_code = 'ALL_COVERED', error_text = ${message.slice(0, 400)}, finished_at = now(), changed_at = now()
         where client = ${client} and operation_id = ${operationId}
      `);
      await tx.update(payrollRun).set({ status: 'CANCELLED', cancelledBy: op.requested_by, cancelledAt: new Date(), cancelReason: 'Every employee is already covered by another run.', changedBy: op.requested_by, changedAt: new Date() })
        .where(and(eq(payrollRun.client, client), eq(payrollRun.runId, row.runId)));
      return { employees: 0, exceptions: 0, allCovered: true };
    }

    try {
      await tx.delete(payrollResult).where(and(eq(payrollResult.client, client), eq(payrollResult.runId, row.runId)));
    } catch (error) {
      translateTrigger(error);
    }
    await tx.delete(payrollRunException).where(and(eq(payrollRunException.client, client), eq(payrollRunException.runId, row.runId)));

    const byRun = new Map<string, number>();
    const exceptionRows: Array<typeof payrollRunException.$inferInsert> = [];
    for (const c of covered) {
      byRun.set(c.covered_by!, (byRun.get(c.covered_by!) ?? 0) + 1);
      exceptionRows.push({
        client, runId: row.runId, personnelNumber: c.personnel_number, seq: 1, reasonCode: 'ALREADY_COVERED',
        message: `Already covered by run ${c.covered_by} — an off-cycle run pays only employees no live run covers.`,
        remedy: `Nothing to do: run ${c.covered_by} pays this employee for the period.`, createdBy: op.requested_by,
      });
    }
    let included = 0;
    let excepted = 0;
    for (const s of staged) {
      if (s.outcome === 'EXCEPTION') {
        excepted += 1;
        (s.payload?.reasons ?? []).forEach((r, i) => exceptionRows.push({
          client, runId: row.runId, personnelNumber: s.personnel_number, seq: i + 1, reasonCode: r.code,
          message: r.message.slice(0, 400), remedy: r.remedy?.slice(0, 400) ?? null, createdBy: op.requested_by,
        }));
      } else if (s.outcome === 'RESULT' && s.payload?.result) {
        try {
          await tx.insert(payrollResult).values({ ...s.payload.result, runId: row.runId });
          if (s.payload.lines?.length) await tx.insert(payrollResultLine).values(s.payload.lines);
        } catch (error) {
          translateTrigger(error);
        }
        included += 1;
      }
    }
    for (let i = 0; i < exceptionRows.length; i += 500) await tx.insert(payrollRunException).values(exceptionRows.slice(i, i + 500));

    const predecessor = [...byRun.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const before = { employees: row.employeeCount, exceptions: row.exceptionCount };
    await tx.update(payrollRun)
      .set({ employeeCount: included, exceptionCount: excepted, predecessorRunId: predecessor, calculatedBy: op.requested_by, calculatedAt: sql`coalesce((select started_at from payroll_run_operation where client = ${client} and operation_id = ${operationId}), now())`, changedBy: op.requested_by, changedAt: new Date() })
      .where(and(eq(payrollRun.client, client), eq(payrollRun.runId, row.runId)));
    await recordChange(tx, {
      client, objectClass: PAYROLL_RUN_OBJECT_CLASS, objectKey: row.runId, changeType: 'CHANGE',
      changedBy: op.requested_by, transactionCode: PAYROLL_RUN_CAPABILITY,
      before, after: { calculated: true, employees: included, exceptions: excepted, operation: operationId },
    });
    await tx.execute(sql`delete from payroll_calc_stage where client = ${client} and operation_id = ${operationId}`);
    await tx.execute(sql`
      update payroll_run_operation set status = 'SUCCEEDED', employees_done = ${included + excepted}, finished_at = now(), changed_at = now()
       where client = ${client} and operation_id = ${operationId}
    `);
    return { employees: included, exceptions: excepted, allCovered: false };
  });
  if (published.allCovered) throw new PayrollJobError(operationId, 'ALL_COVERED');
  return { cursor: null, processed: published.employees + published.exceptions, progressText: `Published ${published.employees} results and ${published.exceptions} exceptions.` };
}

/** PAYROLL.RUN.POST: post the run as the user who asked, or recognise that it already is posted. */
export async function runPayrollPostChunk(ctx: JobContext): Promise<ChunkResult> {
  const operationId = operationIdOf(ctx);
  const client = ctx.client;
  try {
    const op = await withTenant(client, async (tx) => {
      await ctx.fence(tx);
      const found = await loadOp(tx, client, operationId, true);
      if (!found || found.kind !== 'POST') refuse('OPERATION_UNKNOWN', `Operation ${operationId} is not a posting.`);
      if (found.status === 'SUCCEEDED') return found;
      if (found.status === 'FAILED' || found.status === 'CANCELLED') {
        refuse('OPERATION_ENDED', `This posting already ${found.status.toLowerCase()}${found.error_text ? `: ${found.error_text}` : ''}. A retry is not resumed.`, `Post the run again at ${PAYROLL_RUN_ROUTE}?run=${found.run_id}.`);
      }
      const row = await loadRun(tx, client, found.run_id);
      if (row.status === 'POSTED' && row.documentNumber) {
        // The journal committed and the worker died before this row said so. Nothing is posted again.
        await tx.execute(sql`
          update payroll_run_operation set status = 'SUCCEEDED', finished_at = now(), changed_at = now()
           where client = ${client} and operation_id = ${operationId}
        `);
        return { ...found, status: 'SUCCEEDED' };
      }
      await tx.execute(sql`
        update payroll_run_operation set status = 'RUNNING', started_at = coalesce(started_at, now()), changed_at = now()
         where client = ${client} and operation_id = ${operationId}
      `);
      return { ...found, status: 'RUNNING' };
    });
    if (op.status === 'SUCCEEDED') return { cursor: null, processed: 0, progressText: 'Posted.' };

    // The posting is one all-or-nothing transaction of its own. Its first step is the authority check,
    // which with a job lease also fences this worker against a lost lease and holds the job row until commit.
    await postPayrollRun({
      client,
      changedBy: op.requested_by,
      runId: op.run_id,
      exceptOperationId: operationId,
      authorization: { userId: op.requested_by_user, sessionId: '', jobLease: { runId: ctx.runId, epoch: ctx.epoch } },
    });
    await withTenant(client, async (tx) => {
      await ctx.fence(tx);
      await tx.execute(sql`
        update payroll_run_operation set status = 'SUCCEEDED', finished_at = now(), changed_at = now()
         where client = ${client} and operation_id = ${operationId} and status in ('QUEUED', 'RUNNING')
      `);
    });
    return { cursor: null, processed: 1, progressText: 'Posted.' };
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof PayrollJobError) throw error;
    // A named refusal happened before the journal was written, so the posting transaction rolled back
    // whole and the operation says so. An UNEXPECTED error is not taken at its word: the connection may
    // have dropped after the journal committed. The run itself is the evidence, so read it back.
    const named = error instanceof PayrollPostingError || error instanceof PayrollRunError;
    const code = named ? error.code : 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    if (!named) {
      const posted = await withTenant(client, async (tx) => {
        await ctx.fence(tx);
        const found = await loadOp(tx, client, operationId, true);
        const row = found ? await loadRun(tx, client, found.run_id) : null;
        if (found && row?.status === 'POSTED' && row.documentNumber) {
          await tx.execute(sql`
            update payroll_run_operation set status = 'SUCCEEDED', finished_at = now(), changed_at = now()
             where client = ${client} and operation_id = ${operationId} and status in ('QUEUED', 'RUNNING')
          `);
          return true;
        }
        return false;
      });
      if (posted) return { cursor: null, processed: 1, progressText: 'Posted.' };
    }
    await failOperation(ctx, operationId, code, named ? message : `${message} The run was read back and is not posted.`);
    throw new PayrollJobError(operationId, code);
  }
}

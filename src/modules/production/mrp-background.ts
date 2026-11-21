/**
 * Background plant run (MD01) — submission and the job's work.
 *
 * Submission only validates, authorises, and records the run (QUEUED) together with its job, in one
 * transaction. It enumerates nothing: selecting the materials is the job's first step, so a plant
 * with tens of thousands of materials costs the request nothing.
 *
 * ## Why a replay cannot plan anything twice
 *
 * The run's own tables are the checkpoint. A material goes PENDING -> RUNNING -> COMPLETED inside ONE
 * transaction together with every proposal, dependent requirement and planning-file change it makes, so
 * a worker killed at any point either committed a material completely or not at all. A re-claimed job
 * simply reads what is still PENDING. The job cursor is only a hint (the phase) and is never trusted for
 * correctness. Stale RUNNING rows (from the foreground path, or a manual edit) are reset under the lease.
 *
 * ## Ownership
 *
 * Every write transaction first calls `ctx.fence(tx)` (job_run, then mrp_run: the one lock order used
 * everywhere, see `cancelMrpRun`), so a worker that lost its lease cannot commit. The submitting user is
 * re-validated against current grants and plant scope at the start of every chunk.
 */
import { sql } from 'drizzle-orm';

import { reachablePlantsForUserInTx } from '../../platform/auth/scope-actor';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { assertActorCan, JobActorError, loadJobActor, type JobActor } from '../../platform/job/actor';
import { enqueue } from '../../platform/job/queue';
import { LeaseLostError, type ChunkResult, type JobContext } from '../../platform/job/types';
import { withTenant, type Tx } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import {
  MRP_REGENERATE_CAPABILITY,
  MRP_RUN_CAPABILITY,
  MrpRunError,
  candidates,
  clean,
  closeRun,
  getMrpRun,
  getMrpRunForProvisioning,
  nextLine,
  planMaterialInTx,
  rows,
  sameSelection,
  selectionOf,
  storeStructuralLevels,
  type MrpRunRequest,
  type MrpRunView,
  type Selection,
} from './mrp-run';

export const MRP_PLANT_JOB = 'MRP.PLANT.RUN';

function fail(message: string, remedy?: string): never {
  throw new MrpRunError(message, remedy);
}

/** Authority is the submitting user's CURRENT grant, for the run and for every plant in range. */
async function assertMrpAuthority(
  tx: Tx,
  client: string,
  actor: JobActor,
  selection: Selection,
): Promise<void> {
  await assertActorCan(tx, client, actor, MRP_RUN_CAPABILITY);
  if (selection.processingKey === 'NEUPL') await assertActorCan(tx, client, actor, MRP_REGENERATE_CAPABILITY);
  const plants = await rows(tx, sql`
    select plant from plant
     where client = ${client} and plant >= ${selection.plantFrom} and plant <= ${selection.plantTo}
  `);
  // The Company Code scope must be explicit and name every plant's company; a plant out of reach refuses the run whole.
  const reachable = await reachablePlantsForUserInTx(tx, client, actor.id);
  for (const row of plants) {
    await assertActorCan(tx, client, actor, MRP_RUN_CAPABILITY, { plant: String(row.plant) });
    if (!reachable.includes(String(row.plant))) {
      throw new JobActorError(`${actor.username} no longer holds Company Code and Plant scope for plant ${String(row.plant)}.`);
    }
  }
}

function describeAuthority(error: unknown): never {
  if (error instanceof JobActorError) fail(error.message, 'Ask an administrator for the planning authority, then submit again.');
  throw error;
}

export interface MrpBackgroundRequest extends MrpRunRequest {
  /** The durable id of the submitting user. Never a session. */
  actorUserId: string;
}

export async function submitMrpBackgroundRun(input: MrpBackgroundRequest): Promise<MrpRunView> {
  const selection = selectionOf({ ...input, executionMode: 'BACKGROUND', entryPoint: 'PLANT' }, { background: true });
  const requestKey = clean(input.requestKey);

  const runNumber = await withTenant(input.client, async (tx) => {
    // Concurrent duplicates of one request queue up here, so the second finds the first run and
    // returns it instead of tripping the plant overlap check.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mrp-submit:${input.client}:${requestKey}`}))`);
    const prior = await rows(tx, sql`
      select run_number, processing_key, planning_mode, plant_from, plant_to, material_from, material_to, mrp_controller,
             horizon_start::text as horizon_start, horizon_end::text as horizon_end, simulation_only, status,
             production_version, entry_point, execution_mode, requested_by
        from mrp_run
       where client = ${input.client} and request_key = ${requestKey}
       for update
    `);
    if (prior[0]) {
      // The same request: one run, however often it is submitted. A different scope or submitter is refused.
      if (
        String(prior[0].execution_mode) !== 'BACKGROUND'
        || String(prior[0].requested_by) !== input.requestedBy
        || !sameSelection(prior[0], selection)
      ) {
        fail('This request already planned a different scope.', 'Use a new request. A retry cannot change the scope.');
      }
      return String(prior[0].run_number);
    }
    if (selection.processingKey === 'NEUPL' && !selection.confirmRegenerative) {
      fail('Regenerative planning needs confirmation.', 'Confirm the regenerative run, or choose net change.');
    }
    const actor = await loadJobActor(tx, input.client, input.actorUserId).catch(describeAuthority);
    const plants = await rows(tx, sql`
      select plant from plant
       where client = ${input.client} and plant >= ${selection.plantFrom} and plant <= ${selection.plantTo}
       order by plant
       for update
    `);
    if (plants.length === 0) {
      fail(`The plant ${selection.plantFrom} does not stand.`, 'Maintain the plant before planning in it.');
    }
    await assertMrpAuthority(tx, input.client, actor, selection).catch(describeAuthority);
    const overlap = await rows(tx, sql`
      select run_number from mrp_run
       where client = ${input.client} and status in ('QUEUED', 'RUNNING', 'CANCELLING')
         and plant_from <= ${selection.plantTo} and plant_to >= ${selection.plantFrom}
       limit 1
    `);
    if (overlap[0]) {
      fail(`Run ${overlap[0].run_number} is already planning this plant.`, 'Wait for that run, or cancel it, before planning the same plant.');
    }
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client, objectCode: 'MRPRUN', companyCode: '*', subObject: '*', fiscalYear: 0, allocatedBy: actor.username,
      });
    } catch {
      fail('No active MRP run number range stands.', 'Define the MRPRUN interval, then plan again.');
    }
    const number = drawn.display;
    await tx.execute(sql`
      insert into mrp_run (
        client, run_number, processing_key, execution_mode, planning_mode, simulation_only,
        plant_from, plant_to, material_from, material_to, mrp_controller, horizon_start, horizon_end,
        status, request_key, requested_by, materials_selected, entry_point, production_version, created_by
      ) values (
        ${input.client}, ${number}, ${selection.processingKey}, 'BACKGROUND', ${selection.planningMode}, ${selection.simulationOnly},
        ${selection.plantFrom}, ${selection.plantTo}, ${selection.materialFrom}, ${selection.materialTo}, ${selection.mrpController},
        ${selection.horizonStart}, ${selection.horizonEnd}, 'QUEUED', ${requestKey}, ${actor.username},
        0, ${selection.entryPoint}, ${selection.productionVersion}, ${actor.username}
      )
    `);
    // Only the run number travels in the queue: no selection, no names, nothing a monitor reader could misuse.
    const job = await enqueue(tx, {
      client: input.client,
      jobCode: MRP_PLANT_JOB,
      parameters: { runNumber: number },
      triggeredBy: actor.id,
      idempotencyKey: `mrp:${requestKey}`,
    });
    await tx.execute(sql`
      update mrp_run set job_run_id = ${job.id} where client = ${input.client} and run_number = ${number}
    `);
    return number;
  });
  return (await getMrpRunForProvisioning(input.client, runNumber))!;
}

export interface MrpRunProgress {
  runNumber: string;
  status: string;
  executionMode: string;
  selected: number;
  planned: number;
  failed: number;
  pending: number;
  proposalsCreated: number;
  errorSummary: string | null;
  job: { id: string; status: string; progressText: string | null; errorText: string | null } | null;
}

/** A light read for polling: counts and states, never the material list. */
export async function getMrpRunProgress(
  client: string, runNumber: string, authorization: ServiceAuthorityContext | undefined,
): Promise<MrpRunProgress | null> {
  // Session, capability and plant reach are judged by the run read; a run out of reach answers as a missing one.
  if (!(await getMrpRun(client, runNumber, authorization))) return null;
  return progressOf(client, runNumber);
}

/** Tests, seeds and scripts only; never imported from `src/app`. */
export async function getMrpRunProgressForProvisioning(client: string, runNumber: string) { return progressOf(client, runNumber); }

async function progressOf(client: string, runNumber: string): Promise<MrpRunProgress | null> {
  return withTenant(client, async (tx) => {
    const found = await rows(tx, sql`
      select r.run_number, r.status, r.execution_mode, r.error_summary, r.job_run_id,
             (select count(*) from mrp_run_material m where m.client = r.client and m.run_number = r.run_number and m.status <> 'PENDING') as selected,
             (select count(*) from mrp_run_material m where m.client = r.client and m.run_number = r.run_number and m.status = 'COMPLETED') as planned,
             (select count(*) from mrp_run_material m where m.client = r.client and m.run_number = r.run_number and m.status = 'FAILED') as failed,
             (select count(*) from mrp_run_material m where m.client = r.client and m.run_number = r.run_number and m.status in ('PENDING', 'RUNNING')) as pending,
             (select count(*) from mrp_run_proposal p where p.client = r.client and p.run_number = r.run_number and p.action = 'CREATE' and p.status = 'APPLIED') as created,
             j.id as job_id, j.status as job_status, j.progress_text, j.error_text
        from mrp_run r
        left join job_run j on j.client = r.client and j.id = r.job_run_id
       where r.client = ${client} and r.run_number = ${runNumber.trim()}
    `);
    const r = found[0];
    if (!r) return null;
    return {
      runNumber: String(r.run_number),
      status: String(r.status),
      executionMode: String(r.execution_mode),
      selected: Number(r.selected),
      planned: Number(r.planned),
      failed: Number(r.failed),
      pending: Number(r.pending),
      proposalsCreated: Number(r.created),
      errorSummary: r.error_summary == null ? null : String(r.error_summary),
      job: r.job_id == null
        ? null
        : {
            id: String(r.job_id),
            status: String(r.job_status),
            progressText: r.progress_text == null ? null : String(r.progress_text),
            errorText: r.error_text == null ? null : String(r.error_text),
          },
    };
  });
}

// ── The job ─────────────────────────────────────────────────────────────────

function selectionFromRow(h: Record<string, unknown>): Selection {
  const text = (value: unknown): string | undefined => (value == null ? undefined : String(value));
  return selectionOf(
    {
      client: '',
      requestedBy: '',
      requestKey: String(h.request_key),
      processingKey: String(h.processing_key),
      plantFrom: String(h.plant_from),
      plantTo: String(h.plant_to),
      materialFrom: text(h.material_from),
      materialTo: text(h.material_to),
      mrpController: text(h.mrp_controller),
      horizonStart: text(h.horizon_start),
      horizonEnd: text(h.horizon_end),
      simulationOnly: h.simulation_only === true,
      // The regenerative confirmation was a precondition of submission; the stored run is the proof.
      confirmRegenerative: true,
      executionMode: 'BACKGROUND',
      entryPoint: 'PLANT',
      planningMode: text(h.planning_mode),
      productionVersion: text(h.production_version),
    },
    { background: true },
  );
}

const TERMINAL = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED']);

async function loadHeader(tx: Tx, client: string, runNumber: string, lock: 'update' | 'share') {
  const q = lock === 'update'
    ? sql`
      select run_number, processing_key, planning_mode, plant_from, plant_to, material_from, material_to, mrp_controller,
             horizon_start::text as horizon_start, horizon_end::text as horizon_end, simulation_only, status,
             production_version, request_key, error_summary
        from mrp_run where client = ${client} and run_number = ${runNumber} for update`
    : sql`
      select run_number, processing_key, planning_mode, plant_from, plant_to, material_from, material_to, mrp_controller,
             horizon_start::text as horizon_start, horizon_end::text as horizon_end, simulation_only, status,
             production_version, request_key, error_summary
        from mrp_run where client = ${client} and run_number = ${runNumber} for share`;
  const found = await rows(tx, q);
  if (!found[0]) fail(`Run ${runNumber} does not stand.`);
  return found[0];
}

async function submitterOf(tx: Tx, ctx: JobContext): Promise<JobActor> {
  const found = await rows(tx, sql`select triggered_by from job_run where client = ${ctx.client} and id = ${ctx.runId}`);
  return loadJobActor(tx, ctx.client, String(found[0]?.triggered_by ?? '')).catch(describeAuthority);
}

const DONE: ChunkResult = { cursor: null, processed: 0 };

/** One chunk of the job. Safe to call again after any crash: all state is in the run's own tables. */
export async function runMrpPlantChunk(ctx: JobContext): Promise<ChunkResult> {
  const runNumber = String(ctx.parameters.runNumber ?? '');
  if (!runNumber) fail('The job carries no MRP run number.');
  const client = ctx.client;

  // ── Step 1: look at the run, re-validate the submitter, and select materials on first contact. ──
  const first = await withTenant(client, async (tx): Promise<ChunkResult | 'plan'> => {
    await ctx.fence(tx);
    const header = await loadHeader(tx, client, runNumber, 'update');
    const status = String(header.status);
    if (status === 'CANCELLED') return { cursor: null, processed: 0, progressText: `Run ${runNumber} was cancelled.` };
    if (status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNINGS') {
      // A replay after the last commit but before the job was marked done.
      return { cursor: null, processed: 0, progressText: `Run ${runNumber} already ${status.toLowerCase().replaceAll('_', ' ')}.` };
    }
    if (status === 'FAILED') {
      fail(
        `Run ${runNumber} failed${header.error_summary ? `: ${header.error_summary}` : ''}. A failed run is not resumed.`,
        'Start a new MRP run. Materials already planned stand.',
      );
    }
    const selection = selectionFromRow(header);
    const actor = await submitterOf(tx, ctx);
    try {
      await assertMrpAuthority(tx, client, actor, selection);
    } catch (error) {
      if (error instanceof JobActorError) {
        fail(
          `${error.message} Work already committed by this run stands.`,
          'Ask an administrator for the planning authority, then start a new run.',
        );
      }
      throw error;
    }
    if (status === 'CANCELLING') {
      await tx.execute(sql`
        update mrp_run_material set status = 'CANCELLED', message = 'Cancelled before planning.', changed_by = ${actor.username}, changed_at = now()
         where client = ${client} and run_number = ${runNumber} and status in ('PENDING', 'RUNNING')
      `);
      await closeRun(tx, client, runNumber, 'CANCELLED');
      return { cursor: null, processed: 0, progressText: `Run ${runNumber} was cancelled.` };
    }
    if (status === 'RUNNING') {
      // The background path claims and plans a material in ONE transaction, so a committed RUNNING
      // row can only be left by something else (a foreground run, a manual edit). Under this lease
      // nobody else is working the run, so it is stale: put it back, never reset a live claimant.
      const stale = await rows(tx, sql`
        update mrp_run_material set status = 'PENDING', changed_by = ${actor.username}, changed_at = now()
         where client = ${client} and run_number = ${runNumber} and status = 'RUNNING'
        returning material_number, plant
      `);
      for (const row of stale) {
        await tx.execute(sql`
          insert into mrp_run_diagnostic (client, run_number, line_number, material_number, plant, severity, diagnostic_code, message)
          values (${client}, ${runNumber}, ${await nextLine(tx, client, runNumber, 'diagnostic')},
                  ${String(row.material_number)}, ${String(row.plant)}, 'INFO', 'RECOVERED_RUNNING',
                  'The material was left RUNNING by an interrupted worker and was planned again.')
        `);
      }
    }
    if (status !== 'QUEUED') return 'plan';

    // First contact: select the population, in the job and not in the request.
    const selected = await candidates(tx, client, selection);
    if (selection.processingKey === 'NETCH') {
      const missing = selected.find((item) => item.mrpType !== 'NONE' && item.netChange == null);
      if (missing) {
        fail(
          `Material ${missing.materialNumber} in plant ${missing.plant} has no planning file, so a net-change run cannot know what changed.`,
          'Save the MRP view, or run regenerative planning.',
        );
      }
    }
    const chosen = selection.processingKey === 'NEUPL' ? selected : selected.filter((item) => item.netChange === true);
    for (let i = 0; i < chosen.length; i += 500) {
      const part = chosen.slice(i, i + 500);
      await tx.execute(sql`
        insert into mrp_run_material (client, run_number, material_number, plant, status, planning_changed_at, created_by)
        values ${sql.join(
          part.map((item) => sql`(${client}, ${runNumber}, ${item.materialNumber}, ${item.plant}, 'PENDING', ${item.planningChangedAt}, ${actor.username})`),
          sql`, `,
        )}
        on conflict (client, run_number, material_number, plant) do nothing
      `);
    }
    await tx.execute(sql`
      update mrp_run set status = 'RUNNING', started_at = now(), materials_selected = ${chosen.length},
             changed_by = ${actor.username}, changed_at = now()
       where client = ${client} and run_number = ${runNumber}
    `);
    return 'plan';
  });
  if (first !== 'plan') return first;

  // ── Step 2: plan materials, each in its own all-or-nothing transaction. ──
  let processed = 0;
  let stopped = false;
  while (processed < ctx.chunkSize && !stopped) {
    if (ctx.isLeaseLost()) throw new LeaseLostError();
    const item = await withTenant(client, async (tx) => {
      const next = await rows(tx, sql`
        select material_number, plant, bom_level, explosion_path from mrp_run_material
         where client = ${client} and run_number = ${runNumber} and status = 'PENDING'
         order by bom_level, plant, material_number
         limit 1
      `);
      return next[0] ?? null;
    });
    if (!item) break;

    try {
      stopped = await withTenant(client, async (tx) => {
        await ctx.fence(tx);
        const header = await loadHeader(tx, client, runNumber, 'share');
        if (String(header.status) !== 'RUNNING') return true; // cancelled, or closed: do not start more work
        const actor = await submitterOf(tx, ctx);
        const claim = await rows(tx, sql`
          update mrp_run_material set status = 'RUNNING', changed_by = ${actor.username}, changed_at = now()
           where client = ${client} and run_number = ${runNumber}
             and material_number = ${String(item.material_number)} and plant = ${String(item.plant)}
             and status = 'PENDING'
          returning material_number
        `);
        if (claim.length === 0) return false;
        await planMaterialInTx(tx, {
          client, runNumber, actor: actor.username, selection: selectionFromRow(header),
          item: { material_number: item.material_number, plant: item.plant, bom_level: item.bom_level, explosion_path: item.explosion_path },
          limit: null,
        });
        return false;
      });
      if (!stopped) processed += 1;
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      const message = error instanceof Error ? error.message : 'The material could not be planned.';
      await withTenant(client, async (tx) => {
        await ctx.fence(tx);
        await tx.execute(sql`
          update mrp_run_material
             set status = 'FAILED', diagnostic_code = 'PLAN_FAILED', message = ${message.slice(0, 200)}, changed_at = now()
           where client = ${client} and run_number = ${runNumber}
             and material_number = ${String(item.material_number)} and plant = ${String(item.plant)}
             and status in ('PENDING', 'RUNNING')
        `);
        await tx.execute(sql`
          insert into mrp_run_diagnostic (client, run_number, line_number, material_number, plant, severity, diagnostic_code, message)
          values (${client}, ${runNumber}, ${await nextLine(tx, client, runNumber, 'diagnostic')},
                  ${String(item.material_number)}, ${String(item.plant)}, 'ERROR', 'PLAN_FAILED', ${message.slice(0, 200)})
        `);
      });
      processed += 1;
    }
  }

  // ── Step 3: finish only when nothing is left. A run is never closed with pending work. ──
  return withTenant(client, async (tx): Promise<ChunkResult> => {
    await ctx.fence(tx);
    const header = await loadHeader(tx, client, runNumber, 'update');
    const status = String(header.status);
    if (TERMINAL.has(status)) return { cursor: null, processed, progressText: `Run ${runNumber} ${status.toLowerCase().replaceAll('_', ' ')}.` };
    const left = await rows(tx, sql`
      select count(*) filter (where status in ('PENDING', 'RUNNING')) as open,
             count(*) filter (where status <> 'PENDING') as done,
             count(*) as total
        from mrp_run_material where client = ${client} and run_number = ${runNumber}
    `);
    const open = Number(left[0]?.open ?? 0);
    if (status === 'CANCELLING') {
      await tx.execute(sql`
        update mrp_run_material set status = 'CANCELLED', message = 'Cancelled before planning.', changed_at = now()
         where client = ${client} and run_number = ${runNumber} and status in ('PENDING', 'RUNNING')
      `);
      await closeRun(tx, client, runNumber, 'CANCELLED');
      return { cursor: null, processed, progressText: `Run ${runNumber} was cancelled. Materials already planned stand.` };
    }
    if (open === 0) {
      await storeStructuralLevels(tx, client, runNumber);
      await closeRun(tx, client, runNumber, 'COMPLETED');
      return { cursor: null, processed, progressText: `Planned ${Number(left[0]?.done ?? 0)} materials.` };
    }
    if (processed === 0 && ctx.chunkSize > 0) {
      fail(`Run ${runNumber} made no progress with ${open} material(s) still open.`, 'Read the run diagnostics.');
    }
    return {
      cursor: { phase: 'plan' },
      processed,
      // No percentage: BOM explosion adds materials as the run goes, so the total is not known.
      progressText: `Planned ${Number(left[0]?.done ?? 0)} of ${Number(left[0]?.total ?? 0)} materials so far; more may be added by BOM explosion.`,
    };
  });
}

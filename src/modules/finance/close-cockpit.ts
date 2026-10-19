/**
 * Period-end close cockpit (SCR-101 / FIN.CLOSE.COCKPIT, CLOCO).
 *
 * A closing cycle (company code, fiscal year, posting period)
 * carries a task list built from a reusable template. Tasks run
 * only through the registered handler catalogue below — never
 * arbitrary client-supplied programs — with dependency gating,
 * evidence/sign-off completion gates, an append-only execution
 * log and event trail, and exactly-once execution locks.
 * Completing a task list never closes or locks the period.
 */

export const CLOSE_COCKPIT_CAPABILITY = 'FIN.CLOSE.COCKPIT';

export const TASK_LIST_ID_MAX = 30;
export const TASK_ID_MAX = 30;
export const TASK_NAME_MAX = 80;

export const TASK_LIST_STATUSES = ['INITIAL', 'RELEASED', 'FINALIZED'] as const;
export type TaskListStatus = (typeof TASK_LIST_STATUSES)[number];

export const TASK_STATUSES = ['INITIAL', 'RELEASED', 'RUNNING', 'COMPLETED', 'ERROR', 'BLOCKED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const EXECUTION_MODES = ['FOREGROUND', 'BACKGROUND'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_STATUSES = ['SCHEDULED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * The closed handler registry. A template or instance may only
 * name one of these codes; the service refuses anything else.
 * POSTING handlers inherit the canonical open-period checks of
 * the services they call; REPORT handlers are never blocked by
 * posting-period rules.
 */
export const CLOSE_TASK_HANDLERS = [
  { code: 'PERIOD_STATUS', kind: 'REPORT', label: 'Period status report' },
  { code: 'ACCRUAL_REVERSALS', kind: 'POSTING', label: 'Execute due accrual reversals' },
  { code: 'FX_VALUATION', kind: 'POSTING', label: 'Foreign-currency valuation' },
  { code: 'MANUAL_CONFIRMATION', kind: 'MANUAL', label: 'Manual confirmation' },
] as const;
export type CloseTaskHandlerCode = (typeof CLOSE_TASK_HANDLERS)[number]['code'];
export const CLOSE_TASK_HANDLER_CODES = CLOSE_TASK_HANDLERS.map((h) => h.code) as CloseTaskHandlerCode[];

export interface CloseCycleKey {
  companyCode: string;
  taskListId: string;
  fiscalYear: number;
  postingPeriod: number;
}

export interface TaskListView extends CloseCycleKey {
  description: string | null;
  status: TaskListStatus;
  templateCode: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  blockedTasks: number;
  completionPercent: number;
  criticalPathOpen: boolean;
  createdBy: string;
  updatedBy: string | null;
}

export interface TaskView extends CloseCycleKey {
  taskId: string;
  taskName: string;
  parentTaskId: string | null;
  sequence: number;
  handlerCode: string;
  owner: string | null;
  status: TaskStatus;
  criticalPath: boolean;
  requiresEvidence: boolean;
  requiresSignoff: boolean;
  evidenceRef: string | null;
  signedOffBy: string | null;
  dueDate: string | null;
  overdue: boolean;
  attemptCount: number;
  lastExecutedAt: string | null;
  predecessors: string[];
  depth: number;
}

export interface ExecutionLogView {
  executionId: string;
  taskId: string;
  attempt: number;
  mode: ExecutionMode;
  status: ExecutionStatus;
  initiatedBy: string;
  startedAt: string | null;
  endedAt: string | null;
  resultSummary: string | null;
  errorDetails: string | null;
  generatedDocumentNumber: string | null;
}

export interface CloseEventView {
  eventId: string;
  taskId: string | null;
  eventType: string;
  actor: string;
  reason: string | null;
  detail: string | null;
  createdAt: string;
}

export class CloseCockpitError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CloseCockpitError';
    this.remedy = remedy;
  }
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { listDueAccruals, executeAccrualReversal } from './accrual';
import { executeFxValuation } from './fx-valuation';

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`.slice(0, 24);
}

/** Calendar period end (periods 13–16 close at year end). */
export function periodEndDate(fiscalYear: number, postingPeriod: number): string {
  const month = Math.min(Math.max(postingPeriod, 1), 12);
  const last = new Date(Date.UTC(fiscalYear, month, 0));
  return last.toISOString().slice(0, 10);
}

function fail(message: string, remedy?: string): never {
  throw new CloseCockpitError(message, remedy);
}

function checkCycle(cycle: CloseCycleKey): void {
  if (!cycle.taskListId || cycle.taskListId.length > TASK_LIST_ID_MAX) fail('A task list of at most 30 characters is required.');
  if (!cycle.companyCode) fail('A company code is required.');
  if (!Number.isInteger(cycle.fiscalYear) || cycle.fiscalYear < 1900 || cycle.fiscalYear > 2199) fail('A valid fiscal year is required.');
  if (!Number.isInteger(cycle.postingPeriod) || cycle.postingPeriod < 1 || cycle.postingPeriod > 16) fail('A posting period between 1 and 16 is required.');
}

function checkHandler(code: string): void {
  if (!CLOSE_TASK_HANDLER_CODES.includes(code as CloseTaskHandlerCode)) {
    fail(`Handler ${code} is not registered.`, `Registered handlers: ${CLOSE_TASK_HANDLER_CODES.join(', ')}.`);
  }
}

interface TaskRow {
  task_id: string; task_name: string; parent_task_id: string | null; sequence: number;
  handler_code: string; owner: string | null; status: TaskStatus; critical_path: boolean;
  requires_evidence: boolean; requires_signoff: boolean; parameters: string | null;
  evidence_ref: string | null; signed_off_by: string | null; due_date: string | null;
  attempt_count: number; last_executed_at: Date | string | null;
}

async function recordEvent(tx: Tx, client: string, cycle: CloseCycleKey, taskId: string | null,
  eventType: string, actor: string, reason?: string, detail?: string): Promise<void> {
  await tx.execute(sql`
    insert into closing_task_event
      (client, event_id, company_code, task_list_id, fiscal_year, posting_period, task_id, event_type, actor, reason, detail)
    values (${client}, ${newId('CE')}, ${cycle.companyCode}, ${cycle.taskListId}, ${cycle.fiscalYear},
            ${cycle.postingPeriod}, ${taskId}, ${eventType}, ${actor}, ${reason ?? null}, ${detail ?? null})
  `);
}

async function loadTasks(tx: Tx, client: string, cycle: CloseCycleKey): Promise<TaskRow[]> {
  const rows = await tx.execute(sql`
    select * from closing_task_instance
    where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
      and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod}
    order by sequence, task_id
  `);
  return rows as unknown as TaskRow[];
}

async function loadDependencies(tx: Tx, client: string, cycle: CloseCycleKey): Promise<Array<{ task_id: string; predecessor_task_id: string }>> {
  const rows = await tx.execute(sql`
    select task_id, predecessor_task_id from closing_task_dependency
    where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
      and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod}
  `);
  return rows as unknown as Array<{ task_id: string; predecessor_task_id: string }>;
}

/** Depth-first cycle check over task → predecessor edges. */
export function findDependencyCycle(edges: Array<{ task: string; predecessor: string }>): string[] | null {
  const byTask = new Map<string, string[]>();
  for (const e of edges) byTask.set(e.task, [...(byTask.get(e.task) ?? []), e.predecessor]);
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of byTask.get(node) ?? []) {
      if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) { const found = visit(next); if (found) return found; }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const task of byTask.keys()) if (!state.has(task)) { const found = visit(task); if (found) return found; }
  return null;
}

function gatesMet(task: TaskRow): boolean {
  return (!task.requires_evidence || Boolean(task.evidence_ref)) && (!task.requires_signoff || Boolean(task.signed_off_by));
}

function gateDescription(task: TaskRow): string {
  const missing: string[] = [];
  if (task.requires_evidence && !task.evidence_ref) missing.push('evidence');
  if (task.requires_signoff && !task.signed_off_by) missing.push('sign-off');
  return missing.join(' and ');
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export async function upsertTemplateTask(input: {
  client: string; changedBy: string; templateCode: string;
  task: {
    taskId: string; taskName: string; parentTaskId?: string; sequence?: number;
    handlerCode: string; owner?: string; criticalPath?: boolean;
    requiresEvidence?: boolean; requiresSignoff?: boolean; parameters?: string;
  };
  predecessors?: string[];
}): Promise<void> {
  const templateCode = input.templateCode.trim().toUpperCase();
  const task = input.task;
  if (!templateCode || templateCode.length > 30) fail('A template code of at most 30 characters is required.');
  if (!task.taskId || task.taskId.length > TASK_ID_MAX) fail('A task ID of at most 30 characters is required.');
  if (!task.taskName || task.taskName.length > TASK_NAME_MAX) fail('A task name of at most 80 characters is required.');
  checkHandler(task.handlerCode);
  await withTenant(input.client, async (tx) => {
    await tx.execute(sql`
      insert into closing_task_template
        (client, template_code, task_id, task_name, parent_task_id, sequence, handler_code, owner,
         critical_path, requires_evidence, requires_signoff, parameters, created_by)
      values (${input.client}, ${templateCode}, ${task.taskId}, ${task.taskName}, ${task.parentTaskId ?? null},
              ${task.sequence ?? 0}, ${task.handlerCode}, ${task.owner ?? null}, ${task.criticalPath ?? false},
              ${task.requiresEvidence ?? false}, ${task.requiresSignoff ?? false}, ${task.parameters ?? null}, ${input.changedBy})
      on conflict (client, template_code, task_id) do update set
        task_name = excluded.task_name, parent_task_id = excluded.parent_task_id,
        sequence = excluded.sequence, handler_code = excluded.handler_code, owner = excluded.owner,
        critical_path = excluded.critical_path, requires_evidence = excluded.requires_evidence,
        requires_signoff = excluded.requires_signoff, parameters = excluded.parameters,
        updated_by = ${input.changedBy}, updated_at = now()
    `);
    for (const predecessor of input.predecessors ?? []) {
      if (predecessor === task.taskId) fail('A task cannot depend on itself.');
      await tx.execute(sql`
        insert into closing_task_template_dependency (client, template_code, task_id, predecessor_task_id)
        values (${input.client}, ${templateCode}, ${task.taskId}, ${predecessor})
        on conflict do nothing
      `);
    }
    const edges = await tx.execute(sql`
      select task_id as task, predecessor_task_id as predecessor from closing_task_template_dependency
      where client = ${input.client} and template_code = ${templateCode}
    `);
    const cyclePath = findDependencyCycle(edges as unknown as Array<{ task: string; predecessor: string }>);
    if (cyclePath) fail(`Template ${templateCode} contains a circular dependency: ${cyclePath.join(' → ')}.`, 'Break the circle before saving.');
  });
}

export async function listTemplateTasks(client: string, templateCode: string): Promise<Array<{
  taskId: string; taskName: string; handlerCode: string; predecessors: string[];
}>> {
  return withTenant(client, async (tx) => {
    const tasks = await tx.execute(sql`
      select task_id, task_name, handler_code from closing_task_template
      where client = ${client} and template_code = ${templateCode} order by sequence, task_id
    `);
    const deps = await tx.execute(sql`
      select task_id, predecessor_task_id from closing_task_template_dependency
      where client = ${client} and template_code = ${templateCode}
    `);
    const byTask = new Map<string, string[]>();
    for (const d of deps as unknown as Array<{ task_id: string; predecessor_task_id: string }>) {
      byTask.set(d.task_id, [...(byTask.get(d.task_id) ?? []), d.predecessor_task_id]);
    }
    return (tasks as unknown as Array<{ task_id: string; task_name: string; handler_code: string }>).map((t) => ({
      taskId: t.task_id, taskName: t.task_name, handlerCode: t.handler_code,
      predecessors: byTask.get(t.task_id) ?? [],
    }));
  });
}

/* ------------------------------------------------------------------ */
/* Task lists and instances                                            */
/* ------------------------------------------------------------------ */

export async function createTaskListFromTemplate(input: {
  client: string; changedBy: string; cycle: CloseCycleKey;
  templateCode: string; description?: string;
}): Promise<TaskListView> {
  const s = { ...input, cycle: { ...input.cycle } };
  checkCycle(s.cycle);
  return withTenant(s.client, async (tx) => {
    const template = await tx.execute(sql`
      select * from closing_task_template where client = ${s.client} and template_code = ${s.templateCode} order by sequence, task_id
    `);
    const defs = template as unknown as TaskRow[];
    if (defs.length === 0) fail(`Template ${s.templateCode} has no task definitions.`, 'Define template tasks first.');
    await tx.execute(sql`
      insert into closing_task_list (client, company_code, task_list_id, fiscal_year, posting_period, description, template_code, created_by)
      values (${s.client}, ${s.cycle.companyCode}, ${s.cycle.taskListId}, ${s.cycle.fiscalYear}, ${s.cycle.postingPeriod},
              ${s.description ?? null}, ${s.templateCode}, ${s.changedBy})
    `);
    for (const def of defs) {
      await tx.execute(sql`
        insert into closing_task_instance
          (client, company_code, task_list_id, fiscal_year, posting_period, task_id, task_name, parent_task_id,
           sequence, handler_code, owner, critical_path, requires_evidence, requires_signoff, parameters, created_by)
        values (${s.client}, ${s.cycle.companyCode}, ${s.cycle.taskListId}, ${s.cycle.fiscalYear}, ${s.cycle.postingPeriod},
                ${def.task_id}, ${def.task_name}, ${def.parent_task_id}, ${def.sequence}, ${def.handler_code}, ${def.owner},
                ${def.critical_path}, ${def.requires_evidence}, ${def.requires_signoff}, ${def.parameters}, ${s.changedBy})
      `);
    }
    await tx.execute(sql`
      insert into closing_task_dependency
        (client, company_code, task_list_id, fiscal_year, posting_period, task_id, predecessor_task_id)
      select ${s.client}, ${s.cycle.companyCode}, ${s.cycle.taskListId}, ${s.cycle.fiscalYear}, ${s.cycle.postingPeriod},
             task_id, predecessor_task_id
      from closing_task_template_dependency
      where client = ${s.client} and template_code = ${s.templateCode}
    `);
    await recordEvent(tx, s.client, s.cycle, null, 'CREATED', s.changedBy, undefined, `From template ${s.templateCode} (${defs.length} tasks)`);
    return getTaskListIn(tx, s.client, s.cycle);
  });
}

async function getTaskListIn(tx: Tx, client: string, cycle: CloseCycleKey): Promise<TaskListView> {
  const rows = await tx.execute(sql`
    select l.*, count(i.task_id)::int as total,
      count(i.task_id) filter (where i.status = 'COMPLETED')::int as completed,
      count(i.task_id) filter (where i.status = 'ERROR')::int as failed,
      count(i.task_id) filter (where i.status = 'BLOCKED')::int as blocked,
      bool_or(i.critical_path and i.status <> 'COMPLETED') as critical_open
    from closing_task_list l
    left join closing_task_instance i
      on i.client = l.client and i.company_code = l.company_code and i.task_list_id = l.task_list_id
     and i.fiscal_year = l.fiscal_year and i.posting_period = l.posting_period
    where l.client = ${client} and l.company_code = ${cycle.companyCode} and l.task_list_id = ${cycle.taskListId}
      and l.fiscal_year = ${cycle.fiscalYear} and l.posting_period = ${cycle.postingPeriod}
    group by l.client, l.company_code, l.task_list_id, l.fiscal_year, l.posting_period,
             l.description, l.status, l.template_code, l.created_by, l.updated_by, l.created_at, l.updated_at
  `);
  const r = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!r) fail(`Closing cycle ${cycle.taskListId} ${cycle.fiscalYear}/${cycle.postingPeriod} does not stand.`, 'Create the task list first.');
  const total = Number(r.total ?? 0);
  const completed = Number(r.completed ?? 0);
  return {
    ...cycle, description: (r.description as string) ?? null, status: r.status as TaskListStatus,
    templateCode: (r.template_code as string) ?? null,
    totalTasks: total, completedTasks: completed,
    failedTasks: Number(r.failed ?? 0), blockedTasks: Number(r.blocked ?? 0),
    completionPercent: total === 0 ? 0 : Math.round((completed / total) * 100),
    criticalPathOpen: Boolean(r.critical_open),
    createdBy: String(r.created_by), updatedBy: (r.updated_by as string) ?? null,
  };
}

export async function getTaskList(client: string, cycle: CloseCycleKey): Promise<TaskListView> {
  checkCycle(cycle);
  return withTenant(client, (tx) => getTaskListIn(tx, client, cycle));
}

export async function listTaskLists(client: string): Promise<TaskListView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select company_code, task_list_id, fiscal_year, posting_period from closing_task_list
      where client = ${client} order by created_at desc limit 100
    `);
    const views: TaskListView[] = [];
    for (const r of rows as unknown as Array<{ company_code: string; task_list_id: string; fiscal_year: number; posting_period: number }>) {
      views.push(await getTaskListIn(tx, client, {
        companyCode: r.company_code, taskListId: r.task_list_id,
        fiscalYear: Number(r.fiscal_year), postingPeriod: Number(r.posting_period),
      }));
    }
    return views;
  });
}

export async function listTasks(client: string, cycle: CloseCycleKey,
  filter: { status?: string; owner?: string } = {}): Promise<TaskView[]> {
  checkCycle(cycle);
  return withTenant(client, async (tx) => {
    const tasks = await loadTasks(tx, client, cycle);
    const deps = await loadDependencies(tx, client, cycle);
    const byTask = new Map<string, string[]>();
    for (const d of deps) byTask.set(d.task_id, [...(byTask.get(d.task_id) ?? []), d.predecessor_task_id]);
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const depthOf = (task: TaskRow, seen = new Set<string>()): number => {
      if (!task.parent_task_id || seen.has(task.task_id)) return 0;
      const parent = byId.get(task.parent_task_id);
      return parent ? depthOf(parent, new Set([...seen, task.task_id])) + 1 : 0;
    };
    const today = new Date().toISOString().slice(0, 10);
    return tasks
      .filter((t) => (!filter.status || t.status === filter.status) && (!filter.owner || t.owner === filter.owner))
      .map((t) => ({
        ...cycle, taskId: t.task_id, taskName: t.task_name, parentTaskId: t.parent_task_id,
        sequence: t.sequence, handlerCode: t.handler_code, owner: t.owner, status: t.status,
        criticalPath: t.critical_path, requiresEvidence: t.requires_evidence, requiresSignoff: t.requires_signoff,
        evidenceRef: t.evidence_ref, signedOffBy: t.signed_off_by, dueDate: t.due_date,
        overdue: Boolean(t.due_date && t.due_date < today && t.status !== 'COMPLETED'),
        attemptCount: t.attempt_count,
        lastExecutedAt: t.last_executed_at ? new Date(t.last_executed_at).toISOString() : null,
        predecessors: byTask.get(t.task_id) ?? [], depth: depthOf(t),
      }));
  });
}

export async function listExecutions(client: string, cycle: CloseCycleKey, taskId?: string): Promise<ExecutionLogView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select * from closing_execution_log
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod}
        ${taskId ? sql`and task_id = ${taskId}` : sql``}
      order by created_at desc limit 200
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      executionId: String(r.execution_id), taskId: String(r.task_id), attempt: Number(r.attempt),
      mode: r.mode as ExecutionMode, status: r.status as ExecutionStatus, initiatedBy: String(r.initiated_by),
      startedAt: r.started_at ? new Date(r.started_at as string).toISOString() : null,
      endedAt: r.ended_at ? new Date(r.ended_at as string).toISOString() : null,
      resultSummary: (r.result_summary as string) ?? null, errorDetails: (r.error_details as string) ?? null,
      generatedDocumentNumber: (r.generated_document_number as string) ?? null,
    }));
  });
}

export async function listEvents(client: string, cycle: CloseCycleKey): Promise<CloseEventView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select * from closing_task_event
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod}
      order by created_at desc limit 200
    `);
    return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
      eventId: String(r.event_id), taskId: (r.task_id as string) ?? null, eventType: String(r.event_type),
      actor: String(r.actor), reason: (r.reason as string) ?? null, detail: (r.detail as string) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  });
}

export async function releaseTaskList(input: { client: string; changedBy: string; cycle: CloseCycleKey }): Promise<TaskListView> {
  const { client, changedBy, cycle } = input;
  checkCycle(cycle);
  return withTenant(client, async (tx) => {
    const list = await getTaskListIn(tx, client, cycle);
    if (list.status !== 'INITIAL') fail(`Task list stands ${list.status}; only an initial list can be released.`);
    const tasks = await loadTasks(tx, client, cycle);
    if (tasks.length === 0) fail('The task list has no tasks.', 'Instantiate a template first.');
    for (const task of tasks) checkHandler(task.handler_code);
    const deps = await loadDependencies(tx, client, cycle);
    const cyclePath = findDependencyCycle(deps.map((d) => ({ task: d.task_id, predecessor: d.predecessor_task_id })));
    if (cyclePath) fail(`Circular dependency: ${cyclePath.join(' → ')}.`, 'Break the circle before release.');
    await tx.execute(sql`
      update closing_task_list set status = 'RELEASED', updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and status = 'INITIAL'
    `);
    await tx.execute(sql`
      update closing_task_instance set status = 'RELEASED', updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and status = 'INITIAL'
    `);
    await recordEvent(tx, client, cycle, null, 'RELEASED', changedBy);
    return getTaskListIn(tx, client, cycle);
  });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

interface HandlerResult { summary: string; documentNumber?: string; documentFiscalYear?: number }

async function runHandler(client: string, actor: string, cycle: CloseCycleKey,
  task: TaskRow, attempt: number): Promise<HandlerResult> {
  const params = (() => {
    try { return task.parameters ? JSON.parse(task.parameters) as Record<string, string> : {}; }
    catch { return {} as Record<string, string>; }
  })();
  if (task.handler_code === 'PERIOD_STATUS') {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select status, count(*)::int as n from journal_entry
        where client = ${client} and company_code = ${cycle.companyCode}
          and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod}
        group by status order by status
      `);
      const counts = (rows as unknown as Array<{ status: string; n: number }>)
        .map((r) => `${r.status.toLowerCase()} ${r.n}`).join(', ') || 'no documents';
      return { summary: `Period ${cycle.fiscalYear}/${String(cycle.postingPeriod).padStart(2, '0')}: ${counts}.` };
    });
  }
  if (task.handler_code === 'ACCRUAL_REVERSALS') {
    const asOf = params.asOfDate && DATE_RE.test(params.asOfDate)
      ? params.asOfDate : periodEndDate(cycle.fiscalYear, cycle.postingPeriod);
    const due = (await listDueAccruals(client, asOf)).filter((d) => d.companyCode === cycle.companyCode);
    let firstDocument: string | undefined;
    for (const doc of due) {
      const reversed = await executeAccrualReversal({
        client, changedBy: actor, companyCode: doc.companyCode,
        documentNumber: doc.documentNumber, fiscalYear: doc.fiscalYear,
      });
      firstDocument ??= reversed.reversalDocumentNumber ?? undefined;
    }
    return {
      summary: due.length === 0 ? `No accrual reversals due at ${asOf}.` : `Reversed ${due.length} accrual document(s) due at ${asOf}.`,
      documentNumber: firstDocument,
    };
  }
  if (task.handler_code === 'FX_VALUATION') {
    const keyDate = params.keyDate && DATE_RE.test(params.keyDate)
      ? params.keyDate : periodEndDate(cycle.fiscalYear, cycle.postingPeriod);
    const result = await executeFxValuation({
      client, changedBy: actor,
      selection: {
        companyCode: cycle.companyCode, valuationArea: params.valuationArea || 'STD',
        valuationKeyDate: keyDate, postingDate: params.postingDate && DATE_RE.test(params.postingDate) ? params.postingDate : keyDate,
        fiscalYear: cycle.fiscalYear,
        valuationMethod: (['AVERAGE', 'BUYING', 'SELLING'].includes(params.valuationMethod) ? params.valuationMethod : 'AVERAGE') as 'AVERAGE' | 'BUYING' | 'SELLING',
        includeOpenItems: params.includeOpenItems === 'true', includeBalances: params.includeBalances !== 'false',
        testRun: false, documentType: params.documentType || 'SA',
        requestKey: `close-${cycle.taskListId}-${cycle.fiscalYear}-${cycle.postingPeriod}-${task.task_id}-${attempt}`,
      },
    });
    const posted = result.items?.find((i) => i.postingDocument)?.postingDocument ?? undefined;
    return {
      summary: `FX valuation ${result.runId} ${result.status.toLowerCase()} at ${keyDate}.`,
      documentNumber: posted,
    };
  }
  return { summary: 'Manual confirmation executed.' };
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

async function completeOrBlock(tx: Tx, client: string, cycle: CloseCycleKey,
  task: TaskRow, actor: string): Promise<TaskStatus> {
  const next: TaskStatus = gatesMet(task) ? 'COMPLETED' : 'BLOCKED';
  await tx.execute(sql`
    update closing_task_instance set status = ${next}, last_executed_at = now(), updated_by = ${actor}, updated_at = now()
    where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
      and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${task.task_id}
  `);
  return next;
}

async function settleExecution(client: string, actor: string, cycle: CloseCycleKey,
  executionId: string, task: TaskRow): Promise<{ status: TaskStatus }> {
  try {
    const result = await runHandler(client, actor, cycle, task, task.attempt_count);
    return withTenant(client, async (tx) => {
      await tx.execute(sql`
        update closing_execution_log set status = 'SUCCEEDED', ended_at = now(),
          result_summary = ${result.summary.slice(0, 240)},
          generated_document_number = ${result.documentNumber ?? null},
          generated_fiscal_year = ${result.documentFiscalYear ?? null}
        where client = ${client} and execution_id = ${executionId}
      `);
      const fresh = (await loadTasks(tx, client, cycle)).find((t) => t.task_id === task.task_id) ?? task;
      const status = await completeOrBlock(tx, client, cycle, { ...fresh, attempt_count: task.attempt_count }, actor);
      if (status === 'BLOCKED') {
        await tx.execute(sql`
          update closing_execution_log set result_summary = ${`${result.summary} Awaiting ${gateDescription(fresh)}.` .slice(0, 240)}
          where client = ${client} and execution_id = ${executionId}
        `);
      }
      return { status };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Handler failed.';
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update closing_execution_log set status = 'FAILED', ended_at = now(), error_details = ${message.slice(0, 2000)}
        where client = ${client} and execution_id = ${executionId}
      `);
      await tx.execute(sql`
        update closing_task_instance set status = 'ERROR', last_executed_at = now(), updated_by = ${actor}, updated_at = now()
        where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
          and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${task.task_id}
      `);
    });
    return { status: 'ERROR' };
  }
}

export async function executeTask(input: {
  client: string; changedBy: string; cycle: CloseCycleKey; taskId: string; mode: ExecutionMode;
}): Promise<{ status: TaskStatus; executionId: string; scheduled: boolean }> {
  const { client, changedBy, cycle, taskId, mode } = input;
  checkCycle(cycle);
  if (!EXECUTION_MODES.includes(mode)) fail('Execution mode must be FOREGROUND or BACKGROUND.');
  const executionId = newId('CX');
  const claimed = await withTenant(client, async (tx) => {
    const list = await getTaskListIn(tx, client, cycle);
    if (list.status !== 'RELEASED') fail(`Task list stands ${list.status}; release it before executing tasks.`);
    const tasks = await loadTasks(tx, client, cycle);
    const task = tasks.find((t) => t.task_id === taskId);
    if (!task) fail(`Task ${taskId} does not stand in this cycle.`);
    if (task.status === 'COMPLETED') fail(`Task ${taskId} already stands completed.`, 'Reopen it with a reason before rerunning.');
    if (task.status === 'BLOCKED' && gatesMet(task) === false && task.attempt_count > 0) {
      fail(`Task ${taskId} waits for ${gateDescription(task)}.`, 'Attach the evidence or sign-off to complete it.');
    }
    const deps = await loadDependencies(tx, client, cycle);
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    const open = deps.filter((d) => d.task_id === taskId)
      .map((d) => byId.get(d.predecessor_task_id))
      .filter((p) => p && p.status !== 'COMPLETED');
    if (open.length > 0) {
      fail(`Task ${taskId} cannot execute: predecessor(s) ${open.map((p) => p!.task_id).join(', ')} are not completed.`,
        'Complete the predecessors first.');
    }
    const claimedRows = await tx.execute(sql`
      update closing_task_instance
      set status = 'RUNNING', attempt_count = attempt_count + 1, last_execution_id = ${executionId},
          updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${taskId}
        and status in ('RELEASED', 'ERROR')
      returning attempt_count
    `);
    const attempt = Number((claimedRows as unknown as Array<{ attempt_count: number }>)[0]?.attempt_count ?? 0);
    if (attempt === 0) fail(`Task ${taskId} stands ${task.status} and cannot start now.`, 'It may already be running.');
    await tx.execute(sql`
      insert into closing_execution_log
        (client, execution_id, company_code, task_list_id, fiscal_year, posting_period, task_id, attempt, mode, status, initiated_by, started_at)
      values (${client}, ${executionId}, ${cycle.companyCode}, ${cycle.taskListId}, ${cycle.fiscalYear}, ${cycle.postingPeriod},
              ${taskId}, ${attempt}, ${mode}, ${mode === 'BACKGROUND' ? 'SCHEDULED' : 'RUNNING'}, ${changedBy},
              ${mode === 'BACKGROUND' ? null : new Date().toISOString()})
    `);
    await recordEvent(tx, client, cycle, taskId, attempt > 1 ? 'RETRIED' : 'EXECUTED', changedBy, undefined,
      `${mode} attempt ${attempt}`);
    return { ...task, attempt_count: attempt };
  });
  if (mode === 'BACKGROUND') return { status: 'RUNNING', executionId, scheduled: true };
  const settled = await settleExecution(client, changedBy, cycle, executionId, claimed);
  return { status: settled.status, executionId, scheduled: false };
}

export async function processScheduledExecutions(input: {
  client: string; changedBy: string; cycle: CloseCycleKey;
}): Promise<{ processed: number }> {
  const { client, changedBy, cycle } = input;
  checkCycle(cycle);
  const pending = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select execution_id, task_id from closing_execution_log
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and status = 'SCHEDULED'
      order by created_at
    `);
    return rows as unknown as Array<{ execution_id: string; task_id: string }>;
  });
  let processed = 0;
  for (const row of pending) {
    const task = await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update closing_execution_log set status = 'RUNNING', started_at = now()
        where client = ${client} and execution_id = ${row.execution_id} and status = 'SCHEDULED'
      `);
      const tasks = await loadTasks(tx, client, cycle);
      return tasks.find((t) => t.task_id === row.task_id);
    });
    if (!task) continue;
    await settleExecution(client, changedBy, cycle, row.execution_id, task);
    processed += 1;
  }
  return { processed };
}

/* ------------------------------------------------------------------ */
/* Gates, overrides, finalization                                      */
/* ------------------------------------------------------------------ */

async function maybeComplete(tx: Tx, client: string, cycle: CloseCycleKey, task: TaskRow): Promise<TaskStatus> {
  if (task.status === 'BLOCKED' && task.attempt_count > 0 && gatesMet(task)) {
    await tx.execute(sql`
      update closing_task_instance set status = 'COMPLETED', updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${task.task_id}
    `);
    return 'COMPLETED';
  }
  return task.status;
}

export async function attachEvidence(input: {
  client: string; changedBy: string; cycle: CloseCycleKey; taskId: string; evidenceRef: string;
}): Promise<{ status: TaskStatus }> {
  const { client, changedBy, cycle, taskId } = input;
  checkCycle(cycle);
  const ref = input.evidenceRef.trim();
  if (!ref) fail('An evidence reference is required.');
  return withTenant(client, async (tx) => {
    await tx.execute(sql`
      update closing_task_instance set evidence_ref = ${ref.slice(0, 120)}, updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${taskId}
    `);
    await recordEvent(tx, client, cycle, taskId, 'EVIDENCE', changedBy, undefined, ref.slice(0, 120));
    const task = (await loadTasks(tx, client, cycle)).find((t) => t.task_id === taskId);
    if (!task) fail(`Task ${taskId} does not stand in this cycle.`);
    return { status: await maybeComplete(tx, client, cycle, task) };
  });
}

export async function signOffTask(input: {
  client: string; changedBy: string; cycle: CloseCycleKey; taskId: string;
}): Promise<{ status: TaskStatus }> {
  const { client, changedBy, cycle, taskId } = input;
  checkCycle(cycle);
  return withTenant(client, async (tx) => {
    await tx.execute(sql`
      update closing_task_instance set signed_off_by = ${changedBy}, signed_off_at = now(), updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${taskId}
    `);
    await recordEvent(tx, client, cycle, taskId, 'SIGNOFF', changedBy);
    const task = (await loadTasks(tx, client, cycle)).find((t) => t.task_id === taskId);
    if (!task) fail(`Task ${taskId} does not stand in this cycle.`);
    return { status: await maybeComplete(tx, client, cycle, task) };
  });
}

export async function overrideTaskStatus(input: {
  client: string; changedBy: string; cycle: CloseCycleKey; taskId: string;
  newStatus: TaskStatus; reason: string;
}): Promise<{ status: TaskStatus }> {
  const { client, changedBy, cycle, taskId } = input;
  checkCycle(cycle);
  if (!input.reason.trim()) fail('A reason is mandatory for a manual status override.', 'State why the status is set manually.');
  if (!TASK_STATUSES.includes(input.newStatus) || input.newStatus === 'RUNNING') {
    fail('Override target must be RELEASED, COMPLETED, ERROR or BLOCKED.');
  }
  return withTenant(client, async (tx) => {
    const tasks = await loadTasks(tx, client, cycle);
    const task = tasks.find((t) => t.task_id === taskId);
    if (!task) fail(`Task ${taskId} does not stand in this cycle.`);
    await tx.execute(sql`
      update closing_task_instance set status = ${input.newStatus}, updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${taskId}
    `);
    await recordEvent(tx, client, cycle, taskId, 'OVERRIDE', changedBy, input.reason.trim(),
      `${task.status} → ${input.newStatus}`);
    return { status: input.newStatus };
  });
}

export async function reopenTask(input: {
  client: string; changedBy: string; cycle: CloseCycleKey; taskId: string; reason: string;
}): Promise<{ status: TaskStatus; warning: string }> {
  const { client, changedBy, cycle, taskId } = input;
  checkCycle(cycle);
  if (!input.reason.trim()) fail('A reason is mandatory to reopen a completed task.');
  const warning = 'Rerunning may duplicate accounting effects of the earlier execution; its history is preserved.';
  return withTenant(client, async (tx) => {
    const tasks = await loadTasks(tx, client, cycle);
    const task = tasks.find((t) => t.task_id === taskId);
    if (!task) fail(`Task ${taskId} does not stand in this cycle.`);
    if (task.status !== 'COMPLETED') fail(`Task ${taskId} stands ${task.status}; only a completed task can be reopened.`);
    await tx.execute(sql`
      update closing_task_instance set status = 'RELEASED', updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and task_id = ${taskId}
    `);
    await recordEvent(tx, client, cycle, taskId, 'REOPENED', changedBy, input.reason.trim(), warning);
    return { status: 'RELEASED' as TaskStatus, warning };
  });
}

export async function finalizeTaskList(input: {
  client: string; changedBy: string; cycle: CloseCycleKey;
}): Promise<TaskListView> {
  const { client, changedBy, cycle } = input;
  checkCycle(cycle);
  return withTenant(client, async (tx) => {
    const list = await getTaskListIn(tx, client, cycle);
    if (list.status !== 'RELEASED') fail(`Task list stands ${list.status}; only a released list can be finalized.`);
    const tasks = await loadTasks(tx, client, cycle);
    const open = tasks.filter((t) => t.status !== 'COMPLETED');
    if (open.length > 0) {
      fail(`Task list cannot be finalized: ${open.map((t) => `${t.task_id} (${t.status})`).join(', ')} not completed.`,
        'Complete every task — finalization never closes or locks the period.');
    }
    await tx.execute(sql`
      update closing_task_list set status = 'FINALIZED', updated_by = ${changedBy}, updated_at = now()
      where client = ${client} and company_code = ${cycle.companyCode} and task_list_id = ${cycle.taskListId}
        and fiscal_year = ${cycle.fiscalYear} and posting_period = ${cycle.postingPeriod} and status = 'RELEASED'
    `);
    await recordEvent(tx, client, cycle, null, 'FINALIZED', changedBy, undefined,
      'Period remains open; finalization does not close or lock it.');
    return getTaskListIn(tx, client, cycle);
  });
}

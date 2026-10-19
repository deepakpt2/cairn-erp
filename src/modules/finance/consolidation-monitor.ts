/**
 * Consolidation monitor service (SCR-117 / FIN.CONSOLIDATE;
 * CX20 and UCMON search aliases).
 *
 * UCWB owns consolidation configuration. This service owns the
 * monitor matrix, execution attempts, current task status and
 * logs. It orchestrates only processing adapters that stand:
 * journal data collection and validation over the JOURNAL
 * provider. It never invents consolidation journals, currency
 * translations, investments or intercompany eliminations.
 */
export * from './consolidation-monitor-vocabulary';
import {
  CONSOLIDATE_CAPABILITY, SUPPORTED_TASK_TYPES,
  type ConsolidationExecutionMode, type ConsolidationExecutionStatus,
  type ConsolidationExecutionView, type ConsolidationMonitorSelection,
  type ConsolidationMonitorTaskRow, type ConsolidationMonitorView,
  type ConsolidationTaskStatus, type ConsolidationWarningPolicy,
} from './consolidation-monitor-vocabulary';

import { createHash } from 'node:crypto';

import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import {
  companyCode as foundationCompanyCode, fiscalYearPeriod, fiscalYearVariant,
} from '../foundation/schema';
import {
  consolidationAccountMapping, consolidationArea, consolidationExecution,
  consolidationExecutionLog, consolidationGroup, consolidationMethod,
  consolidationTask, consolidationTaskStatus, consolidationUnit,
  consolidationUnitAssignment, consolidationVersion,
} from './schema';

export class ConsolidationMonitorError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ConsolidationMonitorError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new ConsolidationMonitorError(message, remedy);
}

type AreaRow = typeof consolidationArea.$inferSelect;
type GroupRow = typeof consolidationGroup.$inferSelect;
type VersionRow = typeof consolidationVersion.$inferSelect;
type UnitRow = typeof consolidationUnit.$inferSelect;
type TaskRow = typeof consolidationTask.$inferSelect;
type MethodRow = typeof consolidationMethod.$inferSelect;
type ExecutionRow = typeof consolidationExecution.$inferSelect;
type StatusRow = typeof consolidationTaskStatus.$inferSelect;

interface ScopeData {
  selection: ConsolidationMonitorSelection;
  area: AreaRow;
  group: GroupRow;
  version: VersionRow;
  fiscalYearVariant: string;
  periodEnd: string;
  periodType: string;
  units: UnitRow[];
  tasks: TaskRow[];
  methods: Map<string, MethodRow>;
}

interface AdapterResult {
  status: Exclude<ConsolidationExecutionStatus, 'RUNNING' | 'BLOCKED' | 'CANCELLED'>;
  resultSummary: string;
  processedCount: number;
  warningCount: number;
  errorCount: number;
  generatedDocumentRefs: string[];
  logs: Array<{ level: 'INFO' | 'WARNING' | 'ERROR'; message: string; reference?: string }>;
}

function newRunId(): string {
  return `CX${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46656)
    .toString(36).toUpperCase().padStart(3, '0')}`.slice(0, 24);
}

function normalizeSelection(input: ConsolidationMonitorSelection): ConsolidationMonitorSelection {
  const selection: ConsolidationMonitorSelection = {
    area: (input.area ?? '').trim().toUpperCase(),
    group: (input.group ?? '').trim().toUpperCase(),
    version: (input.version ?? '').trim().toUpperCase(),
    fiscalYear: Number(input.fiscalYear),
    period: Number(input.period),
    taskGroup: (input.taskGroup ?? '').trim().toUpperCase(),
    unit: (input.unit ?? '').trim().toUpperCase(),
    mode: input.mode === 'UPDATE' ? 'UPDATE' : 'TEST',
    warningPolicy: input.warningPolicy === 'ALLOW_WARNINGS' ? 'ALLOW_WARNINGS' : 'BLOCK_ON_WARNING',
  };
  if (!selection.area) fail('A consolidation area is required.', 'Select a configured consolidation area.');
  if (!selection.group) fail('A consolidation group is required.', 'Select a configured group in the area.');
  if (!selection.version) fail('A consolidation version is required.', 'Select a configured version.');
  if (!Number.isInteger(selection.fiscalYear) || selection.fiscalYear < 1900 || selection.fiscalYear > 2199) {
    fail('A fiscal year between 1900 and 2199 is required.');
  }
  if (!Number.isInteger(selection.period) || selection.period < 1 || selection.period > 20) {
    fail('A posting period between 1 and 20 is required.');
  }
  return selection;
}

function periodEndDate(fiscalYear: number, period: { month: number; day: number; yearShift: number }): string {
  const year = fiscalYear + period.yearShift;
  const daysInMonth = new Date(Date.UTC(year, period.month, 0)).getUTCDate();
  const day = Math.min(Math.max(period.day, 1), daysInMonth);
  return new Date(Date.UTC(year, period.month - 1, day)).toISOString().slice(0, 10);
}

async function loadScopeForClient(tx: Tx, selection: ConsolidationMonitorSelection, client: string): Promise<ScopeData> {
  const [area] = await tx.select().from(consolidationArea).where(and(
    eq(consolidationArea.client, client), eq(consolidationArea.area, selection.area),
  ));
  if (!area) fail(`Consolidation area ${selection.area} does not stand.`, 'Configure the area in UCWB first.');
  if (area.status !== 'ACTIVE') {
    fail(`Consolidation area ${selection.area} is ${area.status}; only ACTIVE areas may be monitored or executed.`, 'Activate the area in UCWB after completing its configuration.');
  }

  const [group] = await tx.select().from(consolidationGroup).where(and(
    eq(consolidationGroup.client, client), eq(consolidationGroup.area, selection.area),
    eq(consolidationGroup.groupName, selection.group),
  ));
  if (!group) fail(`Consolidation group ${selection.group} does not stand in area ${selection.area}.`, 'Select a group configured for this area in UCWB.');

  const [version] = await tx.select().from(consolidationVersion).where(and(
    eq(consolidationVersion.client, client), eq(consolidationVersion.area, selection.area),
    eq(consolidationVersion.version, selection.version),
  ));
  if (!version) fail(`Consolidation version ${selection.version} does not stand in area ${selection.area}.`, 'Select a configured version.');

  const [variant] = await tx.select().from(fiscalYearVariant).where(and(
    eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, area.fiscalYearVariant),
  ));
  if (!variant) fail(`Fiscal year variant ${area.fiscalYearVariant} does not stand.`, 'Repair the area configuration in UCWB.');

  const periodRows = await tx.select().from(fiscalYearPeriod).where(and(
    eq(fiscalYearPeriod.client, client), eq(fiscalYearPeriod.variant, area.fiscalYearVariant),
    inArray(fiscalYearPeriod.calendarYear, variant.isYearDependent ? [selection.fiscalYear, 0] : [0]),
  ));
  const yearRows = periodRows.filter((row) => row.calendarYear === selection.fiscalYear);
  const effectiveRows = yearRows.length > 0 ? yearRows : periodRows.filter((row) => row.calendarYear === 0);
  const periodRow = effectiveRows.find((row) => row.period === selection.period);
  if (!periodRow) {
    fail(`Period ${selection.period} is not defined by fiscal year variant ${area.fiscalYearVariant} for ${selection.fiscalYear}.`, 'Choose a period the consolidation calendar defines.');
  }
  const periodEnd = periodEndDate(selection.fiscalYear, periodRow);

  const assigned = await tx.select({ unit: consolidationUnit })
    .from(consolidationUnit)
    .innerJoin(consolidationUnitAssignment, and(
      eq(consolidationUnitAssignment.client, client),
      eq(consolidationUnitAssignment.area, selection.area),
      eq(consolidationUnitAssignment.groupName, selection.group),
      eq(consolidationUnitAssignment.unit, consolidationUnit.unit),
      lte(consolidationUnitAssignment.validFrom, periodEnd),
      gte(consolidationUnitAssignment.validTo, periodEnd),
    ))
    .where(and(eq(consolidationUnit.client, client), eq(consolidationUnit.area, selection.area)))
    .orderBy(asc(consolidationUnit.unit));
  const units = assigned.map((row) => row.unit);
  if (units.length === 0) {
    fail(`No consolidation units are assigned to group ${selection.group} for ${periodEnd}.`, 'Assign a unit to the group for this period in UCWB.');
  }
  if (selection.unit && !units.some((unit) => unit.unit === selection.unit)) {
    fail(`Consolidation unit ${selection.unit} is not assigned to group ${selection.group} for ${periodEnd}.`, 'Filter to a unit inside the selected group.');
  }

  const tasks = await tx.select().from(consolidationTask).where(and(
    eq(consolidationTask.client, client), eq(consolidationTask.area, selection.area),
    eq(consolidationTask.version, selection.version),
  )).orderBy(asc(consolidationTask.sequence), asc(consolidationTask.task));
  if (selection.taskGroup && !tasks.some((task) => task.task === selection.taskGroup && !task.parentTask)) {
    fail(`Task group ${selection.taskGroup} is not a root task in version ${selection.version}.`, 'Choose a configured root task, or clear the task-group filter.');
  }

  const methods = await tx.select().from(consolidationMethod).where(and(
    eq(consolidationMethod.client, client), eq(consolidationMethod.area, selection.area),
  ));

  return {
    selection,
    area,
    group,
    version,
    fiscalYearVariant: area.fiscalYearVariant,
    periodEnd,
    periodType: periodRow.periodType,
    units,
    tasks,
    methods: new Map(methods.map((method) => [method.method, method])),
  };
}

function taskRelevantToUnit(task: TaskRow, selection: ConsolidationMonitorSelection, unit: string): boolean {
  return (!task.unit || task.unit === unit) && (!task.groupName || task.groupName === selection.group);
}

function subtreeTasks(tasks: TaskRow[], root: string): TaskRow[] {
  if (!root) return tasks;
  const children = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (task.parentTask) children.set(task.parentTask, [...(children.get(task.parentTask) ?? []), task]);
  }
  const included = new Set<string>();
  const visit = (taskId: string) => {
    included.add(taskId);
    for (const child of children.get(taskId) ?? []) visit(child.task);
  };
  visit(root);
  return tasks.filter((task) => included.has(task.task));
}

function orderedTasks(tasks: TaskRow[]): TaskRow[] {
  const byId = new Map(tasks.map((task) => [task.task, task]));
  const children = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (task.parentTask && byId.has(task.parentTask)) {
      children.set(task.parentTask, [...(children.get(task.parentTask) ?? []), task]);
    }
  }
  const sort = (rows: TaskRow[]) => [...rows].sort((a, b) => a.sequence - b.sequence || a.task.localeCompare(b.task));
  const result: TaskRow[] = [];
  const visiting = new Set<string>();
  const visit = (task: TaskRow) => {
    if (visiting.has(task.task)) return;
    visiting.add(task.task);
    result.push(task);
    for (const child of sort(children.get(task.task) ?? [])) visit(child);
  };
  for (const root of sort(tasks.filter((task) => !task.parentTask || !byId.has(task.parentTask)))) visit(root);
  return result;
}

function configurationSnapshot(scope: ScopeData, task: TaskRow): { fingerprint: string; snapshot: string } {
  const method = task.method ? scope.methods.get(task.method) : undefined;
  const snapshotObject = {
    area: scope.area.area,
    areaStatus: scope.area.status,
    dataBasis: scope.area.dataBasis,
    consChart: scope.area.consChart,
    fiscalYearVariant: scope.area.fiscalYearVariant,
    version: scope.selection.version,
    task: task.task,
    parentTask: task.parentTask,
    sequence: task.sequence,
    taskType: task.taskType,
    method: task.method,
    methodKind: method?.kind,
    unit: task.unit,
    group: task.groupName,
    validFrom: task.validFrom,
    validTo: task.validTo,
    updatedAt: task.updatedAt,
  };
  const snapshot = JSON.stringify(snapshotObject);
  return { fingerprint: createHash('sha256').update(snapshot).digest('hex'), snapshot };
}

function formatTime(value: Date | string | null): string {
  if (!value) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function executionView(row: ExecutionRow, logs: Array<typeof consolidationExecutionLog.$inferSelect> = []): ConsolidationExecutionView {
  let generatedDocumentRefs: string[] = [];
  try {
    const parsed = JSON.parse(row.generatedDocumentRefs) as unknown;
    if (Array.isArray(parsed)) generatedDocumentRefs = parsed.map(String);
  } catch {
    generatedDocumentRefs = row.generatedDocumentRefs ? [row.generatedDocumentRefs] : [];
  }
  return {
    runId: row.runId,
    area: row.area,
    group: row.groupName,
    unit: row.unit ?? '',
    version: row.version,
    fiscalYear: row.fiscalYear,
    period: row.period,
    task: row.task,
    mode: row.mode as ConsolidationExecutionMode,
    status: row.status as ConsolidationExecutionStatus,
    executedBy: row.executedBy,
    startedAt: formatTime(row.startedAt),
    endedAt: formatTime(row.endedAt),
    durationMs: row.durationMs,
    resultSummary: row.resultSummary,
    processedCount: row.processedCount,
    warningCount: row.warningCount,
    errorCount: row.errorCount,
    generatedDocumentRefs,
    logs: logs.map((log) => ({
      sequence: log.sequence,
      level: log.level as 'INFO' | 'WARNING' | 'ERROR',
      message: log.message,
      reference: log.reference ?? '',
    })),
  };
}

function latestModeRun(executions: ExecutionRow[], task: string, unitScope: string, mode: ConsolidationExecutionMode): ExecutionRow | undefined {
  return executions.find((row) => row.task === task && row.unitScope === unitScope && row.mode === mode);
}

function dependencyReason(
  scope: ScopeData,
  task: TaskRow,
  unit: string,
  executions: ExecutionRow[],
  mode: ConsolidationExecutionMode,
  warningPolicy: ConsolidationWarningPolicy,
): string {
  if (!task.parentTask) return '';
  const parent = scope.tasks.find((candidate) => candidate.task === task.parentTask);
  if (!parent) return `Prerequisite task ${task.parentTask} does not stand in version ${scope.selection.version}.`;
  if (!taskRelevantToUnit(parent, scope.selection, unit)) {
    return `Prerequisite task ${task.parentTask} is not configured for unit ${unit} in group ${scope.selection.group}.`;
  }
  const latest = latestModeRun(executions, parent.task, unit, mode);
  if (!latest) return `Prerequisite task ${parent.task} has no ${mode} run for this scope.`;
  if (latest.status === 'COMPLETED') return '';
  if (latest.status === 'WARNING') {
    return warningPolicy === 'ALLOW_WARNINGS'
      ? ''
      : `Prerequisite task ${parent.task} completed with warnings; the warning policy blocks downstream execution.`;
  }
  return `Prerequisite task ${parent.task} is ${latest.status.toLowerCase()} for this scope.`;
}

function taskBlockedReason(
  scope: ScopeData,
  task: TaskRow,
  unit: string,
  executions: ExecutionRow[],
  mode: ConsolidationExecutionMode,
  warningPolicy: ConsolidationWarningPolicy,
): string {
  if (!(SUPPORTED_TASK_TYPES as readonly string[]).includes(task.taskType)) {
    return `No consolidation processing adapter stands for ${task.taskType}; its engine is deferred, so CX20 does not invent a result.`;
  }
  if (task.validFrom > scope.periodEnd || task.validTo < scope.periodEnd) {
    return `Task ${task.task} is valid ${task.validFrom} to ${task.validTo}; period end ${scope.periodEnd} stands outside that interval.`;
  }
  return dependencyReason(scope, task, unit, executions, mode, warningPolicy);
}

async function loadExecutions(tx: Tx, client: string, selection: ConsolidationMonitorSelection, limit = 100): Promise<ExecutionRow[]> {
  return tx.select().from(consolidationExecution).where(and(
    eq(consolidationExecution.client, client), eq(consolidationExecution.area, selection.area),
    eq(consolidationExecution.groupName, selection.group), eq(consolidationExecution.version, selection.version),
    eq(consolidationExecution.fiscalYear, selection.fiscalYear), eq(consolidationExecution.period, selection.period),
  )).orderBy(desc(consolidationExecution.startedAt), desc(consolidationExecution.runId)).limit(limit);
}

async function upsertStatus(tx: Tx, client: string, values: typeof consolidationTaskStatus.$inferInsert): Promise<void> {
  await tx.insert(consolidationTaskStatus).values(values).onConflictDoUpdate({
    target: [
      consolidationTaskStatus.client, consolidationTaskStatus.area, consolidationTaskStatus.groupName,
      consolidationTaskStatus.unitScope, consolidationTaskStatus.version, consolidationTaskStatus.fiscalYear,
      consolidationTaskStatus.period, consolidationTaskStatus.task,
    ],
    set: {
      status: values.status,
      blockedReason: values.blockedReason,
      latestRunId: values.latestRunId,
      lastMode: values.lastMode,
      executedBy: values.executedBy,
      executedAt: values.executedAt,
      durationMs: values.durationMs,
      resultSummary: values.resultSummary,
      warningCount: values.warningCount,
      errorCount: values.errorCount,
      attemptCount: values.attemptCount,
      updatedAt: new Date(),
    },
  });
}

async function attemptNumber(tx: Tx, client: string, selection: ConsolidationMonitorSelection, unit: string, task: string): Promise<number> {
  const rows = await tx.select({ runId: consolidationExecution.runId }).from(consolidationExecution).where(and(
    eq(consolidationExecution.client, client), eq(consolidationExecution.area, selection.area),
    eq(consolidationExecution.groupName, selection.group), eq(consolidationExecution.unitScope, unit),
    eq(consolidationExecution.version, selection.version), eq(consolidationExecution.fiscalYear, selection.fiscalYear),
    eq(consolidationExecution.period, selection.period), eq(consolidationExecution.task, task),
  ));
  return rows.length + 1;
}

async function recordBlockedAttempt(
  tx: Tx,
  client: string,
  scope: ScopeData,
  task: TaskRow,
  unit: string,
  mode: ConsolidationExecutionMode,
  executedBy: string,
  reason: string,
): Promise<ConsolidationExecutionView> {
  const now = new Date();
  const { fingerprint, snapshot } = configurationSnapshot(scope, task);
  const attempt = await attemptNumber(tx, client, scope.selection, unit, task.task);
  const runId = newRunId();
  const [row] = await tx.insert(consolidationExecution).values({
    client, runId, area: scope.selection.area, groupName: scope.selection.group,
    unit: unit || null, unitScope: unit, version: scope.selection.version,
    fiscalYear: scope.selection.fiscalYear, period: scope.selection.period, task: task.task,
    configurationVersion: fingerprint, configurationSnapshot: snapshot, attemptNumber: attempt,
    mode, status: 'BLOCKED', executedBy, startedAt: now, endedAt: now, durationMs: 0,
    resultSummary: reason, processedCount: 0, warningCount: 1, errorCount: 0,
    generatedDocumentRefs: '[]',
  }).returning();
  await tx.insert(consolidationExecutionLog).values({
    client, runId, sequence: 1, level: 'WARNING', message: reason, reference: task.task,
  });

  const [current] = await tx.select().from(consolidationTaskStatus).where(and(
    eq(consolidationTaskStatus.client, client), eq(consolidationTaskStatus.area, scope.selection.area),
    eq(consolidationTaskStatus.groupName, scope.selection.group), eq(consolidationTaskStatus.unitScope, unit),
    eq(consolidationTaskStatus.version, scope.selection.version),
    eq(consolidationTaskStatus.fiscalYear, scope.selection.fiscalYear),
    eq(consolidationTaskStatus.period, scope.selection.period), eq(consolidationTaskStatus.task, task.task),
  ));
  if (current?.status !== 'RUNNING') {
    await upsertStatus(tx, client, {
      client, area: scope.selection.area, groupName: scope.selection.group,
      unit: unit || null, unitScope: unit, version: scope.selection.version,
      fiscalYear: scope.selection.fiscalYear, period: scope.selection.period, task: task.task,
      status: 'BLOCKED', blockedReason: reason, latestRunId: runId, lastMode: mode,
      executedBy, executedAt: now, durationMs: 0, resultSummary: reason,
      warningCount: 1, errorCount: 0, attemptCount: attempt,
    });
  }
  return executionView(row!, [{
    client, runId, sequence: 1, level: 'WARNING', message: reason, reference: task.task, createdAt: now,
  }]);
}

async function runAdapter(client: string, scope: ScopeData, task: TaskRow, unitRow: UnitRow, mode: ConsolidationExecutionMode): Promise<AdapterResult> {
  return withTenant(client, async (tx) => {
    const [company] = await tx.select().from(foundationCompanyCode).where(and(
      eq(foundationCompanyCode.client, client), eq(foundationCompanyCode.companyCode, unitRow.companyCode),
    ));
    if (!company) {
      return {
        status: 'ERROR' as const,
        resultSummary: `Company code ${unitRow.companyCode} for unit ${unitRow.unit} does not stand.`,
        processedCount: 0, warningCount: 0, errorCount: 1, generatedDocumentRefs: [],
        logs: [{ level: 'ERROR' as const, message: `Company code ${unitRow.companyCode} does not stand.`, reference: unitRow.unit }],
      };
    }

    if (task.taskType === 'DATA_COLLECTION') {
      const rows = await tx.execute(sql`
        select count(distinct e.document_number)::int as documents,
               count(l.document_number)::int as lines
        from journal_entry e
        left join journal_entry_line l
          on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
        where e.client = ${client} and e.company_code = ${unitRow.companyCode}
          and e.fiscal_year = ${scope.selection.fiscalYear} and e.posting_period = ${scope.selection.period}
          and e.status = 'POSTED'
      `) as unknown as Array<{ documents: number; lines: number }>;
      const documents = rows[0]?.documents ?? 0;
      const lines = rows[0]?.lines ?? 0;
      const warningCount = lines === 0 ? 1 : 0;
      return {
        status: lines === 0 ? 'WARNING' as const : 'COMPLETED' as const,
        resultSummary: `${mode === 'TEST' ? 'Test run simulated' : 'Update run completed'} data collection for unit ${unitRow.unit}: ${lines} journal line(s) from ${documents} posted document(s); no accounting posting was generated.`,
        processedCount: lines,
        warningCount,
        errorCount: 0,
        generatedDocumentRefs: [],
        logs: [
          { level: 'INFO' as const, message: `JOURNAL provider read company ${unitRow.companyCode} for fiscal year ${scope.selection.fiscalYear}, period ${scope.selection.period}.`, reference: unitRow.unit },
          ...(lines === 0 ? [{ level: 'WARNING' as const, message: 'No posted journal lines stand for this unit and period.', reference: unitRow.unit }] : []),
        ],
      };
    }

    // VALIDATION
    const rows = await tx.execute(sql`
      select count(l.document_number)::int as lines,
             count(l.document_number) filter (
               where not exists (
                 select 1 from consolidation_account_mapping m
                 where m.client = ${client} and m.cons_chart = ${scope.area.consChart}
                   and m.source_chart = ${company.chartOfAccounts ?? ''}
                   and l.gl_account between m.source_from and m.source_to
               )
             )::int as unmapped
      from journal_entry e
      left join journal_entry_line l
        on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
      where e.client = ${client} and e.company_code = ${unitRow.companyCode}
        and e.fiscal_year = ${scope.selection.fiscalYear} and e.posting_period = ${scope.selection.period}
        and e.status = 'POSTED'
    `) as unknown as Array<{ lines: number; unmapped: number }>;
    const mappings = await tx.select({ sourceFrom: consolidationAccountMapping.sourceFrom })
      .from(consolidationAccountMapping).where(and(
        eq(consolidationAccountMapping.client, client), eq(consolidationAccountMapping.consChart, scope.area.consChart),
      ));
    const lines = rows[0]?.lines ?? 0;
    const unmapped = rows[0]?.unmapped ?? 0;
    const warnings: AdapterResult['logs'] = [];
    if (mappings.length === 0) warnings.push({ level: 'WARNING', message: `No account mappings stand for consolidation chart ${scope.area.consChart}.`, reference: scope.area.consChart });
    if (lines === 0) warnings.push({ level: 'WARNING', message: 'No posted journal lines stand to validate for this unit and period.', reference: unitRow.unit });
    if (unmapped > 0) warnings.push({ level: 'WARNING', message: `${unmapped} journal line(s) fall outside the configured source-account mappings.`, reference: unitRow.unit });
    return {
      status: warnings.length > 0 ? 'WARNING' as const : 'COMPLETED' as const,
      resultSummary: `${mode === 'TEST' ? 'Test run simulated' : 'Update run completed'} validation for unit ${unitRow.unit}: ${lines} journal line(s), ${unmapped} unmapped, ${mappings.length} mapping range(s).`,
      processedCount: lines,
      warningCount: warnings.filter((log) => log.level === 'WARNING').length,
      errorCount: 0,
      generatedDocumentRefs: [],
      logs: [
        { level: 'INFO' as const, message: `Validated UCWB configuration and JOURNAL data for company ${unitRow.companyCode}.`, reference: task.task },
        ...warnings,
      ],
    };
  });
}

export async function getConsolidationMonitor(
  client: string,
  rawSelection: ConsolidationMonitorSelection,
  includeLogs = false,
): Promise<ConsolidationMonitorView> {
  const selection = normalizeSelection(rawSelection);
  const { scope, statuses, executions } = await withTenant(client, async (tx) => {
    const loadedScope = await loadScopeForClient(tx, selection, client);
    const statusRows = await tx.select().from(consolidationTaskStatus).where(and(
      eq(consolidationTaskStatus.client, client), eq(consolidationTaskStatus.area, selection.area),
      eq(consolidationTaskStatus.groupName, selection.group), eq(consolidationTaskStatus.version, selection.version),
      eq(consolidationTaskStatus.fiscalYear, selection.fiscalYear), eq(consolidationTaskStatus.period, selection.period),
    ));
    const executionRows = await loadExecutions(tx, client, selection, 100);
    return { scope: loadedScope, statuses: statusRows, executions: executionRows };
  });

  const logsByRun = new Map<string, Array<typeof consolidationExecutionLog.$inferSelect>>();
  if (includeLogs && executions.length > 0) {
    const logs = await withTenant(client, async (tx) => tx.select().from(consolidationExecutionLog).where(and(
      eq(consolidationExecutionLog.client, client),
      inArray(consolidationExecutionLog.runId, executions.map((row) => row.runId)),
    )).orderBy(asc(consolidationExecutionLog.runId), asc(consolidationExecutionLog.sequence)));
    for (const log of logs) logsByRun.set(log.runId, [...(logsByRun.get(log.runId) ?? []), log]);
  }

  const statusByKey = new Map(statuses.map((row) => [`${row.unitScope}|${row.task}`, row]));
  const filteredUnits = scope.units.filter((unit) => !selection.unit || unit.unit === selection.unit);
  const visibleTasks = subtreeTasks(scope.tasks, selection.taskGroup);
  const rows: ConsolidationMonitorTaskRow[] = [];
  for (const unit of filteredUnits) {
    for (const task of orderedTasks(visibleTasks.filter((candidate) => taskRelevantToUnit(candidate, selection, unit.unit)))) {
      const status = statusByKey.get(`${unit.unit}|${task.task}`);
      const blockedReason = taskBlockedReason(scope, task, unit.unit, executions, selection.mode, selection.warningPolicy);
      const statusValue: ConsolidationTaskStatus = status?.status === 'RUNNING'
        ? 'RUNNING'
        : blockedReason
          ? 'BLOCKED'
          : (status?.status as ConsolidationTaskStatus | undefined) ?? 'OPEN';
      rows.push({
        unit: unit.unit,
        unitTitle: unit.title,
        companyCode: unit.companyCode,
        task: task.task,
        parentTask: task.parentTask ?? '',
        sequence: task.sequence,
        taskType: task.taskType,
        method: task.method ?? '',
        status: statusValue,
        blockedReason,
        latestRunId: status?.latestRunId ?? '',
        lastMode: (status?.lastMode as ConsolidationExecutionMode | null) ?? '',
        executedBy: status?.executedBy ?? '',
        executedAt: formatTime(status?.executedAt ?? null),
        durationMs: status?.durationMs ?? null,
        resultSummary: status?.resultSummary ?? '',
        warningCount: status?.warningCount ?? 0,
        errorCount: status?.errorCount ?? 0,
        attemptCount: status?.attemptCount ?? 0,
      });
    }
  }

  const visibleUnitSet = new Set(filteredUnits.map((unit) => unit.unit));
  const visibleTaskSet = new Set(visibleTasks.map((task) => task.task));
  return {
    selection,
    areaTitle: scope.area.title,
    areaStatus: scope.area.status,
    fiscalYearVariant: scope.fiscalYearVariant,
    periodLabel: `${selection.fiscalYear} / period ${selection.period} (${scope.periodType.toLowerCase()}, ends ${scope.periodEnd}) · variant ${scope.fiscalYearVariant}`,
    rows,
    executions: executions
      .filter((row) => visibleTaskSet.has(row.task) && (!row.unit || visibleUnitSet.has(row.unit)))
      .slice(0, 20)
      .map((row) => executionView(row, includeLogs ? logsByRun.get(row.runId) ?? [] : [])),
  };
}

export async function executeConsolidationTask(input: {
  client: string;
  executedBy: string;
  selection: ConsolidationMonitorSelection;
  task: string;
  unit: string;
}): Promise<ConsolidationExecutionView> {
  const selection = normalizeSelection(input.selection);
  const taskId = input.task.trim().toUpperCase();
  const unitId = input.unit.trim().toUpperCase();

  const reserved = await withTenant(input.client, async (tx) => {
    const scope = await loadScopeForClient(tx, selection, input.client);
    const unit = scope.units.find((candidate) => candidate.unit === unitId);
    if (!unit) fail(`Consolidation unit ${unitId} is not in the selected monitor scope.`);
    const task = scope.tasks.find((candidate) => candidate.task === taskId);
    if (!task) fail(`Task ${taskId} does not stand in version ${selection.version}.`);
    if (!taskRelevantToUnit(task, selection, unitId)) {
      fail(`Task ${taskId} is not configured for unit ${unitId} in group ${selection.group}.`);
    }

    const executions = await loadExecutions(tx, input.client, selection, 500);
    const running = executions.find((row) => row.task === taskId && row.unitScope === unitId && row.status === 'RUNNING');
    if (running) {
      const blocked = await recordBlockedAttempt(tx, input.client, scope, task, unitId, selection.mode, input.executedBy,
        `Task ${taskId} is already running for this scope in run ${running.runId}; duplicate simultaneous execution is refused.`);
      return { kind: 'done' as const, execution: blocked };
    }
    const blockedReason = taskBlockedReason(scope, task, unitId, executions, selection.mode, selection.warningPolicy);
    if (blockedReason) {
      const blocked = await recordBlockedAttempt(tx, input.client, scope, task, unitId, selection.mode, input.executedBy, blockedReason);
      return { kind: 'done' as const, execution: blocked };
    }

    const { fingerprint, snapshot } = configurationSnapshot(scope, task);
    const attempt = await attemptNumber(tx, input.client, selection, unitId, taskId);
    const runId = newRunId();
    const startedAt = new Date();
    const [row] = await tx.insert(consolidationExecution).values({
      client: input.client, runId, area: selection.area, groupName: selection.group,
      unit: unitId || null, unitScope: unitId, version: selection.version,
      fiscalYear: selection.fiscalYear, period: selection.period, task: taskId,
      configurationVersion: fingerprint, configurationSnapshot: snapshot, attemptNumber: attempt,
      mode: selection.mode, status: 'RUNNING', executedBy: input.executedBy, startedAt,
      resultSummary: `Run ${runId} started.`, generatedDocumentRefs: '[]',
    }).returning();
    await tx.insert(consolidationExecutionLog).values({
      client: input.client, runId, sequence: 1, level: 'INFO',
      message: `${selection.mode} run started for task ${taskId}; dependencies were revalidated under the run reservation.`,
      reference: taskId,
    });
    await upsertStatus(tx, input.client, {
      client: input.client, area: selection.area, groupName: selection.group,
      unit: unitId || null, unitScope: unitId, version: selection.version,
      fiscalYear: selection.fiscalYear, period: selection.period, task: taskId,
      status: 'RUNNING', blockedReason: '', latestRunId: runId, lastMode: selection.mode,
      executedBy: input.executedBy, executedAt: startedAt, durationMs: null,
      resultSummary: `Run ${runId} started.`, warningCount: 0, errorCount: 0, attemptCount: attempt,
    });
    return { kind: 'running' as const, execution: executionView(row!), scope, task, unit, startedAt };
  });
  if (reserved.kind === 'done') return reserved.execution;

  let result: AdapterResult;
  try {
    result = await runAdapter(input.client, reserved.scope, reserved.task, reserved.unit, selection.mode);
  } catch (error) {
    result = {
      status: 'ERROR',
      resultSummary: error instanceof Error ? error.message : 'The consolidation task failed.',
      processedCount: 0,
      warningCount: 0,
      errorCount: 1,
      generatedDocumentRefs: [],
      logs: [{ level: 'ERROR', message: error instanceof Error ? error.message : 'The consolidation task failed.', reference: taskId }],
    };
  }

  return withTenant(input.client, async (tx) => {
    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - reserved.startedAt.getTime());
    const [row] = await tx.update(consolidationExecution).set({
      status: result.status,
      endedAt,
      durationMs,
      resultSummary: result.resultSummary,
      processedCount: result.processedCount,
      warningCount: result.warningCount,
      errorCount: result.errorCount,
      generatedDocumentRefs: JSON.stringify(result.generatedDocumentRefs),
    }).where(and(
      eq(consolidationExecution.client, input.client), eq(consolidationExecution.runId, reserved.execution.runId),
    )).returning();
    const logs = result.logs.map((log, index) => ({
      client: input.client,
      runId: reserved.execution.runId,
      sequence: index + 2,
      level: log.level,
      message: log.message,
      reference: log.reference ?? null,
    }));
    if (logs.length > 0) await tx.insert(consolidationExecutionLog).values(logs);
    const attempt = row?.attemptNumber ?? 1;
    await upsertStatus(tx, input.client, {
      client: input.client, area: selection.area, groupName: selection.group,
      unit: unitId || null, unitScope: unitId, version: selection.version,
      fiscalYear: selection.fiscalYear, period: selection.period, task: taskId,
      status: result.status === 'COMPLETED' ? 'COMPLETED' : result.status,
      blockedReason: '', latestRunId: reserved.execution.runId, lastMode: selection.mode,
      executedBy: input.executedBy, executedAt: endedAt, durationMs,
      resultSummary: result.resultSummary, warningCount: result.warningCount,
      errorCount: result.errorCount, attemptCount: attempt,
    });
    const allLogs = await tx.select().from(consolidationExecutionLog).where(and(
      eq(consolidationExecutionLog.client, input.client), eq(consolidationExecutionLog.runId, reserved.execution.runId),
    )).orderBy(asc(consolidationExecutionLog.sequence));
    return executionView(row!, allLogs);
  });
}

export async function executeConsolidationTaskGroup(input: {
  client: string;
  executedBy: string;
  selection: ConsolidationMonitorSelection;
  taskGroup: string;
  errorPolicy: 'STOP_ON_ERROR' | 'CONTINUE_ON_ERROR';
}): Promise<{ runs: ConsolidationExecutionView[]; stopped: boolean }> {
  const selection = normalizeSelection({ ...input.selection, taskGroup: input.taskGroup });
  const plan = await withTenant(input.client, async (tx) => {
    const scope = await loadScopeForClient(tx, selection, input.client);
    const root = scope.tasks.find((task) => task.task === selection.taskGroup && !task.parentTask);
    if (!root) fail(`Task group ${selection.taskGroup} is not a root task.`);
    const tasks = orderedTasks(subtreeTasks(scope.tasks, root.task));
    const units = scope.units.filter((unit) => !selection.unit || unit.unit === selection.unit);
    return { tasks, units };
  });

  const runs: ConsolidationExecutionView[] = [];
  for (const unit of plan.units) {
    for (const task of plan.tasks) {
      if (!taskRelevantToUnit(task, selection, unit.unit)) continue;
      const run = await executeConsolidationTask({
        client: input.client,
        executedBy: input.executedBy,
        selection,
        task: task.task,
        unit: unit.unit,
      });
      runs.push(run);
      if ((run.status === 'ERROR' || run.status === 'BLOCKED') && input.errorPolicy === 'STOP_ON_ERROR') {
        return { runs, stopped: true };
      }
    }
  }
  return { runs, stopped: false };
}

export async function cancelConsolidationExecution(input: {
  client: string;
  executedBy: string;
  runId: string;
}): Promise<ConsolidationExecutionView> {
  const runId = input.runId.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(consolidationExecution).where(and(
      eq(consolidationExecution.client, input.client), eq(consolidationExecution.runId, runId),
    ));
    if (!row) fail(`Consolidation run ${runId} does not stand.`);
    if (row.status !== 'RUNNING') fail(`Consolidation run ${runId} is ${row.status}; only a running attempt can be cancelled.`);
    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - new Date(row.startedAt).getTime());
    const [updated] = await tx.update(consolidationExecution).set({
      status: 'CANCELLED', endedAt, durationMs,
      resultSummary: `Run ${runId} was cancelled by ${input.executedBy}; it is not completed and may be retried.`,
      errorCount: 0,
    }).where(and(
      eq(consolidationExecution.client, input.client), eq(consolidationExecution.runId, runId),
    )).returning();
    const existingLogs = await tx.select().from(consolidationExecutionLog).where(and(
      eq(consolidationExecutionLog.client, input.client), eq(consolidationExecutionLog.runId, runId),
    )).orderBy(desc(consolidationExecutionLog.sequence));
    await tx.insert(consolidationExecutionLog).values({
      client: input.client, runId, sequence: (existingLogs[0]?.sequence ?? 0) + 1,
      level: 'WARNING', message: `Run cancelled by ${input.executedBy}; no task completion was recorded.`, reference: row.task,
    });
    await tx.update(consolidationTaskStatus).set({
      status: 'OPEN', blockedReason: '', executedAt: endedAt, durationMs,
      resultSummary: updated!.resultSummary, warningCount: 1, updatedAt: endedAt,
    }).where(and(
      eq(consolidationTaskStatus.client, input.client), eq(consolidationTaskStatus.latestRunId, runId),
    ));
    const logs = await tx.select().from(consolidationExecutionLog).where(and(
      eq(consolidationExecutionLog.client, input.client), eq(consolidationExecutionLog.runId, runId),
    )).orderBy(asc(consolidationExecutionLog.sequence));
    return executionView(updated!, logs);
  });
}

export { CONSOLIDATE_CAPABILITY };

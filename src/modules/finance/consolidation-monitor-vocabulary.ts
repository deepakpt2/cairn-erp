/**
 * Consolidation monitor vocabulary (SCR-117 / FIN.CONSOLIDATE;
 * CX20 and UCMON search aliases).
 *
 * The monitor is the execution and status interface for the
 * configuration UCWB owns. It never maintains task definitions:
 * area, group, unit, version, method and task hierarchy all come
 * from the consolidation workbench. This module is client-safe;
 * the execution service lives in consolidation-monitor.ts.
 */

export const CONSOLIDATE_CAPABILITY = 'FIN.CONSOLIDATE';
export const CONSOLIDATION_MONITOR_ROUTE = '/finance/consolidation-monitor';

export const CONSOLIDATION_MONITOR_AUTHORITIES = {
  view: CONSOLIDATE_CAPABILITY,
  test: `${CONSOLIDATE_CAPABILITY}.TEST`,
  update: `${CONSOLIDATE_CAPABILITY}.UPDATE`,
  logs: `${CONSOLIDATE_CAPABILITY}.LOGS`,
  periodControl: 'FIN.CLOSE.PERIOD',
} as const;

export const EXECUTION_MODES = ['TEST', 'UPDATE'] as const;
export type ConsolidationExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_MODE_LABELS: Record<ConsolidationExecutionMode, string> = {
  TEST: 'Test Run',
  UPDATE: 'Update Run',
};

export const MONITOR_TASK_STATUSES = [
  'OPEN', 'BLOCKED', 'RUNNING', 'COMPLETED', 'WARNING', 'ERROR',
] as const;
export type ConsolidationTaskStatus = (typeof MONITOR_TASK_STATUSES)[number];

export const EXECUTION_STATUSES = [
  'RUNNING', 'COMPLETED', 'WARNING', 'ERROR', 'BLOCKED', 'CANCELLED',
] as const;
export type ConsolidationExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const ERROR_POLICIES = ['STOP_ON_ERROR', 'CONTINUE_ON_ERROR'] as const;
export type ConsolidationErrorPolicy = (typeof ERROR_POLICIES)[number];

export const WARNING_POLICIES = ['BLOCK_ON_WARNING', 'ALLOW_WARNINGS'] as const;
export type ConsolidationWarningPolicy = (typeof WARNING_POLICIES)[number];

/**
 * Processing adapters that stand in this round. The monitor
 * orchestrates; it does not invent consolidation calculations.
 * Translation, investment and intercompany adapters arrive with
 * their engines (intercompany last, B-663).
 */
export const SUPPORTED_TASK_TYPES = ['DATA_COLLECTION', 'VALIDATION'] as const;
export type SupportedTaskType = (typeof SUPPORTED_TASK_TYPES)[number];

export interface ConsolidationMonitorSelection {
  area: string;
  group: string;
  version: string;
  fiscalYear: number;
  period: number;
  /** Optional root task used as the configured task-group filter. */
  taskGroup: string;
  /** Optional consolidation unit inside the selected group. */
  unit: string;
  mode: ConsolidationExecutionMode;
  warningPolicy: ConsolidationWarningPolicy;
}

export interface ConsolidationMonitorOptions {
  areas: Array<{ area: string; title: string; status: string; fiscalYearVariant: string }>;
  groups: Array<{ group: string; title: string; parentGroup: string }>;
  versions: Array<{ version: string; title: string }>;
  units: Array<{ unit: string; title: string; companyCode: string }>;
  rootTasks: Array<{ task: string; taskType: string; sequence: number }>;
}

export interface ConsolidationMonitorTaskRow {
  unit: string;
  unitTitle: string;
  companyCode: string;
  task: string;
  parentTask: string;
  sequence: number;
  taskType: string;
  method: string;
  status: ConsolidationTaskStatus;
  blockedReason: string;
  latestRunId: string;
  lastMode: ConsolidationExecutionMode | '';
  executedBy: string;
  executedAt: string;
  durationMs: number | null;
  resultSummary: string;
  warningCount: number;
  errorCount: number;
  attemptCount: number;
}

export interface ConsolidationExecutionLogView {
  sequence: number;
  level: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  reference: string;
}

export interface ConsolidationExecutionView {
  runId: string;
  area: string;
  group: string;
  unit: string;
  version: string;
  fiscalYear: number;
  period: number;
  task: string;
  mode: ConsolidationExecutionMode;
  status: ConsolidationExecutionStatus;
  executedBy: string;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  resultSummary: string;
  processedCount: number;
  warningCount: number;
  errorCount: number;
  generatedDocumentRefs: string[];
  logs: ConsolidationExecutionLogView[];
}

export interface ConsolidationMonitorView {
  selection: ConsolidationMonitorSelection;
  areaTitle: string;
  areaStatus: string;
  fiscalYearVariant: string;
  periodLabel: string;
  rows: ConsolidationMonitorTaskRow[];
  executions: ConsolidationExecutionView[];
}

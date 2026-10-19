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

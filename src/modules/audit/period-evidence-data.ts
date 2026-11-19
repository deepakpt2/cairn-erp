/**
 * Period-close evidence pack: what the system actually knows, read from ONE snapshot.
 *
 * `collectEvidence` must be called inside `withTenantSnapshot` (REPEATABLE READ) so every section sees the
 * same database state; the snapshot timestamp is the database's own clock, taken by the first statement of
 * that transaction. It only reads. It never closes, reopens, posts or modifies anything.
 *
 * Truth rules baked in here:
 *   - the posting-period variant is the CURRENT assignment; history of assignment is not proven;
 *   - a missing account-type rule is UNKNOWN/NOT_CONFIGURED, never "closed";
 *   - the "decision" column is the current engine's answer at snapshot time, labelled as such;
 *   - special periods are identified by the STORED posting period and the company's fiscal year variant,
 *     never by a date; periodDates / periodEndDate (calendar assumptions) are not used;
 *   - no section is skipped silently: a section over the cap throws TOO_LARGE instead of truncating.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { ACCOUNT_TYPE_LABELS, checkPostingAllowed, type AccountType } from '../../platform/periods';

export const ACCOUNT_TYPES: readonly AccountType[] = ['S', 'K', 'D', 'A', 'M'];

/** Row and size caps. Exceeding any of them fails the pack with TOO_LARGE; nothing is truncated. */
export const MAX_TOTAL_ROWS = 250_000;
export const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;

export class PeriodPackError extends Error {
  readonly code: string;
  remedy?: string;
  constructor(code: string, message: string, remedy?: string) {
    super(message);
    this.name = 'PeriodPackError';
    this.code = code;
    this.remedy = remedy;
  }
}

export type PeriodKind = 'REGULAR' | 'SPECIAL';

export interface PackSelection {
  companyCode: string;
  fiscalYear: number;
  postingPeriod: number;
}

export interface ResolvedSelection extends PackSelection {
  fiscalYearVariant: string;
  postingPeriodVariant: string;
  periodKind: PeriodKind;
}

/**
 * A timestamp as ISO-8601 UTC. Raw SQL returns timestamptz as text ("2026-11-18 16:05:47.266903+00"), a typed
 * select returns a Date; both come out in the same form so every file shows one timestamp format.
 */
function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const text = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(text);
  if (!m) return text;
  const offset = m[4] === 'Z' ? 'Z' : m[4]!.length === 3 ? `${m[4]}:00` : m[4]!.includes(':') ? m[4]! : `${m[4]!.slice(0, 3)}:${m[4]!.slice(3)}`;
  const parsed = new Date(`${m[1]}T${m[2]}${(m[3] ?? '').slice(0, 4)}${offset}`);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}
const dateOnly = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * The company's currently assigned variants and what kind of period the selection is under that fiscal
 * year variant. Throws a named PeriodPackError when the company or the period does not exist.
 */
export async function resolveSelection(tx: Tx, client: string, selection: PackSelection): Promise<ResolvedSelection> {
  const { companyCode, fiscalYear, postingPeriod } = selection;
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 9999) {
    throw new PeriodPackError('INVALID_YEAR', 'The fiscal year must be a whole year such as 2026.', 'Enter a four-digit fiscal year.');
  }
  if (!Number.isInteger(postingPeriod) || postingPeriod < 1 || postingPeriod > 16) {
    throw new PeriodPackError('INVALID_PERIOD', 'The posting period must be a whole number from 1 to 16.', 'Enter the stored posting period, e.g. 12 or 13.');
  }
  const companies = (await tx.execute(sql`
    select company_code, fiscal_year_variant, posting_period_variant
      from company_code where client = ${client} and company_code = ${companyCode}
  `)) as unknown as Array<{ company_code: string; fiscal_year_variant: string | null; posting_period_variant: string | null }>;
  const company = companies[0];
  if (!company) throw new PeriodPackError('UNKNOWN_COMPANY', `Company code ${companyCode} does not exist.`, 'Choose a company code from your audit grant.');
  if (!company.fiscal_year_variant || !company.posting_period_variant) {
    throw new PeriodPackError('NO_VARIANT', `Company code ${companyCode} has no fiscal year variant or posting period variant assigned.`, 'The assignment must exist before evidence can be requested.');
  }
  const variants = (await tx.execute(sql`
    select is_year_dependent from fiscal_year_variant where client = ${client} and variant = ${company.fiscal_year_variant}
  `)) as unknown as Array<{ is_year_dependent: boolean }>;
  if (!variants[0]) throw new PeriodPackError('NO_VARIANT', `Fiscal year variant ${company.fiscal_year_variant} does not exist.`);
  // A year-dependent variant keeps rows per calendar year, falling back to the year-independent rows (calendar_year 0)
  // exactly as the posting engine does when it reads periods; any other variant holds for all years.
  const years = variants[0].is_year_dependent ? [fiscalYear, 0] : [0];
  const defined = (await tx.execute(sql`
    select calendar_year, period_type from fiscal_year_period
     where client = ${client} and variant = ${company.fiscal_year_variant}
       and period = ${postingPeriod} and calendar_year in ${sql`(${sql.join(years.map((y) => sql`${y}`), sql`, `)})`}
  `)) as unknown as Array<{ calendar_year: number; period_type: string }>;
  const row = defined.find((d) => d.calendar_year === years[0]) ?? defined[0];
  if (!row) {
    throw new PeriodPackError(
      'PERIOD_NOT_DEFINED',
      `Fiscal year variant ${company.fiscal_year_variant} does not define posting period ${postingPeriod} for fiscal year ${fiscalYear}.`,
      'Choose a period the company\'s fiscal year variant defines (ordinary or special).',
    );
  }
  return {
    companyCode, fiscalYear, postingPeriod,
    fiscalYearVariant: company.fiscal_year_variant,
    postingPeriodVariant: company.posting_period_variant,
    periodKind: row.period_type === 'SPECIAL' ? 'SPECIAL' : 'REGULAR',
  };
}

// ── Row shapes ──────────────────────────────────────────────────────────────

export interface RuleRow {
  accountType: AccountType;
  accountTypeLabel: string;
  variant: string;
  configured: boolean;
  periodFrom: number | null;
  periodTo: number | null;
  allowSpecialPeriods: boolean | null;
  yearShiftPast: number | null;
  yearShiftFuture: number | null;
  lastChangedBy: string | null;
  lastChangedAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
  /** The current engine's answer for the selected period at snapshot time. NOT a historical status. */
  engineDecision: 'ALLOWED_AT_SNAPSHOT' | 'NOT_ALLOWED_AT_SNAPSHOT' | 'UNKNOWN/NOT_CONFIGURED';
  engineReason: string | null;
}

export interface ChangeRow {
  source: 'POSTING_PERIOD_RULE' | 'COMPANY_VARIANT_ASSIGNMENT';
  changedAt: string;
  changeDocumentId: string;
  objectClass: string;
  objectKey: string;
  accountType: string | null;
  changeType: string;
  transactionCode: string | null;
  changedBy: string;
  reason: string | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface TaskListRow {
  taskListId: string;
  description: string | null;
  status: string;
  templateCode: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface TaskRow {
  taskListId: string;
  taskId: string;
  taskName: string;
  sequence: number;
  status: string;
  owner: string | null;
  criticalPath: boolean;
  requiresEvidence: boolean;
  requiresSignoff: boolean;
  evidenceRef: string | null;
  signedOffBy: string | null;
  signedOffAt: string | null;
  dueDate: string | null;
  attemptCount: number;
  lastExecutedAt: string | null;
}

export interface ExecutionRow {
  executionId: string;
  taskListId: string;
  taskId: string;
  attempt: number;
  mode: string;
  status: string;
  initiatedBy: string;
  startedAt: string | null;
  endedAt: string | null;
  resultSummary: string | null;
  hasErrorDetails: boolean;
  generatedDocumentRef: string | null;
}

export interface EventRow {
  eventId: string;
  taskListId: string;
  taskId: string | null;
  eventType: string;
  actor: string;
  reason: string | null;
  detail: string | null;
  createdAt: string;
}

export interface JournalRow {
  documentNumber: string;
  displayNumber: string;
  fiscalYear: number;
  documentType: string;
  postingDate: string;
  postingPeriod: number;
  postedAt: string;
  createdBy: string;
  status: string;
  reversalOf: string | null;
  reversedBy: string | null;
}

export interface EvidenceDataset {
  selection: ResolvedSelection;
  /** Database clock, from the snapshot transaction. */
  snapshotAt: string;
  companiesSharingVariant: number;
  rules: RuleRow[];
  ruleChanges: ChangeRow[];
  assignmentChanges: ChangeRow[];
  taskLists: TaskListRow[];
  tasks: TaskRow[];
  executions: ExecutionRow[];
  events: EventRow[];
  journal: JournalRow[];
}

type Rows = Array<Record<string, unknown>>;
const q = async (tx: Tx, query: ReturnType<typeof sql>): Promise<Rows> => (await tx.execute(query)) as unknown as Rows;
const num = (v: unknown): number => Number(v);

/** Count first; refuse (rather than truncate) when the whole pack would exceed the row cap. */
async function assertWithinRowCap(tx: Tx, client: string, s: ResolvedSelection, maxRows: number): Promise<void> {
  const counts = await q(tx, sql`
    select
      (select count(*) from journal_entry where client = ${client} and company_code = ${s.companyCode}
         and fiscal_year = ${s.fiscalYear} and posting_period = ${s.postingPeriod} and status <> 'PARKED')::int as journal,
      (select count(*) from change_document d join change_document_item i on i.change_document_id = d.id and i.client = d.client
         where d.client = ${client} and d.object_class = 'posting_period_rule' and starts_with(d.object_key, ${`${s.postingPeriodVariant}/`}))::int as rule_changes,
      (select count(*) from closing_execution_log where client = ${client} and company_code = ${s.companyCode}
         and fiscal_year = ${s.fiscalYear} and posting_period = ${s.postingPeriod})::int as executions,
      (select count(*) from closing_task_event where client = ${client} and company_code = ${s.companyCode}
         and fiscal_year = ${s.fiscalYear} and posting_period = ${s.postingPeriod})::int as events,
      (select count(*) from closing_task_instance where client = ${client} and company_code = ${s.companyCode}
         and fiscal_year = ${s.fiscalYear} and posting_period = ${s.postingPeriod})::int as tasks
  `);
  const c = counts[0]!;
  const total = num(c.journal) + num(c.rule_changes) + num(c.executions) + num(c.events) + num(c.tasks);
  if (total > maxRows) {
    throw new PeriodPackError(
      'TOO_LARGE',
      `The selection holds ${total} source rows, more than the ${maxRows} a pack may carry. No partial pack was produced.`,
      'Ask the administrator about the pack row limit; a pack is never truncated.',
    );
  }
}

/** Read every section of the pack from the snapshot the caller opened. */
export async function collectEvidence(
  tx: Tx,
  client: string,
  input: PackSelection,
  limits: { maxRows?: number } = {},
): Promise<EvidenceDataset> {
  // First statement of the transaction: fixes the snapshot, and takes the database's own clock.
  const clock = await q(tx, sql`select clock_timestamp() as snapshot_at`);
  const snapshotAt = iso(clock[0]!.snapshot_at)!;
  const selection = await resolveSelection(tx, client, input);
  await assertWithinRowCap(tx, client, selection, limits.maxRows ?? MAX_TOTAL_ROWS);

  const sharing = await q(tx, sql`
    select count(*)::int as n from company_code where client = ${client} and posting_period_variant = ${selection.postingPeriodVariant}
  `);

  // ── Current rules of the current variant, one row per account type ────────
  const ruleRows = await q(tx, sql`
    select account_type, period_from, period_to, allow_special_periods, year_shift_past, year_shift_future,
           created_by, created_at, changed_by, changed_at
      from posting_period_rule where client = ${client} and variant = ${selection.postingPeriodVariant}
  `);
  const position = { fiscalYear: selection.fiscalYear, period: selection.postingPeriod, periodType: selection.periodKind } as const;
  const rules: RuleRow[] = [];
  for (const accountType of ACCOUNT_TYPES) {
    const r = ruleRows.find((row) => String(row.account_type) === accountType);
    const base = { accountType, accountTypeLabel: ACCOUNT_TYPE_LABELS[accountType], variant: selection.postingPeriodVariant };
    if (!r) {
      rules.push({
        ...base, configured: false, periodFrom: null, periodTo: null, allowSpecialPeriods: null, yearShiftPast: null, yearShiftFuture: null,
        lastChangedBy: null, lastChangedAt: null, createdBy: null, createdAt: null,
        engineDecision: 'UNKNOWN/NOT_CONFIGURED', engineReason: 'No rule is configured for this account type; this is a configuration gap, not a closed period.',
      });
      continue;
    }
    const verdict = await checkPostingAllowed(tx, client, selection.postingPeriodVariant, accountType, position);
    rules.push({
      ...base, configured: true,
      periodFrom: num(r.period_from), periodTo: num(r.period_to), allowSpecialPeriods: Boolean(r.allow_special_periods),
      yearShiftPast: num(r.year_shift_past), yearShiftFuture: num(r.year_shift_future),
      lastChangedBy: r.changed_by ? String(r.changed_by) : null, lastChangedAt: iso(r.changed_at),
      createdBy: r.created_by ? String(r.created_by) : null, createdAt: iso(r.created_at),
      engineDecision: verdict.allowed ? 'ALLOWED_AT_SNAPSHOT' : 'NOT_ALLOWED_AT_SNAPSHOT',
      engineReason: verdict.reason ?? null,
    });
  }

  // ── Raw recorded changes ───────────────────────────────────────────────────
  const changeRowOf = (source: ChangeRow['source']) => (r: Record<string, unknown>): ChangeRow => ({
    source,
    changedAt: iso(r.changed_at)!, changeDocumentId: String(r.id),
    objectClass: String(r.object_class), objectKey: String(r.object_key),
    accountType: source === 'POSTING_PERIOD_RULE' ? String(r.object_key).split('/')[1] ?? null : null,
    changeType: String(r.change_type), transactionCode: r.transaction_code ? String(r.transaction_code) : null,
    changedBy: String(r.changed_by), reason: r.reason ? String(r.reason) : null,
    field: r.field_name ? String(r.field_name) : null,
    oldValue: r.old_value == null ? null : String(r.old_value), newValue: r.new_value == null ? null : String(r.new_value),
  });
  const ruleChanges = (await q(tx, sql`
    select d.id, d.object_class, d.object_key, d.change_type, d.transaction_code, d.reason, d.changed_by, d.changed_at,
           i.field_name, i.old_value, i.new_value
      from change_document d
      left join change_document_item i on i.change_document_id = d.id and i.client = d.client
     where d.client = ${client} and d.object_class = 'posting_period_rule' and starts_with(d.object_key, ${`${selection.postingPeriodVariant}/`})
     order by d.changed_at, d.id, i.field_name
  `)).map(changeRowOf('POSTING_PERIOD_RULE'));
  // Only the posting-period-variant item of a company assignment document is exported: the document's other
  // items (e.g. a count of journal entries) are not part of this evidence.
  const assignmentChanges = (await q(tx, sql`
    select d.id, d.object_class, d.object_key, d.change_type, d.transaction_code, d.reason, d.changed_by, d.changed_at,
           i.field_name, i.old_value, i.new_value
      from change_document d
      join change_document_item i on i.change_document_id = d.id and i.client = d.client and i.field_name = 'postingPeriodVariant'
     where d.client = ${client} and d.object_class = 'company_code' and d.object_key = ${selection.companyCode}
     order by d.changed_at, d.id
  `)).map(changeRowOf('COMPANY_VARIANT_ASSIGNMENT'));

  // ── Closing tasks (this company, year, stored period only) ─────────────────
  const where = sql`client = ${client} and company_code = ${selection.companyCode} and fiscal_year = ${selection.fiscalYear} and posting_period = ${selection.postingPeriod}`;
  const taskLists = (await q(tx, sql`
    select task_list_id, description, status, template_code, created_by, created_at, updated_by, updated_at
      from closing_task_list where ${where} order by task_list_id
  `)).map((r): TaskListRow => ({
    taskListId: String(r.task_list_id), description: r.description ? String(r.description) : null, status: String(r.status),
    templateCode: r.template_code ? String(r.template_code) : null, createdBy: String(r.created_by), createdAt: iso(r.created_at)!,
    updatedBy: r.updated_by ? String(r.updated_by) : null, updatedAt: iso(r.updated_at),
  }));
  const tasks = (await q(tx, sql`
    select task_list_id, task_id, task_name, sequence, status, owner, critical_path, requires_evidence, requires_signoff,
           evidence_ref, signed_off_by, signed_off_at, due_date, attempt_count, last_executed_at
      from closing_task_instance where ${where} order by task_list_id, sequence, task_id
  `)).map((r): TaskRow => ({
    taskListId: String(r.task_list_id), taskId: String(r.task_id), taskName: String(r.task_name), sequence: num(r.sequence),
    status: String(r.status), owner: r.owner ? String(r.owner) : null, criticalPath: Boolean(r.critical_path),
    requiresEvidence: Boolean(r.requires_evidence), requiresSignoff: Boolean(r.requires_signoff),
    evidenceRef: r.evidence_ref ? String(r.evidence_ref) : null, signedOffBy: r.signed_off_by ? String(r.signed_off_by) : null,
    signedOffAt: iso(r.signed_off_at), dueDate: dateOnly(r.due_date), attemptCount: num(r.attempt_count), lastExecutedAt: iso(r.last_executed_at),
  }));
  const executions = (await q(tx, sql`
    select execution_id, task_list_id, task_id, attempt, mode, status, initiated_by, started_at, ended_at, result_summary,
           (error_details is not null and error_details <> '') as has_error_details, generated_document_number, generated_fiscal_year
      from closing_execution_log where ${where} order by task_list_id, task_id, attempt, execution_id
  `)).map((r): ExecutionRow => ({
    executionId: String(r.execution_id), taskListId: String(r.task_list_id), taskId: String(r.task_id), attempt: num(r.attempt),
    mode: String(r.mode), status: String(r.status), initiatedBy: String(r.initiated_by), startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
    resultSummary: r.result_summary ? String(r.result_summary) : null, hasErrorDetails: Boolean(r.has_error_details),
    generatedDocumentRef: r.generated_document_number ? `${r.generated_document_number}/${r.generated_fiscal_year ?? ''}` : null,
  }));
  const events = (await q(tx, sql`
    select event_id, task_list_id, task_id, event_type, actor, reason, detail, created_at
      from closing_task_event where ${where} order by created_at, event_id
  `)).map((r): EventRow => ({
    eventId: String(r.event_id), taskListId: String(r.task_list_id), taskId: r.task_id ? String(r.task_id) : null,
    eventType: String(r.event_type), actor: String(r.actor), reason: r.reason ? String(r.reason) : null,
    detail: r.detail ? String(r.detail) : null, createdAt: iso(r.created_at)!,
  }));

  // ── Journal postings, by STORED posting period; PARKED is not a posting ────
  const journal = (await q(tx, sql`
    select document_number, display_number, fiscal_year, document_type, posting_date, posting_period, posted_at, created_by,
           status, reversal_of, reversed_by
      from journal_entry
     where client = ${client} and company_code = ${selection.companyCode} and fiscal_year = ${selection.fiscalYear}
       and posting_period = ${selection.postingPeriod} and status <> 'PARKED'
     order by posted_at, document_number, fiscal_year
  `)).map((r): JournalRow => ({
    documentNumber: String(r.document_number), displayNumber: String(r.display_number || r.document_number), fiscalYear: num(r.fiscal_year),
    documentType: String(r.document_type), postingDate: dateOnly(r.posting_date)!, postingPeriod: num(r.posting_period),
    postedAt: iso(r.posted_at)!, createdBy: String(r.created_by), status: String(r.status),
    reversalOf: r.reversal_of ? String(r.reversal_of) : null, reversedBy: r.reversed_by ? String(r.reversed_by) : null,
  }));

  return {
    selection, snapshotAt, companiesSharingVariant: num(sharing[0]!.n),
    rules, ruleChanges, assignmentChanges, taskLists, tasks, executions, events, journal,
  };
}

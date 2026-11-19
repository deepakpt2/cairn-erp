/**
 * Period-close evidence pack: turn an `EvidenceDataset` into the fixed set of files.
 *
 * Pure and deterministic for the same dataset, request and `generatedAt`. The wording here is the evidence's
 * voice: it states what is recorded and says UNKNOWN / not recorded where the system holds no proof. It never
 * says a period was closed by someone, a posting was authorised, or that anything is "compliant" or "complete".
 */
import {
  buildCsv,
  buildManifest,
  buildZip,
  sha256Hex,
  type BuiltPack,
  type ManifestFile,
  PACK_FILES,
  type CsvTable,
} from './period-evidence-archive';
import { MAX_UNCOMPRESSED_BYTES, MAX_ZIP_BYTES, PeriodPackError, type EvidenceDataset } from './period-evidence-data';

export interface PackContext {
  packId: string;
  client: string;
  requestedBy: string;
  grantId: string;
  /** The real wall-clock time the archive was assembled. Not faked, not part of the snapshot. */
  generatedAt: string;
}

export const LIMITATIONS: ReadonlyArray<{ code: string; statement: string }> = [
  { code: 'CLOSURE_EVENT_UNKNOWN', statement: 'Whether, when and by whom this posting period was closed or reopened is UNKNOWN / not recorded as a complete timeline. The system keeps no guaranteed record of every open/close event.' },
  { code: 'POSTING_AUTHORITY_UNKNOWN', statement: 'The authority used to make any individual posting is UNKNOWN / not recorded. The journal header carries no posted-by field and no proof of the capability used; created_by is the recorded creator only.' },
  { code: 'RULES_ARE_CURRENT', statement: 'period-rules.csv shows the rules of the posting period variant CURRENTLY assigned to the company code, as they stood at the snapshot. They are not a historical status of this period, and the engine decision column is the current engine\'s answer at snapshot time.' },
  { code: 'ASSIGNMENT_HISTORY_NOT_PROVEN', statement: 'The current variant assignment is not proven to be the assignment that applied in the past. A variant can be shared by several company codes, so rule changes may have been made for another company.' },
  { code: 'RULE_HISTORY_MAY_BE_INCOMPLETE', statement: 'period-rule-changes.csv lists the recorded change documents only. History may have gaps, bootstrap events, missing fields or legacy writes, and no CLOSE or REOPEN event has been inferred from it.' },
  { code: 'LATE_POSTING_NOT_ASSESSED', statement: 'A journal posted_at later than a recorded rule change is not by itself proof that the posting happened after a valid closure or that it was unauthorised. This pack makes no statement about late postings.' },
  { code: 'FINALIZED_TASK_LIST_NOT_CLOSURE', statement: 'A FINALIZED closing task list is a workflow state. It does not close the posting period and is not evidence that the period was closed.' },
  { code: 'FISCAL_END_NOT_CLOSE_TIME', statement: 'The end of the fiscal period is not the time of close and is not reported as such.' },
  { code: 'SUBLEDGER_TIE_OUT_NOT_INCLUDED', statement: 'No sub-ledger tie-out is included. Tie-outs are computed live and no saved or approved historical run exists at this baseline.' },
  { code: 'NO_ORIGIN_PROOF', statement: 'A hash in the manifest lets a reader detect alteration against a trusted manifest. It is not a signature and does not prove who produced the pack.' },
  { code: 'SCOPE_FIN_ONLY', statement: 'Journal origin keys, reasons, header text and any people or payroll data are not included. Rows are limited to the selected company code, fiscal year and stored posting period.' },
];

const summaryTable = (d: EvidenceDataset, c: PackContext): CsvTable => {
  const s = d.selection;
  const missing = d.rules.filter((r) => !r.configured).map((r) => r.accountType);
  const byStatus = (rows: ReadonlyArray<{ status: string }>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join(';');
  };
  const rows: Array<[string, string | number | boolean | null, string]> = [
    ['pack_id', c.packId, 'request'],
    ['client', c.client, 'request'],
    ['company_code', s.companyCode, 'request'],
    ['fiscal_year', s.fiscalYear, 'request'],
    ['posting_period', s.postingPeriod, 'request (stored posting period)'],
    ['period_kind', s.periodKind, 'fiscal year variant definition of this period'],
    ['fiscal_year_variant', s.fiscalYearVariant, 'CURRENT assignment at snapshot'],
    ['posting_period_variant', s.postingPeriodVariant, 'CURRENT assignment at snapshot; historical assignment not proven'],
    ['companies_sharing_current_posting_period_variant', d.companiesSharingVariant, 'count at snapshot; a shared variant affects all of them'],
    ['requested_by', c.requestedBy, 'request'],
    ['audit_grant_id', c.grantId, 'request'],
    ['source_snapshot_at_utc', d.snapshotAt, 'database clock of the repeatable-read snapshot'],
    ['generated_at_utc', c.generatedAt, 'worker clock when the archive was assembled'],
    ['period_rules_rows', d.rules.length, 'period-rules.csv'],
    ['period_rules_not_configured', missing.length ? missing.join(';') : 'none', 'UNKNOWN/NOT_CONFIGURED is a configuration gap, not a closed period'],
    ['period_rule_change_rows', d.ruleChanges.length, 'period-rule-changes.csv, source POSTING_PERIOD_RULE'],
    ['company_variant_assignment_change_rows', d.assignmentChanges.length, 'period-rule-changes.csv, source COMPANY_VARIANT_ASSIGNMENT'],
    ['rule_change_history_completeness', 'UNKNOWN', 'recorded change documents only; gaps are possible'],
    ['close_task_lists', d.taskLists.length, d.taskLists.length === 0 ? 'NO_TASK_LIST_FOR_SELECTION' : `by status ${byStatus(d.taskLists)}`],
    ['close_tasks', d.tasks.length, d.tasks.length === 0 ? 'none' : `by status ${byStatus(d.tasks)}`],
    ['close_task_executions', d.executions.length, d.executions.length === 0 ? 'none' : `by status ${byStatus(d.executions)}`],
    ['close_events', d.events.length, 'close-events.csv'],
    ['journal_postings', d.journal.length, 'non-parked headers in the stored posting period'],
    ['journal_postings_by_status', d.journal.length === 0 ? 'none' : byStatus(d.journal), 'POSTED/REVERSED as recorded; PARKED excluded'],
    ['period_closure_event', 'UNKNOWN / not recorded', 'see limitations.txt CLOSURE_EVENT_UNKNOWN'],
    ['posting_time_authority', 'UNKNOWN / not recorded', 'see limitations.txt POSTING_AUTHORITY_UNKNOWN'],
    ['subledger_tie_out', 'NOT_INCLUDED', 'see limitations.txt SUBLEDGER_TIE_OUT_NOT_INCLUDED'],
  ];
  return { columns: ['key', 'value', 'basis'], rows };
};

const rulesTable = (d: EvidenceDataset): CsvTable => ({
  columns: ['account_type', 'account_type_label', 'posting_period_variant', 'variant_basis', 'rule_status', 'period_from', 'period_to', 'allow_special_periods',
    'year_shift_past', 'year_shift_future', 'selected_period', 'selected_period_kind', 'current_engine_decision', 'decision_basis', 'engine_reason',
    'last_changed_by', 'last_changed_at', 'created_by', 'created_at'],
  rows: d.rules.map((r) => [
    r.accountType, r.accountTypeLabel, r.variant, 'CURRENT_ASSIGNMENT_AT_SNAPSHOT', r.configured ? 'CONFIGURED' : 'UNKNOWN/NOT_CONFIGURED',
    r.periodFrom, r.periodTo, r.allowSpecialPeriods, r.yearShiftPast, r.yearShiftFuture, d.selection.postingPeriod, d.selection.periodKind,
    r.engineDecision, 'CURRENT_ENGINE_AT_SNAPSHOT_NOT_HISTORICAL', r.engineReason, r.lastChangedBy, r.lastChangedAt, r.createdBy, r.createdAt,
  ]),
});

const changesTable = (d: EvidenceDataset): CsvTable => ({
  columns: ['source', 'source_variant_basis', 'event_at', 'change_document_id', 'object_class', 'object_key', 'account_type', 'change_type',
    'transaction_code', 'changed_by', 'reason', 'field', 'old_value', 'new_value', 'note'],
  rows: [...d.ruleChanges, ...d.assignmentChanges].map((c) => [
    c.source, c.source === 'POSTING_PERIOD_RULE' ? 'CURRENT_ASSIGNMENT_SHARED_VARIANT_NOT_PROVEN_HISTORICAL' : 'COMPANY_ASSIGNMENT_CHANGE',
    c.changedAt, c.changeDocumentId, c.objectClass, c.objectKey, c.accountType, c.changeType, c.transactionCode, c.changedBy, c.reason,
    c.field, c.oldValue, c.newValue,
    c.source === 'POSTING_PERIOD_RULE'
      ? 'Raw recorded change; not interpreted as a close or reopen event. The variant may be shared by other company codes.'
      : 'Raw recorded change of this company code\'s posting period variant assignment.',
  ]),
});

const tasksTable = (d: EvidenceDataset): CsvTable => {
  const rows: CsvTable['rows'][number][] = [];
  for (const l of d.taskLists) {
    rows.push(['TASK_LIST', l.taskListId, null, l.description, l.status, null, null, null, null, null, null, null, null, null, null, null, null,
      `Workflow state only; ${l.status === 'FINALIZED' ? 'FINALIZED does not close the posting period' : 'not evidence of period closure'}`]);
  }
  for (const t of d.tasks) {
    rows.push(['TASK', t.taskListId, t.taskId, t.taskName, t.status, t.owner, t.sequence, t.criticalPath, t.requiresEvidence, t.requiresSignoff,
      t.evidenceRef, t.signedOffBy, t.signedOffAt, t.dueDate, t.attemptCount, t.lastExecutedAt, null, 'evidence_ref is a reference only; linked content is not included']);
  }
  for (const e of d.executions) {
    rows.push(['EXECUTION', e.taskListId, e.taskId, e.executionId, e.status, e.initiatedBy, e.attempt, null, null, null,
      e.generatedDocumentRef, null, null, null, null, e.startedAt, e.endedAt,
      `${e.mode}${e.hasErrorDetails ? '; error details exist and are not exported' : ''}${e.resultSummary ? `; ${e.resultSummary}` : ''}`]);
  }
  return {
    columns: ['record_type', 'task_list_id', 'task_id', 'name_or_execution_id', 'status', 'owner_or_initiator', 'sequence_or_attempt', 'critical_path',
      'requires_evidence', 'requires_signoff', 'evidence_or_generated_ref', 'signed_off_by', 'signed_off_at', 'due_date', 'attempt_count',
      'started_or_last_executed_at', 'ended_at', 'note'],
    rows,
  };
};

const eventsTable = (d: EvidenceDataset): CsvTable => ({
  columns: ['event_at', 'event_id', 'task_list_id', 'task_id', 'event_type', 'actor', 'reason', 'detail', 'note'],
  rows: d.events.map((e) => [e.createdAt, e.eventId, e.taskListId, e.taskId, e.eventType, e.actor, e.reason, e.detail,
    e.eventType === 'FINALIZED' ? 'Task list finalised; this does not close the posting period' : null]),
});

const journalTable = (d: EvidenceDataset): CsvTable => ({
  columns: ['document_number', 'display_number', 'fiscal_year', 'document_type', 'posting_date', 'posting_period', 'period_kind', 'posted_at',
    'created_by', 'status', 'reversal_of', 'reversed_by', 'authority_proof'],
  rows: d.journal.map((j) => [
    j.documentNumber, j.displayNumber, j.fiscalYear, j.documentType, j.postingDate, j.postingPeriod, d.selection.periodKind, j.postedAt,
    j.createdBy, j.status, j.reversalOf, j.reversedBy, 'UNKNOWN / not recorded',
  ]),
});

export function limitationsText(d: EvidenceDataset): Buffer {
  const lines = [
    'PERIOD-CLOSE EVIDENCE PACK - LIMITATIONS',
    `Company code ${d.selection.companyCode}, fiscal year ${d.selection.fiscalYear}, stored posting period ${d.selection.postingPeriod} (${d.selection.periodKind}).`,
    `Fiscal year variant ${d.selection.fiscalYearVariant} and posting period variant ${d.selection.postingPeriodVariant} are the CURRENT assignments at the snapshot.`,
    '',
    'This pack reports what the system recorded. Where the system holds no proof, it says UNKNOWN / not recorded.',
    'It does not state that any period was closed, by whom, that any posting was authorised or late, or that the books are compliant or complete.',
    '',
    ...LIMITATIONS.map((l) => `[${l.code}] ${l.statement}`),
    '',
    d.taskLists.length === 0 ? 'Closing tasks: no closing task list exists for this selection (this is different from a failed or incomplete list).' : `Closing tasks: ${d.taskLists.length} task list(s) exist for this selection.`,
    d.rules.some((r) => !r.configured) ? `Rules: no rule is configured for account type(s) ${d.rules.filter((r) => !r.configured).map((r) => r.accountType).join(', ')}; that is UNKNOWN/NOT_CONFIGURED, not closed.` : 'Rules: all five account types have a configured rule in the current variant.',
    '',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

const SOURCES = [
  { file: 'summary.csv', source: 'derived from the sections below and the request', basis: 'snapshot' },
  { file: 'period-rules.csv', source: 'posting_period_rule (current variant of company_code), periods engine checkPostingAllowed', basis: 'CURRENT at snapshot, not historical' },
  { file: 'period-rule-changes.csv', source: 'change_document / change_document_item (posting_period_rule; company_code postingPeriodVariant)', basis: 'recorded changes only; completeness UNKNOWN' },
  { file: 'close-tasks.csv', source: 'closing_task_list, closing_task_instance, closing_execution_log', basis: 'as recorded for company/year/stored period' },
  { file: 'close-events.csv', source: 'closing_task_event', basis: 'as recorded for company/year/stored period' },
  { file: 'journal-postings.csv', source: 'journal_entry headers, status <> PARKED, by stored posting_period', basis: 'as recorded' },
  { file: 'limitations.txt', source: 'fixed text and selection facts', basis: 'static' },
];

/** Build every file, the manifest and the ZIP. Throws TOO_LARGE rather than returning an oversize or partial pack. */
export function renderPack(
  d: EvidenceDataset,
  c: PackContext,
  limits: { maxUncompressedBytes?: number; maxZipBytes?: number } = {},
): BuiltPack & { files: ManifestFile[] } {
  const tables: Record<string, CsvTable> = {
    'summary.csv': summaryTable(d, c), 'period-rules.csv': rulesTable(d), 'period-rule-changes.csv': changesTable(d),
    'close-tasks.csv': tasksTable(d), 'close-events.csv': eventsTable(d), 'journal-postings.csv': journalTable(d),
  };
  const members: Array<{ name: (typeof PACK_FILES)[number]; bytes: Buffer }> = [];
  const files: ManifestFile[] = [];
  for (const name of PACK_FILES) {
    const table = tables[name];
    const bytes = table ? buildCsv(table) : limitationsText(d);
    members.push({ name, bytes });
    files.push({ name, bytes: bytes.length, rows: table ? table.rows.length : null, sha256: sha256Hex(bytes) });
  }
  const manifest = buildManifest({
    packId: c.packId, client: c.client, companyCode: d.selection.companyCode, fiscalYear: d.selection.fiscalYear,
    postingPeriod: d.selection.postingPeriod, snapshotAt: d.snapshotAt, generatedAt: c.generatedAt, files, sources: SOURCES, limitations: LIMITATIONS,
  });
  const built = buildZip(members, manifest, new Date(d.snapshotAt));
  if (built.uncompressedBytes > (limits.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES) || built.zip.length > (limits.maxZipBytes ?? MAX_ZIP_BYTES)) {
    throw new PeriodPackError('TOO_LARGE', 'The pack would exceed the size limit. No partial pack was produced.', 'A pack is never truncated; ask the administrator about the pack size limit.');
  }
  return { ...built, files };
}

/**
 * Consolidation workbench (SCR-116 / FIN.RPT.CONSOLIDATE;
 * UCWB search alias).
 *
 * A configuration workbench, never an execution or posting
 * transaction: it defines consolidation areas, their data
 * basis (bound to the standing journal provider; BW
 * providers deferred), units and groups with time-dependent
 * assignments that reject overlaps, the consolidation chart
 * with group accounts and source mappings, methods, versions,
 * and task hierarchies whose references must stand before
 * save. Only an ACTIVE area may serve later execution —
 * activation judges completeness. Every write is
 * transactional with a mandatory reason and one change
 * document. Execution (the UCMON monitor) and transports
 * are deferred by name; intercompany elimination stays
 * configuration-only (execution last, B-663).
 *
 * Stage 1 carries the vocabulary only; schema lands in
 * stage 2 and the configuration service in stage 3.
 */
export const CONSOLIDATION_CAPABILITY = 'FIN.RPT.CONSOLIDATE';

export const CONSOLIDATION_FOLDERS = [
  'DATA_BASIS', 'MASTER_DATA', 'CHART_MAPPINGS', 'METHODS', 'TASKS',
] as const;
export type ConsolidationFolder = (typeof CONSOLIDATION_FOLDERS)[number];

export const DATA_PROVIDERS = ['JOURNAL'] as const;
export type DataProvider = (typeof DATA_PROVIDERS)[number];

export const METHOD_KINDS = [
  'CURRENCY_TRANSLATION', 'INTERCOMPANY_ELIMINATION', 'INVESTMENT', 'OTHER',
] as const;
export type MethodKind = (typeof METHOD_KINDS)[number];

export const TASK_TYPES = [
  'DATA_COLLECTION', 'CURRENCY_TRANSLATION', 'ELIMINATION', 'INVESTMENT', 'VALIDATION', 'OTHER',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type ConsolidationAreaStatus = 'DRAFT' | 'ACTIVE';

export interface ConsolidationArea {
  area: string;
  title: string;
  dataBasis: string;
  consChart: string;
  fiscalYearVariant: string;
  status: ConsolidationAreaStatus;
}

export interface ConsolidationUnit {
  unit: string;
  title: string;
  companyCode: string;
}

export interface ConsolidationGroup {
  group: string;
  title: string;
  parentGroup: string;
}

export interface UnitAssignment {
  group: string;
  unit: string;
  validFrom: string;
  validTo: string;
}

export interface GroupAccount {
  consChart: string;
  account: string;
  title: string;
}

export interface AccountMapping {
  consChart: string;
  sourceChart: string;
  sourceAccountFrom: string;
  sourceAccountTo: string;
  groupAccount: string;
}

export interface ConsolidationMethod {
  method: string;
  kind: MethodKind;
  title: string;
}

export interface ConsolidationVersion {
  version: string;
  title: string;
}

export interface ConsolidationTask {
  task: string;
  parentTask: string;
  sequence: number;
  taskType: TaskType;
  method: string;
  unit: string;
  group: string;
  validFrom: string;
  validTo: string;
}

export interface ConsolidationWorkbenchView {
  area: ConsolidationArea;
  dataBasisTitle: string;
  units: ConsolidationUnit[];
  groups: ConsolidationGroup[];
  assignments: UnitAssignment[];
  groupAccounts: GroupAccount[];
  mappings: AccountMapping[];
  methods: ConsolidationMethod[];
  versions: ConsolidationVersion[];
  tasks: ConsolidationTask[];
}

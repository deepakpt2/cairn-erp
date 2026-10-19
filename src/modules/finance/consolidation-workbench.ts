/**
 * Consolidation workbench service (SCR-116 stage 3+).
 * Vocabulary lives in consolidation-vocabulary.ts and is
 * re-exported here so service consumers keep one import.
 */
export * from './consolidation-vocabulary';
import {
  CONSOLIDATION_CAPABILITY, METHOD_KINDS, TASK_TYPES,
} from './consolidation-vocabulary';
import type {
  ConsolidationArea, ConsolidationAreaStatus, ConsolidationWorkbenchView,
  MethodKind, TaskType,
} from './consolidation-vocabulary';

import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { chartOfAccounts, companyCode as foundationCompanyCode, fiscalYearVariant } from '../foundation/schema';
import {
  consolidationAccountMapping, consolidationArea, consolidationDataBasis,
  consolidationDimension, consolidationGroup, consolidationGroupAccount,
  consolidationMethod, consolidationTask, consolidationUnit,
  consolidationUnitAssignment, consolidationVersion, glAccount,
} from './schema';

export class ConsolidationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ConsolidationError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new ConsolidationError(message, remedy);
}

const OBJECT_CLASS = 'consolidation_workbench';

/** Standing journal characteristics a dimension may bind to. */
export const DIMENSION_SOURCES: Record<string, string> = {
  COMPANY_CODE: 'journal_entry.company_code',
  GL_ACCOUNT: 'journal_entry_line.gl_account',
  PROFIT_CENTER: 'journal_entry_line.profit_center',
  COST_CENTER: 'journal_entry_line.cost_center',
  BUSINESS_PARTNER: 'journal_entry_line.business_partner',
  POSTING_PERIOD: 'journal_entry.posting_period',
  DOCUMENT_CURRENCY: 'journal_entry.document_currency',
};

interface Actor { client: string; changedBy: string; reason: string }

function judgeReason(input: Actor) {
  if (!input.reason?.trim()) fail('A change reason is required.', 'State why this configuration changes.');
}

async function audit(tx: Tx, input: Actor, objectKey: string, after: Record<string, unknown>) {
  await recordChange(tx, {
    client: input.client, objectClass: OBJECT_CLASS, objectKey,
    changeType: 'CREATE', changedBy: input.changedBy,
    transactionCode: CONSOLIDATION_CAPABILITY, after,
  });
}

async function judgeArea(tx: Tx, client: string, area: string) {
  const [row] = await tx.select().from(consolidationArea).where(and(
    eq(consolidationArea.client, client), eq(consolidationArea.area, area),
  ));
  if (!row) fail(`Consolidation area ${area} does not stand.`, 'Define the area first.');
  return row;
}

export async function listConsolidationAreas(client: string): Promise<ConsolidationArea[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(consolidationArea)
      .where(eq(consolidationArea.client, client))
      .orderBy(consolidationArea.area);
    return rows.map((r) => ({
      area: r.area, title: r.title, dataBasis: r.dataBasis,
      consChart: r.consChart, fiscalYearVariant: r.fiscalYearVariant,
      status: r.status as ConsolidationAreaStatus,
    }));
  });
}

export async function getConsolidationWorkbench(client: string, areaKey: string): Promise<ConsolidationWorkbenchView | null> {
  return withTenant(client, async (tx) => {
    const [area] = await tx.select().from(consolidationArea).where(and(
      eq(consolidationArea.client, client), eq(consolidationArea.area, areaKey),
    ));
    if (!area) return null;
    const inArea = and(eq(consolidationUnit.client, client), eq(consolidationUnit.area, areaKey));
    const units = await tx.select().from(consolidationUnit).where(inArea).orderBy(consolidationUnit.unit);
    const groups = await tx.select().from(consolidationGroup).where(and(
      eq(consolidationGroup.client, client), eq(consolidationGroup.area, areaKey),
    )).orderBy(consolidationGroup.groupName);
    const assignments = await tx.select().from(consolidationUnitAssignment).where(and(
      eq(consolidationUnitAssignment.client, client), eq(consolidationUnitAssignment.area, areaKey),
    )).orderBy(consolidationUnitAssignment.unit, consolidationUnitAssignment.validFrom);
    const groupAccounts = await tx.select().from(consolidationGroupAccount).where(and(
      eq(consolidationGroupAccount.client, client), eq(consolidationGroupAccount.consChart, area.consChart),
    )).orderBy(consolidationGroupAccount.account);
    const mappings = await tx.select().from(consolidationAccountMapping).where(and(
      eq(consolidationAccountMapping.client, client), eq(consolidationAccountMapping.consChart, area.consChart),
    )).orderBy(consolidationAccountMapping.sourceChart, consolidationAccountMapping.sourceFrom);
    const methods = await tx.select().from(consolidationMethod).where(and(
      eq(consolidationMethod.client, client), eq(consolidationMethod.area, areaKey),
    )).orderBy(consolidationMethod.method);
    const versions = await tx.select().from(consolidationVersion).where(and(
      eq(consolidationVersion.client, client), eq(consolidationVersion.area, areaKey),
    )).orderBy(consolidationVersion.version);
    const tasks = await tx.select().from(consolidationTask).where(and(
      eq(consolidationTask.client, client), eq(consolidationTask.area, areaKey),
    )).orderBy(consolidationTask.version, consolidationTask.sequence, consolidationTask.task);
    const [basis] = await tx.select().from(consolidationDataBasis).where(and(
      eq(consolidationDataBasis.client, client), eq(consolidationDataBasis.basis, area.dataBasis),
    ));
    return {
      area: {
        area: area.area, title: area.title, dataBasis: area.dataBasis,
        consChart: area.consChart, fiscalYearVariant: area.fiscalYearVariant,
        status: area.status as ConsolidationAreaStatus,
      },
      dataBasisTitle: basis?.title ?? '',
      units: units.map((u) => ({ unit: u.unit, title: u.title, companyCode: u.companyCode })),
      groups: groups.map((g) => ({ group: g.groupName, title: g.title, parentGroup: g.parentGroup ?? '' })),
      assignments: assignments.map((a) => ({
        group: a.groupName, unit: a.unit, validFrom: a.validFrom, validTo: a.validTo,
      })),
      groupAccounts: groupAccounts.map((g) => ({ consChart: g.consChart, account: g.account, title: g.title })),
      mappings: mappings.map((m) => ({
        consChart: m.consChart, sourceChart: m.sourceChart,
        sourceAccountFrom: m.sourceFrom, sourceAccountTo: m.sourceTo, groupAccount: m.groupAccount,
      })),
      methods: methods.map((m) => ({ method: m.method, kind: m.kind as MethodKind, title: m.title })),
      versions: versions.map((v) => ({ version: v.version, title: v.title })),
      tasks: tasks.map((task) => ({
        task: task.task, parentTask: task.parentTask ?? '', sequence: task.sequence,
        taskType: task.taskType as TaskType, method: task.method ?? '',
        unit: task.unit ?? '', group: task.groupName ?? '',
        validFrom: task.validFrom, validTo: task.validTo,
      })),
    };
  });
}

export async function saveDataBasis(input: Actor & {
  basis: string; title: string; dimensions: Array<{ dimension: string }>;
}): Promise<void> {
  judgeReason(input);
  const basis = input.basis.toUpperCase();
  if (!/^[A-Z0-9_]{1,24}$/.test(basis)) fail(`Data basis ${input.basis} is not a valid basis key.`);
  for (const d of input.dimensions) {
    if (!DIMENSION_SOURCES[d.dimension]) {
      fail(`Dimension ${d.dimension} does not bind a standing journal characteristic.`,
        `Dimensions bind: ${Object.keys(DIMENSION_SOURCES).join(', ')}.`);
    }
  }
  await withTenant(input.client, async (tx) => {
    await tx.insert(consolidationDataBasis).values({
      client: input.client, basis, title: input.title, provider: 'JOURNAL', createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationDataBasis.client, consolidationDataBasis.basis],
      set: { title: input.title, updatedBy: input.changedBy, updatedAt: new Date() },
    });
    for (const d of input.dimensions) {
      await tx.insert(consolidationDimension).values({
        client: input.client, basis, dimension: d.dimension,
        sourceField: DIMENSION_SOURCES[d.dimension]!, createdBy: input.changedBy,
      }).onConflictDoUpdate({
        target: [consolidationDimension.client, consolidationDimension.basis, consolidationDimension.dimension],
        set: { sourceField: DIMENSION_SOURCES[d.dimension]!, updatedBy: input.changedBy, updatedAt: new Date() },
      });
    }
    await audit(tx, input, `basis/${basis}`, { basis, title: input.title, dimensions: input.dimensions.length });
  });
}

export async function saveArea(input: Actor & {
  area: string; title: string; dataBasis: string; consChart: string; fiscalYearVariant: string;
}): Promise<void> {
  judgeReason(input);
  const area = input.area.toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(area)) fail(`Consolidation area ${input.area} must be exactly four characters.`);
  await withTenant(input.client, async (tx) => {
    const [basis] = await tx.select().from(consolidationDataBasis).where(and(
      eq(consolidationDataBasis.client, input.client), eq(consolidationDataBasis.basis, input.dataBasis),
    ));
    if (!basis) fail(`Data basis ${input.dataBasis} does not stand.`, 'Define the data basis first.');
    const [variant] = await tx.select().from(fiscalYearVariant).where(and(
      eq(fiscalYearVariant.client, input.client), eq(fiscalYearVariant.variant, input.fiscalYearVariant),
    ));
    if (!variant) fail(`Fiscal year variant ${input.fiscalYearVariant} does not stand.`);
    await tx.insert(consolidationArea).values({
      client: input.client, area, title: input.title, dataBasis: input.dataBasis,
      consChart: input.consChart.toUpperCase(), fiscalYearVariant: input.fiscalYearVariant,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationArea.client, consolidationArea.area],
      set: {
        title: input.title, dataBasis: input.dataBasis,
        consChart: input.consChart.toUpperCase(), fiscalYearVariant: input.fiscalYearVariant,
        updatedBy: input.changedBy, updatedAt: new Date(),
      },
    });
    await audit(tx, input, `area/${area}`, { area, dataBasis: input.dataBasis, consChart: input.consChart });
  });
}

export async function saveUnit(input: Actor & {
  area: string; unit: string; title: string; companyCode: string;
}): Promise<void> {
  judgeReason(input);
  await withTenant(input.client, async (tx) => {
    await judgeArea(tx, input.client, input.area);
    const [company] = await tx.select().from(foundationCompanyCode).where(and(
      eq(foundationCompanyCode.client, input.client), eq(foundationCompanyCode.companyCode, input.companyCode),
    ));
    if (!company) fail(`Company code ${input.companyCode} does not stand.`);
    const unit = input.unit.toUpperCase();
    await tx.insert(consolidationUnit).values({
      client: input.client, area: input.area, unit, title: input.title,
      companyCode: input.companyCode, createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationUnit.client, consolidationUnit.area, consolidationUnit.unit],
      set: { title: input.title, companyCode: input.companyCode, updatedBy: input.changedBy, updatedAt: new Date() },
    });
    await audit(tx, input, `area/${input.area}/unit/${unit}`, { unit, companyCode: input.companyCode });
  });
}

export async function saveGroup(input: Actor & {
  area: string; group: string; title: string; parentGroup?: string;
}): Promise<void> {
  judgeReason(input);
  const group = input.group.toUpperCase();
  const parent = (input.parentGroup ?? '').toUpperCase();
  if (parent === group) fail('A group cannot be its own parent.');
  await withTenant(input.client, async (tx) => {
    await judgeArea(tx, input.client, input.area);
    if (parent) {
      // Cycle judge: walk the parent chain; the new parent must not descend from this group.
      let cursor = parent;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === group) fail(`Group ${parent} already descends from ${group}; the hierarchy would cycle.`);
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const [row] = await tx.select().from(consolidationGroup).where(and(
          eq(consolidationGroup.client, input.client), eq(consolidationGroup.area, input.area),
          eq(consolidationGroup.groupName, cursor),
        ));
        if (!row) fail(`Parent group ${parent} does not stand in area ${input.area}.`);
        cursor = row.parentGroup ?? '';
      }
    }
    await tx.insert(consolidationGroup).values({
      client: input.client, area: input.area, groupName: group, title: input.title,
      parentGroup: parent || null, createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationGroup.client, consolidationGroup.area, consolidationGroup.groupName],
      set: { title: input.title, parentGroup: parent || null, updatedBy: input.changedBy, updatedAt: new Date() },
    });
    await audit(tx, input, `area/${input.area}/group/${group}`, { group, parentGroup: parent });
  });
}

export async function assignUnit(input: Actor & {
  area: string; group: string; unit: string; validFrom: string; validTo: string;
}): Promise<void> {
  judgeReason(input);
  if (input.validFrom > input.validTo) fail('The assignment validity is inverted.');
  await withTenant(input.client, async (tx) => {
    await judgeArea(tx, input.client, input.area);
    const [groupRow] = await tx.select().from(consolidationGroup).where(and(
      eq(consolidationGroup.client, input.client), eq(consolidationGroup.area, input.area),
      eq(consolidationGroup.groupName, input.group),
    ));
    if (!groupRow) fail(`Group ${input.group} does not stand in area ${input.area}.`);
    const [unitRow] = await tx.select().from(consolidationUnit).where(and(
      eq(consolidationUnit.client, input.client), eq(consolidationUnit.area, input.area),
      eq(consolidationUnit.unit, input.unit),
    ));
    if (!unitRow) fail(`Unit ${input.unit} does not stand in area ${input.area}.`);
    const overlaps = await tx.select().from(consolidationUnitAssignment).where(and(
      eq(consolidationUnitAssignment.client, input.client),
      eq(consolidationUnitAssignment.area, input.area),
      eq(consolidationUnitAssignment.unit, input.unit),
      sql`${consolidationUnitAssignment.validFrom} <= ${input.validTo}`,
      sql`${consolidationUnitAssignment.validTo} >= ${input.validFrom}`,
    ));
    if (overlaps.length > 0) {
      fail(`Unit ${input.unit} already stands assigned ${overlaps[0]!.validFrom} to ${overlaps[0]!.validTo}; overlapping assignments are refused.`);
    }
    await tx.insert(consolidationUnitAssignment).values({
      client: input.client, area: input.area, groupName: input.group, unit: input.unit,
      validFrom: input.validFrom, validTo: input.validTo, createdBy: input.changedBy,
    });
    await audit(tx, input, `area/${input.area}/assignment/${input.unit}/${input.validFrom}`,
      { group: input.group, unit: input.unit, validFrom: input.validFrom, validTo: input.validTo });
  });
}

export async function saveGroupAccount(input: Actor & {
  consChart: string; account: string; title: string;
}): Promise<void> {
  judgeReason(input);
  await withTenant(input.client, async (tx) => {
    await tx.insert(consolidationGroupAccount).values({
      client: input.client, consChart: input.consChart.toUpperCase(),
      account: input.account, title: input.title, createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationGroupAccount.client, consolidationGroupAccount.consChart, consolidationGroupAccount.account],
      set: { title: input.title, updatedBy: input.changedBy, updatedAt: new Date() },
    });
    await audit(tx, input, `chart/${input.consChart}/account/${input.account}`, { account: input.account });
  });
}

export async function saveMapping(input: Actor & {
  consChart: string; sourceChart: string; sourceFrom: string; sourceTo: string; groupAccount: string;
}): Promise<void> {
  judgeReason(input);
  if (input.sourceFrom > input.sourceTo) fail('The source account range is inverted.');
  await withTenant(input.client, async (tx) => {
    const [chart] = await tx.select().from(chartOfAccounts).where(and(
      eq(chartOfAccounts.client, input.client), eq(chartOfAccounts.chartOfAccounts, input.sourceChart),
    ));
    if (!chart) fail(`Source chart of accounts ${input.sourceChart} does not stand.`);
    const [groupAccount] = await tx.select().from(consolidationGroupAccount).where(and(
      eq(consolidationGroupAccount.client, input.client),
      eq(consolidationGroupAccount.consChart, input.consChart),
      eq(consolidationGroupAccount.account, input.groupAccount),
    ));
    if (!groupAccount) fail(`Group account ${input.groupAccount} does not stand in consolidation chart ${input.consChart}.`, 'Define the group account first.');
    const [source] = await tx.select().from(glAccount).where(and(
      eq(glAccount.client, input.client), eq(glAccount.chartOfAccounts, input.sourceChart),
      eq(glAccount.accountNumber, input.sourceFrom),
    ));
    if (!source) fail(`Source account ${input.sourceFrom} does not stand in chart ${input.sourceChart}.`);
    await tx.insert(consolidationAccountMapping).values({
      client: input.client, consChart: input.consChart.toUpperCase(), sourceChart: input.sourceChart,
      sourceFrom: input.sourceFrom, sourceTo: input.sourceTo, groupAccount: input.groupAccount,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationAccountMapping.client, consolidationAccountMapping.consChart,
        consolidationAccountMapping.sourceChart, consolidationAccountMapping.sourceFrom,
        consolidationAccountMapping.sourceTo],
      set: { groupAccount: input.groupAccount, updatedBy: input.changedBy, updatedAt: new Date() },
    });
    await audit(tx, input, `chart/${input.consChart}/mapping/${input.sourceChart}/${input.sourceFrom}`,
      { sourceFrom: input.sourceFrom, sourceTo: input.sourceTo, groupAccount: input.groupAccount });
  });
}

export async function saveMethod(input: Actor & {
  area: string; method: string; kind: MethodKind; title: string;
}): Promise<void> {
  judgeReason(input);
  if (!METHOD_KINDS.includes(input.kind)) fail(`Method kind ${input.kind} is not a configured kind.`);
  await withTenant(input.client, async (tx) => {
    await judgeArea(tx, input.client, input.area);
    const method = input.method.toUpperCase();
    await tx.insert(consolidationMethod).values({
      client: input.client, area: input.area, method, kind: input.kind,
      title: input.title, createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationMethod.client, consolidationMethod.area, consolidationMethod.method],
      set: { kind: input.kind, title: input.title, updatedBy: input.changedBy, updatedAt: new Date() },
    });
    await audit(tx, input, `area/${input.area}/method/${method}`, { method, kind: input.kind });
  });
}

export async function saveVersion(input: Actor & {
  area: string; version: string; title: string;
}): Promise<void> {
  judgeReason(input);
  const version = input.version.toUpperCase();
  if (!/^[A-Z0-9]{1,3}$/.test(version)) fail(`Version ${input.version} is not a configured version key.`, 'Versions run 1–3 characters.');
  await withTenant(input.client, async (tx) => {
    await judgeArea(tx, input.client, input.area);
    await tx.insert(consolidationVersion).values({
      client: input.client, area: input.area, version, title: input.title, createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationVersion.client, consolidationVersion.area, consolidationVersion.version],
      set: { title: input.title, updatedBy: input.changedBy, updatedAt: new Date() },
    });
    await audit(tx, input, `area/${input.area}/version/${version}`, { version });
  });
}

export async function saveTask(input: Actor & {
  area: string; version: string; task: string; parentTask?: string; sequence: number;
  taskType: TaskType; method?: string; unit?: string; group?: string;
  validFrom: string; validTo: string;
}): Promise<void> {
  judgeReason(input);
  if (input.validFrom > input.validTo) fail('The task validity is inverted.');
  if (!TASK_TYPES.includes(input.taskType)) fail(`Task type ${input.taskType} is not a configured type.`);
  const task = input.task.toUpperCase();
  const parent = (input.parentTask ?? '').toUpperCase();
  if (parent === task) fail('A task cannot be its own parent.');
  await withTenant(input.client, async (tx) => {
    await judgeArea(tx, input.client, input.area);
    const [version] = await tx.select().from(consolidationVersion).where(and(
      eq(consolidationVersion.client, input.client), eq(consolidationVersion.area, input.area),
      eq(consolidationVersion.version, input.version),
    ));
    if (!version) fail(`Version ${input.version} does not stand in area ${input.area}.`, 'Define the version first.');
    if (parent) {
      let cursor = parent;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === task) fail(`Task ${parent} already descends from ${task}; the hierarchy would cycle.`);
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const [row] = await tx.select().from(consolidationTask).where(and(
          eq(consolidationTask.client, input.client), eq(consolidationTask.area, input.area),
          eq(consolidationTask.version, input.version), eq(consolidationTask.task, cursor),
        ));
        if (!row) fail(`Parent task ${parent} does not stand in version ${input.version}.`);
        cursor = row.parentTask ?? '';
      }
    }
    if (input.method) {
      const [method] = await tx.select().from(consolidationMethod).where(and(
        eq(consolidationMethod.client, input.client), eq(consolidationMethod.area, input.area),
        eq(consolidationMethod.method, input.method),
      ));
      if (!method) fail(`Method ${input.method} does not stand in area ${input.area}.`, 'Define the method first; a task may not reference unconfigured configuration.');
    }
    if (input.unit) {
      const [unit] = await tx.select().from(consolidationUnit).where(and(
        eq(consolidationUnit.client, input.client), eq(consolidationUnit.area, input.area),
        eq(consolidationUnit.unit, input.unit),
      ));
      if (!unit) fail(`Unit ${input.unit} does not stand in area ${input.area}.`);
    }
    if (input.group) {
      const [group] = await tx.select().from(consolidationGroup).where(and(
        eq(consolidationGroup.client, input.client), eq(consolidationGroup.area, input.area),
        eq(consolidationGroup.groupName, input.group),
      ));
      if (!group) fail(`Group ${input.group} does not stand in area ${input.area}.`);
    }
    await tx.insert(consolidationTask).values({
      client: input.client, area: input.area, version: input.version, task,
      parentTask: parent || null, sequence: input.sequence, taskType: input.taskType,
      method: input.method || null, unit: input.unit || null, groupName: input.group || null,
      validFrom: input.validFrom, validTo: input.validTo, createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [consolidationTask.client, consolidationTask.area, consolidationTask.version, consolidationTask.task],
      set: {
        parentTask: parent || null, sequence: input.sequence, taskType: input.taskType,
        method: input.method || null, unit: input.unit || null, groupName: input.group || null,
        validFrom: input.validFrom, validTo: input.validTo,
        updatedBy: input.changedBy, updatedAt: new Date(),
      },
    });
    await audit(tx, input, `area/${input.area}/version/${input.version}/task/${task}`,
      { task, taskType: input.taskType, method: input.method ?? '', unit: input.unit ?? '', group: input.group ?? '' });
  });
}

export async function activateArea(input: Actor & { area: string }): Promise<void> {
  judgeReason(input);
  await withTenant(input.client, async (tx) => {
    const area = await judgeArea(tx, input.client, input.area);
    const units = await tx.select({ unit: consolidationUnit.unit }).from(consolidationUnit).where(and(
      eq(consolidationUnit.client, input.client), eq(consolidationUnit.area, input.area),
    ));
    const versions = await tx.select({ version: consolidationVersion.version }).from(consolidationVersion).where(and(
      eq(consolidationVersion.client, input.client), eq(consolidationVersion.area, input.area),
    ));
    const tasks = await tx.select({ task: consolidationTask.task }).from(consolidationTask).where(and(
      eq(consolidationTask.client, input.client), eq(consolidationTask.area, input.area),
    ));
    const missing: string[] = [];
    if (!area.dataBasis) missing.push('data basis');
    if (!area.consChart) missing.push('consolidation chart');
    if (!area.fiscalYearVariant) missing.push('fiscal year variant');
    if (units.length === 0) missing.push('at least one consolidation unit');
    if (versions.length === 0) missing.push('at least one version');
    if (tasks.length === 0) missing.push('at least one task');
    if (missing.length > 0) {
      fail(`Area ${input.area} cannot activate; incomplete configuration: ${missing.join(', ')}.`,
        'Complete the configuration, then activate. Incomplete configuration never affects a run.');
    }
    await tx.update(consolidationArea).set({ status: 'ACTIVE', updatedBy: input.changedBy, updatedAt: new Date() })
      .where(and(eq(consolidationArea.client, input.client), eq(consolidationArea.area, input.area)));
    await audit(tx, input, `area/${input.area}`, { area: input.area, status: 'ACTIVE' });
  });
}

/**
 * OMCY — Inventory Management search procedures.
 *
 * Usage is H. Application is ME. The key is KALSM, one to six uppercase
 * letters or digits. The description is VTXTM, at most thirty characters.
 * This application keeps one description, not a language table.
 *
 * A step names a standing strategy type. The step number is three digits
 * and the counter is two digits. Neither need be gap-free. A requirement,
 * a manual indicator, and a movement-type allocation are not stored.
 * Naming a strategy type does not select a batch.
 */
import { and, asc, eq, or, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchSearchAllocation, batchSearchProcedure, batchSearchProcedureStep, batchStrategyType } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHSEARCH.DEFINE';
export const ROUTE = '/config/batch-search-procedures';
export const ALIAS = 'OMCY';
export const LOCK_OBJECT = 'BATCH_SEARCH_PROCEDURE';
export const USAGE = 'H';
export const APPLICATION = 'ME';

export const NOT_EXECUTED = [
  {
    field: 'KOBED',
    title: 'Requirement',
    reason: 'No requirement routine is implemented. User-supplied code is not executed.',
  },
  {
    field: 'KAUTO',
    title: 'Manual indicator',
    reason: 'No determination runs, so a step is neither manual nor automatic.',
  },
  {
    field: 'OMCG',
    title: 'Movement-type allocation',
    reason: 'The assignment is maintained on OMCG. This screen does not assign a movement type, and a goods movement is not changed.',
  },
] as const;

export class BatchSearchProcedureError extends Error {
  readonly code:
    | 'AUTHORITY_REQUIRED'
    | 'KEY_UNKNOWN'
    | 'TYPE_UNKNOWN'
    | 'DUPLICATE'
    | 'DESCRIPTION_REQUIRED'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED'
    | 'CONFIRM_REQUIRED'
    | 'TRANSPORT_REFUSED'
    | 'PLANT_REFUSED'
    | 'SCOPE_REFUSED'
    | 'STEP_REFUSED'
    | 'STEP_UNKNOWN'
    | 'STEP_DUPLICATE'
    | 'STRATEGY_UNKNOWN'
    | 'CITED';

  constructor(message: string, code: BatchSearchProcedureError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchSearchProcedureError';
    this.code = code;
  }
}

export interface BatchSearchProcedureRow {
  searchProcedure: string;
  description: string;
  usage: typeof USAGE;
  application: typeof APPLICATION;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}

export interface BatchSearchProcedureStepRow {
  searchProcedure: string;
  stepNumber: string;
  counter: string;
  strategyType: string;
  version: number;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchSearchProcedureError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMCY does not use a second permission code.',
    );
  }
}

function keyOf(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(key)) {
    throw new BatchSearchProcedureError(
      `Search procedure ${value.trim() || 'blank'} is not a key. Use one to six uppercase letters or digits.`,
      'KEY_UNKNOWN',
      'The key is six characters at most. A strategy type is not a search procedure.',
    );
  }
  return key;
}

function descriptionOf(value: string): string {
  const text = value.trim();
  if (!text || text.length > 30) {
    throw new BatchSearchProcedureError(
      'The description is required and may be at most 30 characters.',
      'DESCRIPTION_REQUIRED',
      'Enter a name of at most 30 characters. A language table is not stored.',
    );
  }
  return text;
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchSearchProcedureError('A reason is required.', 'REASON_REQUIRED', 'Say why this search procedure is being saved.');
  }
  return text;
}

function stepNumberOf(value: string): string {
  const text = value.trim();
  if (!/^\d{1,3}$/.test(text)) {
    throw new BatchSearchProcedureError(
      `Step ${text || 'blank'} is not three digits. Nothing was saved.`,
      'STEP_UNKNOWN',
      'Use 000 to 999. The number need not follow the previous one.',
    );
  }
  return text.padStart(3, '0');
}

function counterOf(value: string): string {
  const text = value.trim();
  if (!/^\d{1,2}$/.test(text)) {
    throw new BatchSearchProcedureError(
      `Counter ${text || 'blank'} is not two digits. Nothing was saved.`,
      'STEP_UNKNOWN',
      'Use 00 to 99. The counter is not assumed.',
    );
  }
  return text.padStart(2, '0');
}

function strategyKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(key)) {
    throw new BatchSearchProcedureError(
      `Strategy type ${value.trim() || 'blank'} does not stand. Nothing was saved.`,
      'STRATEGY_UNKNOWN',
      'Name a strategy type that already stands on OMCW.',
    );
  }
  return key;
}

function refuseExtras(input: {
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  movementType?: string;
  requirement?: string;
  manual?: string;
  strategyType?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchSearchProcedureError('A transport is refused. OMCY does not write a transport request.', 'TRANSPORT_REFUSED', 'Save the search procedure in this client. No transport mechanism carries it.');
  }
  if (input.plant?.trim()) {
    throw new BatchSearchProcedureError('A plant is refused. An Inventory Management search procedure is not a plant.', 'PLANT_REFUSED', 'Do not send a plant.');
  }
  const usage = (input.usage ?? '').trim().toUpperCase();
  const application = (input.application ?? '').trim().toUpperCase();
  if ((usage && usage !== USAGE) || (application && application !== APPLICATION)) {
    throw new BatchSearchProcedureError(
      `Usage ${usage || USAGE} and application ${application || APPLICATION} are refused. OMCY stores usage H and application ME only.`,
      'SCOPE_REFUSED',
      'Production and sales search procedures are not this screen.',
    );
  }
  const sent = [input.movementType, input.requirement, input.manual, input.strategyType].find((value) => value?.trim());
  if (sent) {
    throw new BatchSearchProcedureError(
      `Control ${sent.trim()} is not stored on the procedure header. It does not select a batch.`,
      'STEP_REFUSED',
      'Add a step after the procedure stands. A movement type is not assigned here.',
    );
  }
}

function rowOf(row: {
  searchProcedure: string;
  description: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}): BatchSearchProcedureRow {
  return {
    searchProcedure: row.searchProcedure,
    description: row.description,
    usage: USAGE,
    application: APPLICATION,
    version: row.version,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

async function bumpHeader(tx: Tx, client: string, key: string, changedBy: string, now: Date, version: number): Promise<void> {
  await tx.update(batchSearchProcedure).set({ version, changedBy, changedAt: now }).where(and(
    eq(batchSearchProcedure.client, client),
    eq(batchSearchProcedure.usage, USAGE),
    eq(batchSearchProcedure.application, APPLICATION),
    eq(batchSearchProcedure.searchProcedure, key),
  ));
}

export async function listBatchSearchProcedures(client: string): Promise<BatchSearchProcedureRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      searchProcedure: batchSearchProcedure.searchProcedure,
      description: batchSearchProcedure.description,
      version: batchSearchProcedure.version,
      changedBy: batchSearchProcedure.changedBy,
      changedAt: batchSearchProcedure.changedAt,
    }).from(batchSearchProcedure)
      .where(and(
        eq(batchSearchProcedure.client, client),
        eq(batchSearchProcedure.usage, USAGE),
        eq(batchSearchProcedure.application, APPLICATION),
      ))
      .orderBy(asc(batchSearchProcedure.searchProcedure));
    return rows.map(rowOf);
  });
}

export async function saveBatchSearchProcedure(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  searchProcedure: string;
  description: string;
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  movementType?: string;
  requirement?: string;
  manual?: string;
  strategyType?: string;
}): Promise<BatchSearchProcedureRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const key = keyOf(input.searchProcedure);
  const description = descriptionOf(input.description);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_SEARCH_PROCEDURE/${key}`}))`);
    const [existing] = await tx.select().from(batchSearchProcedure).where(and(
      eq(batchSearchProcedure.client, input.client),
      eq(batchSearchProcedure.usage, USAGE),
      eq(batchSearchProcedure.application, APPLICATION),
      eq(batchSearchProcedure.searchProcedure, key),
    )).for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new BatchSearchProcedureError(`Search procedure ${key} already stands. Nothing was saved.`, 'DUPLICATE', 'Change the standing procedure, or choose another key.');
      }
      if (!input.confirmed) {
        throw new BatchSearchProcedureError('The change was not confirmed. Nothing was saved.', 'CONFIRM_REQUIRED', 'Confirm the save. No batch is selected and no stock is posted.');
      }
      const reason = reasonOf(input.reason);
      const now = new Date();
      await tx.insert(batchSearchProcedure).values({
        client: input.client, usage: USAGE, application: APPLICATION, searchProcedure: key, description,
        version: 1, createdBy: input.changedBy, changedBy: input.changedBy, changedAt: now,
      });
      await recordChange(tx, {
        client: input.client, objectClass: 'batch_search_procedure', objectKey: key, changeType: 'CREATE',
        changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
        after: { usage: USAGE, application: APPLICATION, searchProcedure: key, description },
      });
      await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
      return { searchProcedure: key, description, usage: USAGE, application: APPLICATION, version: 1, changedBy: input.changedBy, changedAt: now };
    }
    if (!existing) {
      throw new BatchSearchProcedureError(`Search procedure ${key} does not stand. Nothing was saved.`, 'TYPE_UNKNOWN', 'Create it first. OMCY does not invent a standard search procedure.');
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchSearchProcedureError(
        `Search procedure ${key} was opened at version ${input.expectedVersion ?? 'blank'}, and version ${existing.version} now stands. Nothing was saved.`,
        'VERSION_STALE', 'Open the search procedure again.',
      );
    }
    if (existing.description === description) return rowOf(existing);
    if (!input.confirmed) {
      throw new BatchSearchProcedureError('The change was not confirmed. Nothing was saved.', 'CONFIRM_REQUIRED', 'Confirm the save. A posted movement is not rewritten, and no batch is selected.');
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const version = existing.version + 1;
    await tx.update(batchSearchProcedure).set({ description, version, changedBy: input.changedBy, changedAt: now }).where(and(
      eq(batchSearchProcedure.client, input.client),
      eq(batchSearchProcedure.usage, USAGE),
      eq(batchSearchProcedure.application, APPLICATION),
      eq(batchSearchProcedure.searchProcedure, key),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_procedure', objectKey: key, changeType: 'CHANGE',
      changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { description: existing.description, version: existing.version },
      after: { description, version },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return { searchProcedure: key, description, usage: USAGE, application: APPLICATION, version, changedBy: input.changedBy, changedAt: now };
  });
}

export async function deleteBatchSearchProcedure(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  searchProcedure: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ searchProcedure: string }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchSearchProcedureError('A transport is refused. OMCY does not write a transport request.', 'TRANSPORT_REFUSED', 'Delete the search procedure in this client.');
  }
  const key = keyOf(input.searchProcedure);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_SEARCH_PROCEDURE/${key}`}))`);
    const [existing] = await tx.select().from(batchSearchProcedure).where(and(
      eq(batchSearchProcedure.client, input.client),
      eq(batchSearchProcedure.usage, USAGE),
      eq(batchSearchProcedure.application, APPLICATION),
      eq(batchSearchProcedure.searchProcedure, key),
    )).for('update');
    if (!existing) {
      throw new BatchSearchProcedureError(`Search procedure ${key} does not stand. Nothing was deleted.`, 'TYPE_UNKNOWN', 'Choose a search procedure from the list.');
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchSearchProcedureError(
        `Search procedure ${key} was opened at version ${input.expectedVersion}, and version ${existing.version} now stands. Nothing was deleted.`,
        'VERSION_STALE', 'Open the search procedure again.',
      );
    }
    const [cited] = await tx.select({
      movementType: batchSearchAllocation.movementType,
    }).from(batchSearchAllocation).where(and(
      eq(batchSearchAllocation.client, input.client),
      eq(batchSearchAllocation.usage, USAGE),
      eq(batchSearchAllocation.application, APPLICATION),
      or(
        eq(batchSearchAllocation.searchProcedure, key),
        eq(batchSearchAllocation.transferProcedure, key),
      ),
    )).limit(1);
    if (cited) {
      throw new BatchSearchProcedureError(
        `Search procedure ${key} is allocated to movement type ${cited.movementType}. Nothing was deleted.`,
        'CITED',
        'Remove the allocation on OMCG first. The movement type is not changed here.',
      );
    }
    if (!input.confirmed) {
      throw new BatchSearchProcedureError('The deletion was not confirmed. Nothing was deleted.', 'CONFIRM_REQUIRED', 'Confirm the deletion. No posted movement is rewritten.');
    }
    const reason = reasonOf(input.reason);
    const steps = await tx.select({
      stepNumber: batchSearchProcedureStep.stepNumber,
      counter: batchSearchProcedureStep.counter,
      strategyType: batchSearchProcedureStep.strategyType,
    }).from(batchSearchProcedureStep).where(and(
      eq(batchSearchProcedureStep.client, input.client),
      eq(batchSearchProcedureStep.usage, USAGE),
      eq(batchSearchProcedureStep.application, APPLICATION),
      eq(batchSearchProcedureStep.searchProcedure, key),
    ));
    await tx.delete(batchSearchProcedureStep).where(and(
      eq(batchSearchProcedureStep.client, input.client),
      eq(batchSearchProcedureStep.usage, USAGE),
      eq(batchSearchProcedureStep.application, APPLICATION),
      eq(batchSearchProcedureStep.searchProcedure, key),
    ));
    await tx.delete(batchSearchProcedure).where(and(
      eq(batchSearchProcedure.client, input.client),
      eq(batchSearchProcedure.usage, USAGE),
      eq(batchSearchProcedure.application, APPLICATION),
      eq(batchSearchProcedure.searchProcedure, key),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_procedure', objectKey: key, changeType: 'DELETE',
      changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { description: existing.description, version: existing.version, steps },
    });
    return { searchProcedure: key };
  });
}

export async function listBatchSearchProcedureSteps(client: string, searchProcedure: string): Promise<BatchSearchProcedureStepRow[]> {
  const key = searchProcedure.trim().toUpperCase();
  if (!key) return [];
  return withTenant(client, async (tx) => tx.select({
    searchProcedure: batchSearchProcedureStep.searchProcedure,
    stepNumber: batchSearchProcedureStep.stepNumber,
    counter: batchSearchProcedureStep.counter,
    strategyType: batchSearchProcedureStep.strategyType,
    version: batchSearchProcedureStep.version,
  }).from(batchSearchProcedureStep).where(and(
    eq(batchSearchProcedureStep.client, client),
    eq(batchSearchProcedureStep.usage, USAGE),
    eq(batchSearchProcedureStep.application, APPLICATION),
    eq(batchSearchProcedureStep.searchProcedure, key),
  )).orderBy(asc(batchSearchProcedureStep.stepNumber), asc(batchSearchProcedureStep.counter)));
}

export async function saveBatchSearchProcedureStep(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  searchProcedure: string;
  stepNumber: string;
  counter: string;
  strategyType: string;
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  movementType?: string;
  requirement?: string;
  manual?: string;
}): Promise<BatchSearchProcedureStepRow & { procedureVersion: number }> {
  assertAuthority(input.capabilities);
  refuseExtras({ ...input, strategyType: undefined });
  const procedure = keyOf(input.searchProcedure);
  const stepNumber = stepNumberOf(input.stepNumber);
  const counter = counterOf(input.counter);
  const strategyType = strategyKey(input.strategyType);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_SEARCH_PROCEDURE/${procedure}`}))`);
    const [header] = await tx.select().from(batchSearchProcedure).where(and(
      eq(batchSearchProcedure.client, input.client),
      eq(batchSearchProcedure.usage, USAGE),
      eq(batchSearchProcedure.application, APPLICATION),
      eq(batchSearchProcedure.searchProcedure, procedure),
    )).for('update');
    if (!header) {
      throw new BatchSearchProcedureError(`Search procedure ${procedure} does not stand. Nothing was saved.`, 'TYPE_UNKNOWN', 'Create the search procedure first. A step does not invent one.');
    }
    if (header.version !== input.expectedVersion) {
      throw new BatchSearchProcedureError(
        `Search procedure ${procedure} was opened at version ${input.expectedVersion ?? 'blank'}, and version ${header.version} now stands. Nothing was saved.`,
        'VERSION_STALE', 'Open the search procedure again.',
      );
    }
    const [standing] = await tx.select({ strategyType: batchStrategyType.strategyType }).from(batchStrategyType).where(and(
      eq(batchStrategyType.client, input.client),
      eq(batchStrategyType.usage, USAGE),
      eq(batchStrategyType.application, APPLICATION),
      eq(batchStrategyType.strategyType, strategyType),
    )).limit(1).for('update');
    if (!standing) {
      throw new BatchSearchProcedureError(
        `Strategy type ${strategyType} does not stand. Nothing was saved.`,
        'STRATEGY_UNKNOWN',
        'Create it on OMCW first. A step does not invent a strategy type, and naming one does not select a batch.',
      );
    }
    const [existing] = await tx.select().from(batchSearchProcedureStep).where(and(
      eq(batchSearchProcedureStep.client, input.client),
      eq(batchSearchProcedureStep.usage, USAGE),
      eq(batchSearchProcedureStep.application, APPLICATION),
      eq(batchSearchProcedureStep.searchProcedure, procedure),
      eq(batchSearchProcedureStep.stepNumber, stepNumber),
      eq(batchSearchProcedureStep.counter, counter),
    )).for('update');
    if (input.mode === 'CREATE' && existing) {
      throw new BatchSearchProcedureError(`Step ${stepNumber} counter ${counter} already stands on ${procedure}. Nothing was saved.`, 'STEP_DUPLICATE', 'Change the standing step, or choose another number. The numbers need not be gap-free.');
    }
    if (input.mode === 'CHANGE' && !existing) {
      throw new BatchSearchProcedureError(`Step ${stepNumber} counter ${counter} does not stand on ${procedure}. Nothing was saved.`, 'STEP_UNKNOWN', 'Create the step first.');
    }
    if (existing && existing.strategyType === strategyType) {
      return { searchProcedure: procedure, stepNumber, counter, strategyType, version: existing.version, procedureVersion: header.version };
    }
    if (!input.confirmed) {
      throw new BatchSearchProcedureError('The change was not confirmed. Nothing was saved.', 'CONFIRM_REQUIRED', 'Confirm the save. No batch is selected and no stock is posted.');
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const procedureVersion = header.version + 1;
    await bumpHeader(tx, input.client, procedure, input.changedBy, now, procedureVersion);
    if (!existing) {
      await tx.insert(batchSearchProcedureStep).values({
        client: input.client, usage: USAGE, application: APPLICATION, searchProcedure: procedure,
        stepNumber, counter, strategyType, version: 1, createdBy: input.changedBy, changedBy: input.changedBy, changedAt: now,
      });
      await recordChange(tx, {
        client: input.client, objectClass: 'batch_search_procedure_step', objectKey: `${procedure}/${stepNumber}/${counter}`,
        changeType: 'CREATE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
        after: { searchProcedure: procedure, stepNumber, counter, strategyType },
      });
      return { searchProcedure: procedure, stepNumber, counter, strategyType, version: 1, procedureVersion };
    }
    const version = existing.version + 1;
    await tx.update(batchSearchProcedureStep).set({ strategyType, version, changedBy: input.changedBy, changedAt: now }).where(and(
      eq(batchSearchProcedureStep.client, input.client),
      eq(batchSearchProcedureStep.usage, USAGE),
      eq(batchSearchProcedureStep.application, APPLICATION),
      eq(batchSearchProcedureStep.searchProcedure, procedure),
      eq(batchSearchProcedureStep.stepNumber, stepNumber),
      eq(batchSearchProcedureStep.counter, counter),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_procedure_step', objectKey: `${procedure}/${stepNumber}/${counter}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { strategyType: existing.strategyType, version: existing.version },
      after: { strategyType, version },
    });
    return { searchProcedure: procedure, stepNumber, counter, strategyType, version, procedureVersion };
  });
}

export async function deleteBatchSearchProcedureStep(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  searchProcedure: string;
  stepNumber: string;
  counter: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ searchProcedure: string; stepNumber: string; counter: string; procedureVersion: number }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchSearchProcedureError('A transport is refused. OMCY does not write a transport request.', 'TRANSPORT_REFUSED', 'Delete the step in this client.');
  }
  const procedure = keyOf(input.searchProcedure);
  const stepNumber = stepNumberOf(input.stepNumber);
  const counter = counterOf(input.counter);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_SEARCH_PROCEDURE/${procedure}`}))`);
    const [header] = await tx.select().from(batchSearchProcedure).where(and(
      eq(batchSearchProcedure.client, input.client),
      eq(batchSearchProcedure.usage, USAGE),
      eq(batchSearchProcedure.application, APPLICATION),
      eq(batchSearchProcedure.searchProcedure, procedure),
    )).for('update');
    if (!header) {
      throw new BatchSearchProcedureError(`Search procedure ${procedure} does not stand. Nothing was deleted.`, 'TYPE_UNKNOWN', 'Choose a search procedure from the list.');
    }
    if (header.version !== input.expectedVersion) {
      throw new BatchSearchProcedureError(
        `Search procedure ${procedure} was opened at version ${input.expectedVersion}, and version ${header.version} now stands. Nothing was deleted.`,
        'VERSION_STALE', 'Open the search procedure again.',
      );
    }
    const [existing] = await tx.select().from(batchSearchProcedureStep).where(and(
      eq(batchSearchProcedureStep.client, input.client),
      eq(batchSearchProcedureStep.usage, USAGE),
      eq(batchSearchProcedureStep.application, APPLICATION),
      eq(batchSearchProcedureStep.searchProcedure, procedure),
      eq(batchSearchProcedureStep.stepNumber, stepNumber),
      eq(batchSearchProcedureStep.counter, counter),
    )).for('update');
    if (!existing) {
      throw new BatchSearchProcedureError(`Step ${stepNumber} counter ${counter} does not stand on ${procedure}. Nothing was deleted.`, 'STEP_UNKNOWN', 'Choose a step from the list.');
    }
    if (!input.confirmed) {
      throw new BatchSearchProcedureError('The deletion was not confirmed. Nothing was deleted.', 'CONFIRM_REQUIRED', 'Confirm the deletion. No posted movement is rewritten.');
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const procedureVersion = header.version + 1;
    await tx.delete(batchSearchProcedureStep).where(and(
      eq(batchSearchProcedureStep.client, input.client),
      eq(batchSearchProcedureStep.usage, USAGE),
      eq(batchSearchProcedureStep.application, APPLICATION),
      eq(batchSearchProcedureStep.searchProcedure, procedure),
      eq(batchSearchProcedureStep.stepNumber, stepNumber),
      eq(batchSearchProcedureStep.counter, counter),
    ));
    await bumpHeader(tx, input.client, procedure, input.changedBy, now, procedureVersion);
    await recordChange(tx, {
      client: input.client, objectClass: 'batch_search_procedure_step', objectKey: `${procedure}/${stepNumber}/${counter}`,
      changeType: 'DELETE', changedBy: input.changedBy, transactionCode: ACTIVITY, reason,
      before: { strategyType: existing.strategyType, version: existing.version },
    });
    return { searchProcedure: procedure, stepNumber, counter, procedureVersion };
  });
}

/**
 * OMCW — Inventory Management strategy types. View VV_T685H_ME.
 *
 * The condition-technique usage is H. The application is ME. The key is
 * the condition type, one to four uppercase letters or digits. The name
 * is one description of at most twenty characters. This application keeps
 * one description, not a language table.
 *
 * An access sequence is optional. A non-blank value must name a standing
 * OMCX sequence in this client. Naming it does not run an access.
 * Selection classes, sort rules, quantity-proposal exits, and batch
 * splits are not stored. A strategy type does not select a batch.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { batchAccessSequence, batchSearchProcedureStep, batchSearchStrategy, batchStrategyType } from './schema';

export const ACTIVITY = 'CFG.INV.BATCHSTRATEGY.DEFINE';
export const ROUTE = '/config/batch-strategy-types';
export const ALIAS = 'OMCW';
export const LOCK_OBJECT = 'BATCH_STRATEGY_TYPE';
export const USAGE = 'H';
export const APPLICATION = 'ME';

export const NOT_EXECUTED = [
  {
    field: 'CLASS_SEL',
    title: 'Selection class',
    reason: 'Class type 023 is not active. A selection class is not stored, and it does not filter a batch.',
  },
  {
    field: 'CLASS_SRT',
    title: 'Sort sequence',
    reason: 'No sort rule stands. FEFO is not assumed.',
  },
  {
    field: 'CHMVS',
    title: 'Quantity proposal exit',
    reason: 'The exit is a three-digit routine number, not a quantity code. No routine is implemented. 1 is not stored as total quantity.',
  },
  {
    field: 'CHASP',
    title: 'Number of batch splits',
    reason: 'No allocation runs. A split limit is not stored, and no default of 1 or 3 is invented.',
  },
  {
    field: 'CHSPL',
    title: 'Batch splits changeable',
    reason: 'There is no proposed split to change.',
  },
  {
    field: 'CHVLL',
    title: 'Overdelivery allowed',
    reason: 'No proposal can exceed a requirement, because no proposal is made.',
  },
  {
    field: 'CHMDG',
    title: 'Dialog batch determination',
    reason: 'Determination does not run in the foreground or the background.',
  },
  {
    field: 'CHMAN',
    title: 'Manual batch determination',
    reason: 'A goods movement still requires the batch the user enters. This screen does not propose one.',
  },
  {
    field: 'KZAME',
    title: 'Unit of measure display',
    reason: 'A is the stockkeeping unit and B is the document unit. Neither is stored, because no determination display exists.',
  },
  {
    field: 'CHVSK',
    title: 'Selection type',
    reason: 'Blank, N, O, and F are the verified codes. None is stored, because determination does not start.',
  },
  {
    field: 'CHANZ',
    title: 'Maximum batches to read',
    reason: 'No candidate list is read.',
  },
  {
    field: 'MBC1',
    title: 'Search strategy',
    reason: 'A search procedure is maintained on OMCY. Assigning it to a movement type is not this screen. A strategy type alone does not find a batch.',
  },
] as const;

export class BatchStrategyTypeError extends Error {
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
    | 'ACCESS_UNKNOWN'
    | 'CONTROL_REFUSED'
    | 'CITED';

  constructor(message: string, code: BatchStrategyTypeError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchStrategyTypeError';
    this.code = code;
  }
}

export interface BatchStrategyTypeRow {
  strategyType: string;
  description: string;
  accessSequence: string;
  usage: typeof USAGE;
  application: typeof APPLICATION;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}

function assertAuthority(capabilities: readonly string[] | undefined): void {
  if (!capabilities || !hasCapability([...capabilities], ACTIVITY)) {
    throw new BatchStrategyTypeError(
      `The authority ${ACTIVITY} is required. Nothing was saved.`,
      'AUTHORITY_REQUIRED',
      'Ask an administrator for that authority. OMCW does not use a second permission code.',
    );
  }
}

function keyOf(value: string): string {
  const key = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(key)) {
    throw new BatchStrategyTypeError(
      `Strategy type ${value.trim() || 'blank'} is not a condition type. Use one to four uppercase letters or digits.`,
      'KEY_UNKNOWN',
      'The key is four characters at most. A movement type is not a strategy type.',
    );
  }
  return key;
}

function descriptionOf(value: string): string {
  const text = value.trim();
  if (!text || text.length > 20) {
    throw new BatchStrategyTypeError(
      'The description is required and may be at most 20 characters.',
      'DESCRIPTION_REQUIRED',
      'Enter a name of at most 20 characters. A language table is not stored.',
    );
  }
  return text;
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3 || text.length > 500) {
    throw new BatchStrategyTypeError('A reason is required.', 'REASON_REQUIRED', 'Say why this strategy type is being saved.');
  }
  return text;
}

function refuseExtras(input: {
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  accessSequence?: string;
  selectionClass?: string;
  classType?: string;
  sortRule?: string;
  quantityProposal?: string;
  batchSplits?: string;
  splitsChangeable?: string;
  overdelivery?: string;
  dialog?: string;
  manual?: string;
  unitDisplay?: string;
  selectionType?: string;
  searchProcedure?: string;
}): void {
  if (input.transportRequest?.trim()) {
    throw new BatchStrategyTypeError(
      'A transport is refused. OMCW does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Save the strategy type in this client. No transport mechanism carries it.',
    );
  }
  if (input.plant?.trim()) {
    throw new BatchStrategyTypeError(
      'A plant is refused. An Inventory Management strategy type is not a plant.',
      'PLANT_REFUSED',
      'Do not send a plant.',
    );
  }
  const usage = (input.usage ?? '').trim().toUpperCase();
  const application = (input.application ?? '').trim().toUpperCase();
  if ((usage && usage !== USAGE) || (application && application !== APPLICATION)) {
    throw new BatchStrategyTypeError(
      `Usage ${usage || USAGE} and application ${application || APPLICATION} are refused. OMCW stores usage H and application ME only.`,
      'SCOPE_REFUSED',
      'Production and sales strategy types are not this screen.',
    );
  }
  const sent = [
    input.selectionClass, input.classType, input.sortRule,
    input.quantityProposal, input.batchSplits, input.splitsChangeable, input.overdelivery,
    input.dialog, input.manual, input.unitDisplay, input.selectionType, input.searchProcedure,
  ].find((value) => value?.trim());
  if (sent) {
    throw new BatchStrategyTypeError(
      `Control ${sent.trim()} is not stored. It does not select a batch.`,
      'CONTROL_REFUSED',
      'Leave selection class, sort rule, quantity proposal, and batch splits unset. Class type 023 is not active, and no determination runs.',
    );
  }
}

async function sequenceOf(tx: Tx, client: string, value: string | undefined): Promise<string> {
  const key = (value ?? '').trim().toUpperCase();
  if (!key) return '';
  if (!/^[A-Z0-9]{1,4}$/.test(key)) {
    throw new BatchStrategyTypeError(
      `Access sequence ${value?.trim() || 'blank'} does not stand. Nothing was saved.`,
      'ACCESS_UNKNOWN',
      'Leave it blank, or name a sequence that already stands on OMCX.',
    );
  }
  const [standing] = await tx.select({ accessSequence: batchAccessSequence.accessSequence })
    .from(batchAccessSequence)
    .where(and(
      eq(batchAccessSequence.client, client),
      eq(batchAccessSequence.usage, USAGE),
      eq(batchAccessSequence.application, APPLICATION),
      eq(batchAccessSequence.accessSequence, key),
    ))
    .limit(1)
    .for('update');
  if (!standing) {
    throw new BatchStrategyTypeError(
      `Access sequence ${key} does not stand. Nothing was saved.`,
      'ACCESS_UNKNOWN',
      'Create it on OMCX first. A strategy type does not invent an access sequence, and naming one does not run an access.',
    );
  }
  return key;
}

function rowOf(row: {
  strategyType: string;
  description: string;
  version: number;
  changedBy: string | null;
  changedAt: Date | null;
}): BatchStrategyTypeRow {
  return {
    strategyType: row.strategyType,
    description: row.description,
    accessSequence: row.accessSequence,
    usage: USAGE,
    application: APPLICATION,
    version: row.version,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

export async function listBatchStrategyTypes(client: string): Promise<BatchStrategyTypeRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      strategyType: batchStrategyType.strategyType,
      description: batchStrategyType.description,
      accessSequence: batchStrategyType.accessSequence,
      version: batchStrategyType.version,
      changedBy: batchStrategyType.changedBy,
      changedAt: batchStrategyType.changedAt,
    }).from(batchStrategyType)
      .where(and(
        eq(batchStrategyType.client, client),
        eq(batchStrategyType.usage, USAGE),
        eq(batchStrategyType.application, APPLICATION),
      ))
      .orderBy(asc(batchStrategyType.strategyType));
    return rows.map(rowOf);
  });
}

export async function saveBatchStrategyType(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  mode: 'CREATE' | 'CHANGE';
  strategyType: string;
  description: string;
  expectedVersion?: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
  plant?: string;
  usage?: string;
  application?: string;
  accessSequence?: string;
  selectionClass?: string;
  classType?: string;
  sortRule?: string;
  quantityProposal?: string;
  batchSplits?: string;
  splitsChangeable?: string;
  overdelivery?: string;
  dialog?: string;
  manual?: string;
  unitDisplay?: string;
  selectionType?: string;
  searchProcedure?: string;
}): Promise<BatchStrategyTypeRow> {
  assertAuthority(input.capabilities);
  refuseExtras(input);
  const key = keyOf(input.strategyType);
  const description = descriptionOf(input.description);
  return withTenant(input.client, async (tx) => {
    const accessSequence = await sequenceOf(tx, input.client, input.accessSequence);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_STRATEGY_TYPE/${key}`}))`);
    const [existing] = await tx.select().from(batchStrategyType).where(and(
      eq(batchStrategyType.client, input.client),
      eq(batchStrategyType.usage, USAGE),
      eq(batchStrategyType.application, APPLICATION),
      eq(batchStrategyType.strategyType, key),
    )).for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        throw new BatchStrategyTypeError(
          `Strategy type ${key} already stands. Nothing was saved.`,
          'DUPLICATE',
          'Change the standing strategy type, or choose another key.',
        );
      }
      if (!input.confirmed) {
        throw new BatchStrategyTypeError(
          'The change was not confirmed. Nothing was saved.',
          'CONFIRM_REQUIRED',
          'Confirm the save. No batch is selected and no stock is posted.',
        );
      }
      const reason = reasonOf(input.reason);
      const now = new Date();
      await tx.insert(batchStrategyType).values({
        client: input.client,
        usage: USAGE,
        application: APPLICATION,
        strategyType: key,
        description,
        accessSequence,
        version: 1,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        changedAt: now,
      });
      await recordChange(tx, {
        client: input.client,
        objectClass: 'batch_strategy_type',
        objectKey: key,
        changeType: 'CREATE',
        changedBy: input.changedBy,
        transactionCode: ACTIVITY,
        reason,
        after: { usage: USAGE, application: APPLICATION, strategyType: key, description, accessSequence },
      });
      await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
      return { strategyType: key, description, accessSequence, usage: USAGE, application: APPLICATION, version: 1, changedBy: input.changedBy, changedAt: now };
    }
    if (!existing) {
      throw new BatchStrategyTypeError(
        `Strategy type ${key} does not stand. Nothing was saved.`,
        'TYPE_UNKNOWN',
        'Create it first. OMCW does not invent a standard strategy type.',
      );
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchStrategyTypeError(
        `Strategy type ${key} was opened at version ${input.expectedVersion ?? 'blank'}, and version ${existing.version} now stands. Nothing was saved.`,
        'VERSION_STALE',
        'Open the strategy type again.',
      );
    }
    if (existing.description === description && existing.accessSequence === accessSequence) {
      return rowOf(existing);
    }
    if (!input.confirmed) {
      throw new BatchStrategyTypeError(
        'The change was not confirmed. Nothing was saved.',
        'CONFIRM_REQUIRED',
        'Confirm the save. A posted movement is not rewritten, and no batch is selected.',
      );
    }
    const reason = reasonOf(input.reason);
    const now = new Date();
    const version = existing.version + 1;
    await tx.update(batchStrategyType).set({
      description,
      accessSequence,
      version,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(batchStrategyType.client, input.client),
      eq(batchStrategyType.usage, USAGE),
      eq(batchStrategyType.application, APPLICATION),
      eq(batchStrategyType.strategyType, key),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_strategy_type',
      objectKey: key,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { description: existing.description, accessSequence: existing.accessSequence, version: existing.version },
      after: { description, accessSequence, version },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    return { strategyType: key, description, accessSequence, usage: USAGE, application: APPLICATION, version, changedBy: input.changedBy, changedAt: now };
  });
}

export async function deleteBatchStrategyType(input: {
  client: string;
  changedBy: string;
  capabilities: readonly string[];
  strategyType: string;
  expectedVersion: number;
  confirmed?: boolean;
  reason?: string;
  transportRequest?: string;
}): Promise<{ strategyType: string }> {
  assertAuthority(input.capabilities);
  if (input.transportRequest?.trim()) {
    throw new BatchStrategyTypeError(
      'A transport is refused. OMCW does not write a transport request.',
      'TRANSPORT_REFUSED',
      'Delete the strategy type in this client.',
    );
  }
  const key = keyOf(input.strategyType);
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`BATCH_STRATEGY_TYPE/${key}`}))`);
    const [existing] = await tx.select().from(batchStrategyType).where(and(
      eq(batchStrategyType.client, input.client),
      eq(batchStrategyType.usage, USAGE),
      eq(batchStrategyType.application, APPLICATION),
      eq(batchStrategyType.strategyType, key),
    )).for('update');
    if (!existing) {
      throw new BatchStrategyTypeError(
        `Strategy type ${key} does not stand. Nothing was deleted.`,
        'TYPE_UNKNOWN',
        'Choose a strategy type from the list.',
      );
    }
    if (existing.version !== input.expectedVersion) {
      throw new BatchStrategyTypeError(
        `Strategy type ${key} was opened at version ${input.expectedVersion}, and version ${existing.version} now stands. Nothing was deleted.`,
        'VERSION_STALE',
        'Open the strategy type again.',
      );
    }
    const [cited] = await tx.select({
      searchProcedure: batchSearchProcedureStep.searchProcedure,
      stepNumber: batchSearchProcedureStep.stepNumber,
    }).from(batchSearchProcedureStep).where(and(
      eq(batchSearchProcedureStep.client, input.client),
      eq(batchSearchProcedureStep.usage, USAGE),
      eq(batchSearchProcedureStep.application, APPLICATION),
      eq(batchSearchProcedureStep.strategyType, key),
    )).limit(1);
    if (cited) {
      throw new BatchStrategyTypeError(
        `Strategy type ${key} is named by step ${cited.stepNumber} of search procedure ${cited.searchProcedure}. Nothing was deleted.`,
        'CITED',
        'Remove the step on OMCY first. The search procedure is not changed here.',
      );
    }
    const [strategy] = await tx.select({
      recordNumber: batchSearchStrategy.recordNumber,
    }).from(batchSearchStrategy).where(and(
      eq(batchSearchStrategy.client, input.client),
      eq(batchSearchStrategy.usage, USAGE),
      eq(batchSearchStrategy.application, APPLICATION),
      eq(batchSearchStrategy.strategyType, key),
    )).limit(1);
    if (strategy) {
      throw new BatchStrategyTypeError(
        `Strategy type ${key} is named by search strategy ${strategy.recordNumber}. Nothing was deleted.`,
        'CITED',
        'Delete the search strategy on MBC1 first. The record is not changed here.',
      );
    }
    if (!input.confirmed) {
      throw new BatchStrategyTypeError(
        'The deletion was not confirmed. Nothing was deleted.',
        'CONFIRM_REQUIRED',
        'Confirm the deletion. No posted movement is rewritten.',
      );
    }
    const reason = reasonOf(input.reason);
    await tx.delete(batchStrategyType).where(and(
      eq(batchStrategyType.client, input.client),
      eq(batchStrategyType.usage, USAGE),
      eq(batchStrategyType.application, APPLICATION),
      eq(batchStrategyType.strategyType, key),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch_strategy_type',
      objectKey: key,
      changeType: 'DELETE',
      changedBy: input.changedBy,
      transactionCode: ACTIVITY,
      reason,
      before: { description: existing.description, version: existing.version },
    });
    return { strategyType: key };
  });
}

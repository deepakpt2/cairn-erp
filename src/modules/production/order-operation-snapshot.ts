/**
 * Operation snapshot for a production order.
 *
 * Called when a production version has already been selected. It copies the
 * routing operations in effect on the order finish date, and the standard
 * values that stand with them. It does not write the order. A missing,
 * deleted, wrong-plant, or dateless routing fails. An empty copy is not
 * returned: that would look like an order that never had a routing.
 *
 * The routing model stores sequence 000000 only. Execution order is copied
 * with the operation and is not the operation number. It has no predecessor,
 * successor, setup, machine, or labor columns. Those are not invented here.
 * Confirmation and external-processing flags are copied from the control key
 * as it stands now, so a later control-key edit does not change this order.
 * The application role may insert and select these rows. It may not update or delete them.
 * This copy does not re-rank an existing production-order snapshot. A backfill
 * of a row that had no execution order used operation-number display order.
 * That ranking is not read again, and it is not proof of an earlier routing order.
 */
import { and, asc, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import {
  productionOrderOperation,
  productionOrderOperationValue,
  routing,
  routingControlKey,
  routingOperation,
  routingOperationValue,
  routingStandardValueParameter,
  routingStatus,
} from './schema';

export class OrderOperationSnapshotError extends Error {
  readonly code: string;
  remedy?: string;
  constructor(code: string, message: string, remedy?: string) {
    super(message);
    this.name = 'OrderOperationSnapshotError';
    this.code = code;
    this.remedy = remedy;
  }
}

function fail(code: string, message: string, remedy?: string): never {
  throw new OrderOperationSnapshotError(code, message, remedy);
}

export interface OrderOperationValueSnapshot {
  parameter: string;
  description: string;
  quantity: string | null;
  unit: string;
  required: 'X' | ' ';
}

export interface OrderOperationSnapshot {
  operationNumber: string;
  sequence: string;
  executionOrder: number;
  taskListType: string;
  routingGroup: string;
  groupCounter: string;
  productionVersion: string;
  sourceOperationNumber: string;
  routingVersion: number;
  workCenter: string | null;
  workCenterPlant: string;
  controlKey: string | null;
  shortText: string | null;
  standardValueKey: string | null;
  operationQuantity: string | null;
  operationUnit: string | null;
  baseQuantity: string | null;
  baseUnit: string | null;
  validFrom: string;
  validTo: string;
  confirmation: 'X' | ' ';
  externalProcessing: 'X' | ' ';
  values: OrderOperationValueSnapshot[];
}

export async function resolveOrderOperationSnapshot(tx: Tx, input: {
  client: string;
  plant: string;
  finishDate: string;
  taskListType: string;
  routingGroup: string;
  groupCounter: string;
  productionVersion: string;
}): Promise<{ operations: OrderOperationSnapshot[]; warnings: string[] }> {
  const taskListType = input.taskListType.trim();
  const routingGroup = input.routingGroup.trim();
  const groupCounter = input.groupCounter.trim();
  const productionVersion = input.productionVersion.trim();
  const finish = input.finishDate.trim();
  const identity = `${taskListType} ${routingGroup} ${groupCounter}`;
  const [header] = await tx.select().from(routing).where(and(
    eq(routing.client, input.client),
    eq(routing.taskListType, taskListType),
    eq(routing.routingGroup, routingGroup),
    eq(routing.groupCounter, groupCounter),
  ));
  if (!header || header.deletionFlag === 'X' || header.plant !== input.plant) {
    fail(
      'ROUTING_MISSING',
      `Routing ${identity} does not stand in plant ${input.plant}. The production order was not created.`,
      'Correct the production version. A routing from another plant was not copied.',
    );
  }
  if (header.validFrom > finish || header.validTo < finish) {
    fail(
      'ROUTING_DATE',
      `Routing ${identity} is valid ${header.validFrom} to ${header.validTo}. It does not cover ${finish}. The production order was not created.`,
      'Choose a finish date inside the routing validity, or correct the routing. Nothing was saved.',
    );
  }
  const warnings = [
    `Routing ${identity} is named by production version ${productionVersion}. Operations in effect on ${finish} are copied onto the order. A later routing change does not rewrite them.`,
  ];
  if (header.status) {
    const [status] = await tx.select().from(routingStatus).where(and(
      eq(routingStatus.client, input.client),
      eq(routingStatus.status, header.status),
    ));
    if (status && status.releasedForOrders !== 'X') {
      warnings.push(`Routing status ${header.status} is not released for orders. The operations were still copied. The flag is not executed.`);
    }
  }
  const standing = await tx.select().from(routingOperation).where(and(
    eq(routingOperation.client, input.client),
    eq(routingOperation.taskListType, taskListType),
    eq(routingOperation.routingGroup, routingGroup),
    eq(routingOperation.groupCounter, groupCounter),
    eq(routingOperation.sequence, '000000'),
    eq(routingOperation.deletionFlag, ' '),
  )).orderBy(asc(routingOperation.executionOrder), asc(routingOperation.operationNumber));
  const inEffect = standing.filter((row) => row.validFrom <= finish && row.validTo >= finish);
  if (inEffect.length === 0) {
    fail(
      'NO_OPERATION',
      `Routing ${identity} has no operation in effect on ${finish}. The production order was not created.`,
      'Correct the operation validity, or choose another finish date. An empty operation list was not saved.',
    );
  }
  const controls = await tx.select().from(routingControlKey).where(eq(routingControlKey.client, input.client));
  const controlByKey = new Map(controls.map((row) => [row.controlKey, row]));
  const parameters = await tx.select().from(routingStandardValueParameter).where(
    eq(routingStandardValueParameter.client, input.client),
  );
  const values = await tx.select().from(routingOperationValue).where(and(
    eq(routingOperationValue.client, input.client),
    eq(routingOperationValue.taskListType, taskListType),
    eq(routingOperationValue.routingGroup, routingGroup),
    eq(routingOperationValue.groupCounter, groupCounter),
  ));
  const operations: OrderOperationSnapshot[] = [];
  for (const row of inEffect) {
    const control = row.controlKey ? controlByKey.get(row.controlKey) : undefined;
    if (row.controlKey && !control) {
      fail(
        'CONTROL_KEY',
        `Operation ${row.operationNumber} names control key ${row.controlKey}, which does not stand. The production order was not created.`,
        'Correct the control key. A confirmation flag was not invented.',
      );
    }
    const copiedValues: OrderOperationValueSnapshot[] = [];
    if (row.standardValueKey) {
      const definitions = parameters.filter((parameter) => parameter.standardValueKey === row.standardValueKey);
      for (const definition of definitions) {
        const value = values.find((item) => item.operationNumber === row.operationNumber && item.parameter === definition.parameter);
        const unit = value?.unit ?? definition.unit ?? '';
        if (!unit) {
          fail(
            'ACTIVITY_UNIT',
            `Standard value ${definition.parameter} on operation ${row.operationNumber} has no unit. The production order was not created.`,
            'Give the parameter a unit. A unit was not invented.',
          );
        }
        copiedValues.push({
          parameter: definition.parameter,
          description: definition.description,
          quantity: value?.quantity == null ? null : String(value.quantity),
          unit,
          required: definition.required === 'X' ? 'X' : ' ',
        });
      }
    }
    operations.push({
      operationNumber: row.operationNumber,
      sequence: row.sequence,
      executionOrder: row.executionOrder,
      taskListType,
      routingGroup,
      groupCounter,
      productionVersion,
      sourceOperationNumber: row.operationNumber,
      routingVersion: header.version,
      workCenter: row.workCenter,
      workCenterPlant: row.plant,
      controlKey: row.controlKey,
      shortText: row.shortText,
      standardValueKey: row.standardValueKey,
      operationQuantity: row.operationQuantity == null ? null : String(row.operationQuantity),
      operationUnit: row.operationUnit,
      baseQuantity: row.baseQuantity == null ? null : String(row.baseQuantity),
      baseUnit: row.baseUnit,
      validFrom: row.validFrom,
      validTo: row.validTo,
      confirmation: control?.confirmation === 'X' ? 'X' : ' ',
      externalProcessing: control?.externalProcessing === 'X' ? 'X' : ' ',
      values: copiedValues,
    });
  }
  warnings[0] = `Routing ${identity} is named by production version ${productionVersion}. ${operations.length} operation(s) in effect on ${finish} are copied onto the order in the stored execution order. Sequence 000000 is the only sequence. A later routing change does not rewrite them.`;
  return { operations, warnings };
}

export async function insertOrderOperationSnapshot(tx: Tx, input: {
  client: string;
  orderNumber: string;
  createdBy: string;
  operations: OrderOperationSnapshot[];
}): Promise<void> {
  if (input.operations.length === 0) {
    fail(
      'NO_OPERATION',
      'No operation was copied. An empty operation snapshot was not saved.',
      'The routing had no operation in effect. Nothing was saved.',
    );
  }
  await tx.insert(productionOrderOperation).values(input.operations.map((operation) => ({
    client: input.client,
    orderNumber: input.orderNumber,
    operationNumber: operation.operationNumber,
    sequence: operation.sequence,
    executionOrder: operation.executionOrder,
    taskListType: operation.taskListType,
    routingGroup: operation.routingGroup,
    groupCounter: operation.groupCounter,
    productionVersion: operation.productionVersion,
    sourceOperationNumber: operation.sourceOperationNumber,
    routingVersion: operation.routingVersion,
    workCenter: operation.workCenter,
    workCenterPlant: operation.workCenterPlant,
    controlKey: operation.controlKey,
    shortText: operation.shortText,
    standardValueKey: operation.standardValueKey,
    operationQuantity: operation.operationQuantity,
    operationUnit: operation.operationUnit,
    baseQuantity: operation.baseQuantity,
    baseUnit: operation.baseUnit,
    validFrom: operation.validFrom,
    validTo: operation.validTo,
    confirmation: operation.confirmation,
    externalProcessing: operation.externalProcessing,
    createdBy: input.createdBy,
  })));
  const values = input.operations.flatMap((operation) => operation.values.map((value) => ({
    client: input.client,
    orderNumber: input.orderNumber,
    operationNumber: operation.operationNumber,
    parameter: value.parameter,
    description: value.description,
    quantity: value.quantity,
    unit: value.unit,
    required: value.required,
    createdBy: input.createdBy,
  })));
  if (values.length > 0) await tx.insert(productionOrderOperationValue).values(values);
}

/**
 * Release acts — SCR-060 / R-108.
 *
 * Determination runs inside requisition and order creation and
 * change: the document offers its attributes to the SCR-059 judge and
 * the claiming strategy is stored in `document_release`. Release
 * advances one sequenced code at a time under the category's release
 * capability; cancel returns the document to step zero. A RELEASED
 * document refuses change until cancelled. A release code is an
 * authority, not a person — named-user assignment to codes is
 * deferred (R-108).
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { criterionMatches, type ReleaseAttributes } from '../foundation/release-strategy-definition';
import {
  characteristic, releaseGroup, releaseStrategy, releaseStrategyCriterion, releaseStrategyStep,
} from '../foundation/characteristic-schema';
import { plant } from '../foundation/schema';
import {
  documentRelease, purchaseOrder, purchaseOrderItem, purchaseRequisitionItem,
} from './schema';

export const RELEASE_CAPABILITIES: Record<string, string> = {
  PURCHASE_REQUISITION: 'PROC.PR.RELEASE',
  PURCHASE_ORDER: 'PROC.PO.RELEASE',
  PURCHASE_CONTRACT: 'PROC.CONTRACT.RELEASE',
  SCHED_AGREEMENT: 'PROC.SCHEDAGREE.RELEASE',
};

export class ReleaseError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ReleaseError';
    this.remedy = remedy;
  }
}

export interface DocumentReleaseState {
  status: 'NOT_REQUIRED' | 'PENDING' | 'RELEASED';
  groupCode: string | null;
  strategyCode: string | null;
  steps: string[];
  currentStep: number;
}

const NOT_REQUIRED: DocumentReleaseState = {
  status: 'NOT_REQUIRED', groupCode: null, strategyCode: null, steps: [], currentStep: 0,
};

async function strategySteps(tx: Tx, client: string, groupCode: string, strategyCode: string): Promise<string[]> {
  const rows = await tx.select().from(releaseStrategyStep).where(and(
    eq(releaseStrategyStep.client, client),
    eq(releaseStrategyStep.groupCode, groupCode),
    eq(releaseStrategyStep.strategyCode, strategyCode),
  )).orderBy(asc(releaseStrategyStep.step));
  return rows.map((r) => r.releaseCode);
}

async function loadState(tx: Tx, client: string, category: string, number: string): Promise<DocumentReleaseState> {
  const [row] = await tx.select().from(documentRelease).where(and(
    eq(documentRelease.client, client),
    eq(documentRelease.documentCategory, category),
    eq(documentRelease.documentNumber, number),
  ));
  if (!row) return NOT_REQUIRED;
  return {
    status: row.status as DocumentReleaseState['status'],
    groupCode: row.groupCode,
    strategyCode: row.strategyCode,
    steps: await strategySteps(tx, client, row.groupCode, row.strategyCode),
    currentStep: row.currentStep,
  };
}

export async function getDocumentRelease(
  client: string, category: string, number: string,
): Promise<DocumentReleaseState> {
  return withTenant(client, (tx) => loadState(tx, client, category, number));
}

export async function listDocumentReleases(
  client: string, category: string,
): Promise<Map<string, DocumentReleaseState>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(documentRelease).where(and(
      eq(documentRelease.client, client), eq(documentRelease.documentCategory, category),
    ));
    const map = new Map<string, DocumentReleaseState>();
    for (const row of rows) {
      map.set(row.documentNumber, {
        status: row.status as DocumentReleaseState['status'],
        groupCode: row.groupCode,
        strategyCode: row.strategyCode,
        steps: await strategySteps(tx, client, row.groupCode, row.strategyCode),
        currentStep: row.currentStep,
      });
    }
    return map;
  });
}

interface Determination {
  groupCode: string;
  strategyCode: string;
}

async function determineInTx(
  tx: Tx, client: string, category: string, attributes: ReleaseAttributes,
): Promise<Determination | null> {
  const groups = await tx.select().from(releaseGroup).where(and(
    eq(releaseGroup.client, client), eq(releaseGroup.documentCategory, category),
  ));
  if (groups.length === 0) return null;
  const strategies = await tx.select().from(releaseStrategy).where(and(
    eq(releaseStrategy.client, client), eq(releaseStrategy.lifecycleStatus, 'ACTIVE'),
  ));
  const candidates = strategies
    .filter((s) => groups.some((g) => g.groupCode === s.groupCode))
    .sort((a, b) => a.priority - b.priority || a.groupCode.localeCompare(b.groupCode) || a.strategyCode.localeCompare(b.strategyCode));
  for (const strategy of candidates) {
    const criteria = await tx.select().from(releaseStrategyCriterion).where(and(
      eq(releaseStrategyCriterion.client, client),
      eq(releaseStrategyCriterion.groupCode, strategy.groupCode),
      eq(releaseStrategyCriterion.strategyCode, strategy.strategyCode),
    ));
    let matches = true;
    for (const criterion of criteria) {
      const [char] = await tx.select().from(characteristic).where(and(
        eq(characteristic.client, client),
        eq(characteristic.characteristicName, criterion.characteristicName),
      ));
      if (!char || !criterionMatches(
        char.dataFormat, criterion.operator, criterion.valueFrom, criterion.valueTo,
        attributes[criterion.characteristicName],
      )) {
        matches = false;
        break;
      }
    }
    if (matches) return { groupCode: strategy.groupCode, strategyCode: strategy.strategyCode };
  }
  return null;
}

function agreed(values: Array<string | null | undefined>): string | undefined {
  const present = values.filter((v): v is string => Boolean(v));
  const set = new Set(present);
  return set.size === 1 ? [...set][0] : undefined;
}

export async function requisitionAttributes(tx: Tx, client: string, number: string): Promise<ReleaseAttributes> {
  const items = await tx.select().from(purchaseRequisitionItem).where(and(
    eq(purchaseRequisitionItem.client, client),
    eq(purchaseRequisitionItem.requisitionNumber, number),
  ));
  const standing = items.filter((i) => !i.markedForDeletion);
  const total = standing.reduce(
    (sum, i) => sum + (i.estimatedPrice ? (Number(i.quantity) * Number(i.estimatedPrice)) / Number(i.priceUnit) : 0),
    0,
  );
  const plantRows = await tx.select().from(plant).where(eq(plant.client, client));
  const attributes: ReleaseAttributes = { TOTAL_VALUE: Math.round(total * 100) / 100 };
  const plantValue = agreed(standing.map((i) => i.plant));
  if (plantValue) attributes.PLANT = plantValue;
  const group = agreed(standing.map((i) => i.purchasingGroup));
  if (group) attributes.PURCHASING_GROUP = group;
  const company = agreed(standing.map((i) => plantRows.find((p) => p.plant === i.plant)?.companyCode));
  if (company) attributes.COMPANY_CODE = company;
  return attributes;
}

export async function orderAttributes(tx: Tx, client: string, number: string): Promise<ReleaseAttributes> {
  const [header] = await tx.select().from(purchaseOrder).where(and(
    eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, number),
  ));
  if (!header) return {};
  const items = await tx.select().from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, number),
  ));
  const standing = items.filter((i) => !i.markedForDeletion);
  const attributes: ReleaseAttributes = {
    TOTAL_VALUE: Math.round(standing.reduce((sum, i) => sum + Number(i.netValue), 0) * 100) / 100,
    PURCHASING_GROUP: header.purchasingGroup,
    COMPANY_CODE: header.companyCode,
    SUPPLIER: header.supplierNumber,
    PURCHASING_ORG: header.purchasingOrg,
  };
  const plantValue = agreed(standing.map((i) => i.plant));
  if (plantValue) attributes.PLANT = plantValue;
  return attributes;
}

/**
 * Re-determines a document inside its own transaction. A document
 * whose claiming strategy changed restarts at step zero; RELEASED
 * documents never reach here — the change path refuses them first.
 */
export async function syncDocumentRelease(
  tx: Tx,
  client: string,
  category: string,
  number: string,
  attributes: ReleaseAttributes,
  changedBy: string,
): Promise<void> {
  const determination = await determineInTx(tx, client, category, attributes);
  const [existing] = await tx.select().from(documentRelease).where(and(
    eq(documentRelease.client, client),
    eq(documentRelease.documentCategory, category),
    eq(documentRelease.documentNumber, number),
  ));
  if (!determination) {
    if (existing) {
      await tx.delete(documentRelease).where(and(
        eq(documentRelease.client, client),
        eq(documentRelease.documentCategory, category),
        eq(documentRelease.documentNumber, number),
      ));
    }
    return;
  }
  if (!existing) {
    await tx.insert(documentRelease).values({
      client, documentCategory: category, documentNumber: number,
      groupCode: determination.groupCode, strategyCode: determination.strategyCode,
      currentStep: 0, status: 'PENDING', createdBy: changedBy,
    });
    return;
  }
  if (existing.groupCode !== determination.groupCode || existing.strategyCode !== determination.strategyCode) {
    await tx.update(documentRelease).set({
      groupCode: determination.groupCode, strategyCode: determination.strategyCode,
      currentStep: 0, status: 'PENDING', changedBy, changedAt: new Date(),
    }).where(and(
      eq(documentRelease.client, client),
      eq(documentRelease.documentCategory, category),
      eq(documentRelease.documentNumber, number),
    ));
  }
}

/** The change-path guard: a RELEASED document refuses change. */
export async function assertDocumentNotReleased(
  tx: Tx, client: string, category: string, number: string, label: string,
): Promise<void> {
  const state = await loadState(tx, client, category, number);
  if (state.status === 'RELEASED') {
    throw new ReleaseError(
      `${label} ${number} is released and cannot be changed.`,
      'Cancel its release first, then change it.',
    );
  }
}

export interface ReleaseActInput {
  client: string;
  changedBy: string;
  documentCategory: string;
  documentNumber: string;
  releaseCode: string;
}

const OBJECT_CLASS_BY_CATEGORY: Record<string, string> = {
  PURCHASE_REQUISITION: 'purchase_requisition',
  PURCHASE_ORDER: 'purchase_order',
  PURCHASE_CONTRACT: 'purchase_contract',
  SCHED_AGREEMENT: 'scheduling_agreement',
};

async function syncOrderHeader(tx: Tx, client: string, number: string, released: boolean, changedBy: string) {
  await tx.update(purchaseOrder).set({
    releaseStatus: released ? 'RELEASED' : 'UNRELEASED',
    changedBy, changedAt: new Date(),
  }).where(and(eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, number)));
}

export async function releaseDocument(input: ReleaseActInput): Promise<DocumentReleaseState> {
  return withTenant(input.client, async (tx) => {
    // Serialize release acts on this document.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/release/${input.documentNumber}`}, 0))`);
    const state = await loadState(tx, input.client, input.documentCategory, input.documentNumber);
    if (state.status === 'NOT_REQUIRED') {
      throw new ReleaseError(`Document ${input.documentNumber} needs no release — no strategy claims it.`);
    }
    if (state.status === 'RELEASED') {
      throw new ReleaseError(`Document ${input.documentNumber} is already released.`);
    }
    const expected = state.steps[state.currentStep];
    if (!expected) throw new ReleaseError(`Document ${input.documentNumber} has no further release step.`);
    if (input.releaseCode !== expected) {
      throw new ReleaseError(
        `Step ${state.currentStep + 1} of ${state.steps.length} acts under release code ${expected}, not ${input.releaseCode}.`,
        'Act under the code the standing step names.',
      );
    }
    const nextStep = state.currentStep + 1;
    const released = nextStep >= state.steps.length;
    await tx.update(documentRelease).set({
      currentStep: nextStep,
      status: released ? 'RELEASED' : 'PENDING',
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(documentRelease.client, input.client),
      eq(documentRelease.documentCategory, input.documentCategory),
      eq(documentRelease.documentNumber, input.documentNumber),
    ));
    if (input.documentCategory === 'PURCHASE_ORDER') {
      await syncOrderHeader(tx, input.client, input.documentNumber, released, input.changedBy);
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: OBJECT_CLASS_BY_CATEGORY[input.documentCategory],
      objectKey: input.documentNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      after: {
        release: released ? 'RELEASED' : 'PENDING',
        step: nextStep,
        ofSteps: state.steps.length,
        code: input.releaseCode,
        strategy: state.strategyCode,
      },
    });
    return { ...state, currentStep: nextStep, status: released ? 'RELEASED' : 'PENDING' };
  });
}

export async function cancelDocumentRelease(input: Omit<ReleaseActInput, 'releaseCode'>): Promise<DocumentReleaseState> {
  return withTenant(input.client, async (tx) => {
    const state = await loadState(tx, input.client, input.documentCategory, input.documentNumber);
    if (state.status === 'NOT_REQUIRED') {
      throw new ReleaseError(`Document ${input.documentNumber} needs no release — nothing to cancel.`);
    }
    if (state.status === 'PENDING' && state.currentStep === 0) {
      throw new ReleaseError(`Document ${input.documentNumber} stands at the first step; no release has been given to cancel.`);
    }
    await tx.update(documentRelease).set({
      currentStep: 0, status: 'PENDING', changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(documentRelease.client, input.client),
      eq(documentRelease.documentCategory, input.documentCategory),
      eq(documentRelease.documentNumber, input.documentNumber),
    ));
    if (input.documentCategory === 'PURCHASE_ORDER') {
      await syncOrderHeader(tx, input.client, input.documentNumber, false, input.changedBy);
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: OBJECT_CLASS_BY_CATEGORY[input.documentCategory],
      objectKey: input.documentNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      after: { release: 'PENDING', step: 0, cancelled: true, strategy: state.strategyCode },
    });
    return { ...state, currentStep: 0, status: 'PENDING' };
  });
}

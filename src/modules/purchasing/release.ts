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
 *
 * The same engine judges contracts, scheduling agreements, parked
 * journal entries (JOURNAL_ENTRY) and payment runs (PAYMENT_RUN). The
 * finance categories pass `preparedBy` so that the person who prepared
 * a document cannot release it.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { KEY_OF_LEVEL, type OrgLevel, type OrgScope } from '../../platform/auth/authority';
import { type Tx, withTenant } from '../../platform/db/client';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { enqueue } from '../../platform/job/queue';
import { creatorOf } from '../../platform/notification/creator';
import { notifyOn } from '../../platform/notification/notify';
import { FANOUT_JOB } from '../../platform/notification/jobs/fanout';
import { criterionMatches, type ReleaseAttributes } from '../foundation/release-strategy-definition';
import {
  characteristic, releaseGroup, releaseStrategy, releaseStrategyCriterion, releaseStrategyStep,
} from '../foundation/characteristic-schema';
import { plant } from '../foundation/schema';
import { purchasingActor, purchasingLevelsAllow, requireCompanyInScope } from './scope';
import {
  documentRelease, purchaseOrder, purchaseOrderItem, purchaseRequisitionItem,
} from './schema';

export const RELEASE_CAPABILITIES: Record<string, string> = {
  PURCHASE_REQUISITION: 'PROC.PR.RELEASE',
  PURCHASE_ORDER: 'PROC.PO.RELEASE',
  PURCHASE_CONTRACT: 'PROC.CONTRACT.RELEASE',
  SCHED_AGREEMENT: 'PROC.SCHEDAGREE.RELEASE',
  JOURNAL_ENTRY: 'FIN.JOURNAL.RELEASE',
  PAYMENT_RUN: 'FIN.AP.PAYMENTRUN.RELEASE',
};

/**
 * A purchase order's release flag as readers see it. The `release_status`
 * column defaults to UNRELEASED and only a release act moves it, so a PO that
 * no strategy claims would read as unreleased forever. It has no
 * `document_release` row, so it reads NOT_REQUIRED, as contracts and
 * scheduling agreements do. Expects the order table aliased `po`.
 */
export const PO_RELEASE_STATUS_SQL = sql.raw(
  `case when exists (select 1 from document_release dr where dr.client = po.client`
  + ` and dr.document_category = 'PURCHASE_ORDER' and dr.document_number = po.order_number)`
  + ` then po.release_status else 'NOT_REQUIRED' end`,
);

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
  /** Last release-state change, so a re-release is distinguishable from the prior acts. */
  changedAt?: string | null;
}

const NOT_REQUIRED: DocumentReleaseState = {
  status: 'NOT_REQUIRED', groupCode: null, strategyCode: null, steps: [], currentStep: 0, changedAt: null,
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
    changedAt: row.changedAt ? row.changedAt.toISOString() : null,
  };
}

export async function getDocumentRelease(
  client: string, category: string, number: string,
): Promise<DocumentReleaseState> {
  return withTenant(client, (tx) => loadState(tx, client, category, number));
}

/** The release state inside a caller-owned transaction, for durable instruction binding. */
export async function getDocumentReleaseInTx(
  tx: Tx, client: string, category: string, number: string,
): Promise<DocumentReleaseState> {
  return loadState(tx, client, category, number);
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
        changedAt: row.changedAt ? row.changedAt.toISOString() : null,
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
    PURCHASING_GROUP: header.purchasingGroup,
    COMPANY_CODE: header.companyCode,
    PURCHASING_ORG: header.purchasingOrg,
  };
  // A stock transport order has no supplier and no net value. Neither is invented for it (a zero would walk it
  // past every value strategy): the attributes are left out and `assertStoReleaseEvaluable` refuses the order
  // while a strategy still judges on them.
  if (header.documentType !== 'STOCK_TRANSPORT') {
    attributes.TOTAL_VALUE = Math.round(standing.reduce((sum, i) => sum + Number(i.netValue), 0) * 100) / 100;
  }
  if (header.supplierNumber) attributes.SUPPLIER = header.supplierNumber;
  const plantValue = agreed(standing.map((i) => i.plant));
  if (plantValue) attributes.PLANT = plantValue;
  return attributes;
}

/**
 * Who raised the fan-out run, in job_run.triggered_by.
 *
 * Deliberately not a person. The job runtime reports a run's outcome back to
 * whoever triggered it, and the outcome of a fan-out is not news to anybody:
 * on success the recipients already hold the notification it just wrote, and
 * "the fan-out finished" would be noise on top of it. Left unnameable, a
 * successful fan-out says nothing at all and a failed one goes to whoever
 * watches the queue — which is the split we want, and the same reason the
 * scheduler writes SCHEDULER rather than a person's name.
 */
const RELEASE_ACTOR = 'RELEASE';

/**
 * The place a release question is asked about.
 *
 * Release criteria are named in the SCR-059 vocabulary — PLANT, COMPANY_CODE,
 * PURCHASING_ORG — and authority is scoped in OrgScope keys — plant,
 * companyCode, purchasingOrg. KEY_OF_LEVEL is the one translation between the
 * two. Anything else the document carries (SUPPLIER, say) is a criterion and
 * not a scope, so it is dropped here rather than silently narrowing the
 * question to nobody.
 */
function orgScopeOf(attributes: ReleaseAttributes): OrgScope {
  const org: OrgScope = {};
  for (const [level, value] of Object.entries(attributes)) {
    const key = KEY_OF_LEVEL[level as OrgLevel];
    if (!key || value === undefined || value === null || value === '') continue;
    org[key] = String(value);
  }
  return org;
}

/**
 * Hand the question "who may release this" to the worker.
 *
 * A release code is an authority, not a person (R-108), so there is nobody to
 * name: the recipients are whoever holds the category's release capability
 * within this document's place, and answering that means loading every
 * candidate's authority. That is real work and it does not belong on the
 * request path, so the transaction only records what it already knows — the
 * capability, the document, the place — and the fan-out job resolves the rest
 * once the document is safely committed.
 *
 * The idempotency key is what keeps this from becoming a letterbox: a document
 * is re-synced on every change, and only a *new* pending episode — a different
 * group, or a different strategy — is worth telling people about again.
 */
async function enqueueReleaseWaiting(
  tx: Tx,
  input: {
    client: string;
    category: string;
    number: string;
    attributes: ReleaseAttributes;
    groupCode: string;
    strategyCode: string;
  },
): Promise<void> {
  const capability = RELEASE_CAPABILITIES[input.category];
  const objectClass = OBJECT_CLASS_BY_CATEGORY[input.category];
  if (!capability || !objectClass) return;

  await enqueue(tx, {
    client: input.client,
    jobCode: FANOUT_JOB,
    triggeredBy: RELEASE_ACTOR,
    idempotencyKey: [
      'release-waiting', input.category, input.number,
      input.groupCode, input.strategyCode, 0,
    ].join('/').slice(0, 120),
    parameters: {
      capability,
      org: orgScopeOf(input.attributes),
      kind: 'DOC.RELEASE.WAITING',
      objectClass,
      objectKey: input.number,
      messageKey: 'notification.kind.DOC.RELEASE.WAITING',
      messageParams: { document: input.number },
    },
  });
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
  options: { restart?: boolean } = {},
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
    await enqueueReleaseWaiting(tx, {
      client, category, number, attributes,
      groupCode: determination.groupCode, strategyCode: determination.strategyCode,
    });
    return;
  }
  // `restart`: the document changed after release acts were given, so those acts judged
  // something else. A document that changes under a standing release starts again.
  const changedUnderRelease = options.restart === true && (existing.currentStep > 0 || existing.status === 'RELEASED');
  if (changedUnderRelease || existing.groupCode !== determination.groupCode || existing.strategyCode !== determination.strategyCode) {
    await tx.update(documentRelease).set({
      groupCode: determination.groupCode, strategyCode: determination.strategyCode,
      currentStep: 0, status: 'PENDING', changedBy, changedAt: new Date(),
    }).where(and(
      eq(documentRelease.client, client),
      eq(documentRelease.documentCategory, category),
      eq(documentRelease.documentNumber, number),
    ));
    // Restarting at step zero is a new episode: the people who could release
    // the old strategy are not necessarily the people who can release this
    // one, so they have to be resolved again.
    await enqueueReleaseWaiting(tx, {
      client, category, number, attributes,
      groupCode: determination.groupCode, strategyCode: determination.strategyCode,
    });
  }
}

/**
 * A stock transport order has no net value and no supplier, so a release strategy that judges on either
 * cannot be evaluated for it honestly. It is refused, never treated as approved and never given a zero.
 */
export async function assertStoReleaseEvaluable(tx: Tx, client: string): Promise<void> {
  const rows = await tx.execute(sql`
    select distinct c.group_code, c.strategy_code, c.characteristic_name
      from release_strategy_criterion c
      join release_strategy s on s.client = c.client and s.group_code = c.group_code and s.strategy_code = c.strategy_code
      join release_group g on g.client = s.client and g.group_code = s.group_code
     where c.client = ${client} and g.document_category = 'PURCHASE_ORDER' and s.lifecycle_status = 'ACTIVE'
       and c.characteristic_name in ('TOTAL_VALUE', 'SUPPLIER')
  `) as unknown as Array<{ group_code: string; strategy_code: string; characteristic_name: string }>;
  if (rows.length > 0) {
    const named = rows.map((r) => `${r.group_code}/${r.strategy_code} (${r.characteristic_name})`).join(', ');
    throw new ReleaseError(
      `A stock transport order has no net value and no supplier, so the purchase order release strategy ${named} cannot be evaluated for it.`,
      'Remove the total value and supplier criteria from the purchase order strategies that should also govern stock transport orders, or deactivate the strategy; the order is not treated as approved.',
    );
  }
}

/** The document is gone for release purposes (deleted, cancelled): it must not stay in a queue. */
export async function dropDocumentRelease(tx: Tx, client: string, category: string, number: string): Promise<void> {
  await tx.delete(documentRelease).where(and(
    eq(documentRelease.client, client),
    eq(documentRelease.documentCategory, category),
    eq(documentRelease.documentNumber, number),
  ));
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

/**
 * The gate in front of an act that needs the document released: a document some
 * strategy claims must stand RELEASED first. A document no strategy claims passes.
 */
export async function assertDocumentReleased(
  tx: Tx, client: string, category: string, number: string, label: string,
): Promise<void> {
  const state = await loadState(tx, client, category, number);
  if (state.status === 'PENDING') {
    throw new ReleaseError(
      `${label} ${number} is waiting for release (step ${state.currentStep + 1} of ${state.steps.length}, release code ${state.steps[state.currentStep] ?? 'unknown'}).`,
      'Have it released by someone who holds the release authority, then try again.',
    );
  }
}

export interface ReleaseActInput {
  client: string;
  /** The verified session. The releasing user is this session's user; `changedBy` is not trusted. */
  authorization: ServiceAuthorityContext | undefined;
  changedBy: string;
  documentCategory: string;
  documentNumber: string;
  releaseCode: string;
  /** The person who prepared the document. When named, that person cannot release it. */
  preparedBy?: string | null;
  /** The key the document's own change trail uses, when it is not the document number. */
  objectKey?: string;
}

const OBJECT_CLASS_BY_CATEGORY: Record<string, string> = {
  PURCHASE_REQUISITION: 'purchase_requisition',
  PURCHASE_ORDER: 'purchase_order',
  PURCHASE_CONTRACT: 'purchase_contract',
  SCHED_AGREEMENT: 'scheduling_agreement',
  JOURNAL_ENTRY: 'parked_journal',
  PAYMENT_RUN: 'payment_run',
};

async function syncOrderHeader(tx: Tx, client: string, number: string, released: boolean, changedBy: string) {
  await tx.update(purchaseOrder).set({
    releaseStatus: released ? 'RELEASED' : 'UNRELEASED',
    changedBy, changedAt: new Date(),
  }).where(and(eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, number)));
}

const releaseRefusal = (message: string, remedy?: string) => new ReleaseError(message, remedy);

/**
 * The company codes a document of this category belongs to, or null when no such document stands. A requisition,
 * a payment run and a journal may span more than one: every one must be in the actor's scope.
 */
async function releaseCompaniesInTx(tx: Tx, client: string, category: string, number: string): Promise<string[] | null> {
  const column = async (query: ReturnType<typeof sql>) =>
    (await tx.execute(query) as unknown as Array<{ company_code: string | null }>).map((r) => r.company_code).filter((c): c is string => Boolean(c));
  let companies: string[];
  switch (category) {
    case 'PURCHASE_ORDER':
      companies = await column(sql`select company_code from purchase_order where client = ${client} and order_number = ${number}`);
      break;
    case 'PURCHASE_CONTRACT':
      companies = await column(sql`select company_code from purchase_contract where client = ${client} and contract_number = ${number}`);
      break;
    case 'SCHED_AGREEMENT':
      companies = await column(sql`select company_code from scheduling_agreement where client = ${client} and agreement_number = ${number}`);
      break;
    case 'PURCHASE_REQUISITION':
      companies = await column(sql`
        select distinct p.company_code from purchase_requisition_item i
          join plant p on p.client = i.client and p.plant = i.plant
         where i.client = ${client} and i.requisition_number = ${number}`);
      break;
    case 'JOURNAL_ENTRY':
      companies = await column(sql`select company_code from parked_journal_header where client = ${client} and parked_number = ${number}`);
      break;
    case 'PAYMENT_RUN': {
      const [runDate, runId] = number.split('/');
      companies = (await tx.execute(sql`
        select company_code, paying_company_code from payment_run_company
         where client = ${client} and run_date = ${runDate ?? ''} and run_id = ${runId ?? ''}`) as unknown as Array<{ company_code: string; paying_company_code: string | null }>)
        .flatMap((r) => [r.company_code, r.paying_company_code]).filter((c): c is string => Boolean(c));
      break;
    }
    default:
      return null;
  }
  return companies.length > 0 ? [...new Set(companies)] : null;
}

/**
 * Judge a release act inside its own transaction before anything of the document is read: the live session, the
 * category's release capability, and an explicit Company Code scope over every company the document belongs to.
 * A document outside the scope answers exactly as one that needs no release. Returns the verified releasing user.
 */
async function authorizeReleaseInTx(
  tx: Tx, input: { client: string; authorization: ServiceAuthorityContext | undefined; documentCategory: string; documentNumber: string },
): Promise<string> {
  const capability = RELEASE_CAPABILITIES[input.documentCategory];
  if (!capability) throw releaseRefusal(`Document category ${input.documentCategory} is not released here.`);
  const actor = await purchasingActor(tx, input.client, input.authorization, [capability], releaseRefusal);
  const companies = await releaseCompaniesInTx(tx, input.client, input.documentCategory, input.documentNumber);
  for (const company of companies ?? []) {
    await requireCompanyInScope(tx, input.client, actor, company, releaseRefusal, {
      hidden: `Document ${input.documentNumber} needs no release — no strategy claims it.`,
    });
  }
  const levels = await releaseLevelsInTx(tx, input.client, input.documentCategory, input.documentNumber);
  if (levels.some((l) => !purchasingLevelsAllow(actor, l))) {
    throw releaseRefusal(`Document ${input.documentNumber} needs no release — no strategy claims it.`);
  }
  return actor.username;
}

/** The purchasing org and group a document of this category carries; a category with neither returns none. */
async function releaseLevelsInTx(
  tx: Tx, client: string, category: string, number: string,
): Promise<Array<{ purchasingOrg?: string; purchasingGroup?: string }>> {
  const rows = async (query: ReturnType<typeof sql>) =>
    (await tx.execute(query)) as unknown as Array<{ purchasing_org?: string; purchasing_group?: string }>;
  let found: Array<{ purchasing_org?: string; purchasing_group?: string }> = [];
  switch (category) {
    case 'PURCHASE_ORDER':
      found = await rows(sql`select purchasing_org, purchasing_group from purchase_order where client = ${client} and order_number = ${number}`);
      break;
    case 'PURCHASE_CONTRACT':
      found = await rows(sql`select purchasing_org, purchasing_group from purchase_contract where client = ${client} and contract_number = ${number}`);
      break;
    case 'SCHED_AGREEMENT':
      found = await rows(sql`select purchasing_org, purchasing_group from scheduling_agreement where client = ${client} and agreement_number = ${number}`);
      break;
    case 'PURCHASE_REQUISITION':
      found = await rows(sql`select distinct purchasing_group from purchase_requisition_item where client = ${client} and requisition_number = ${number}`);
      break;
    default:
      return [];
  }
  return found.map((r) => ({ purchasingOrg: r.purchasing_org, purchasingGroup: r.purchasing_group }));
}

/**
 * A caller that must read the document before it acts (to name a refusal kindly) judges first, so those reads
 * never disclose a document outside the scope. The act itself judges again in its own transaction.
 */
export async function assertReleaseAuthority(
  input: { client: string; authorization: ServiceAuthorityContext | undefined; documentCategory: string; documentNumber: string },
): Promise<string> {
  return withTenant(input.client, (tx) => authorizeReleaseInTx(tx, input));
}

export async function releaseDocument(raw: ReleaseActInput): Promise<DocumentReleaseState> {
  return releaseDocumentImpl(raw, false);
}

/** Seeding and fixtures only: no session exists there, so nothing is judged. Never import this from `src/app`. */
export async function releaseDocumentForProvisioning(raw: Omit<ReleaseActInput, 'authorization'>): Promise<DocumentReleaseState> {
  return releaseDocumentImpl({ ...raw, authorization: undefined }, true);
}

async function releaseDocumentImpl(raw: ReleaseActInput, provisioning: boolean): Promise<DocumentReleaseState> {
  return withTenant(raw.client, async (tx) => {
    const input = provisioning ? raw : { ...raw, changedBy: await authorizeReleaseInTx(tx, raw) };
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
    if (input.preparedBy && input.preparedBy.toUpperCase() === input.changedBy.toUpperCase()) {
      throw new ReleaseError(
        `Document ${input.documentNumber} was prepared by you; you cannot release it.`,
        'Another person who holds the release authority must release it.',
      );
    }
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
    const objectClass = OBJECT_CLASS_BY_CATEGORY[input.documentCategory];
    await recordChange(tx, {
      client: input.client,
      objectClass,
      objectKey: input.objectKey ?? input.documentNumber,
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
    // Tell whoever raised the document. Guessing a recipient is worse than
    // telling nobody, so with no change-document trail nothing is sent.
    const author = await creatorOf(tx, input.client, objectClass, input.objectKey ?? input.documentNumber);
    if (author) {
      await notifyOn(tx, {
        client: input.client,
        recipient: author,
        kind: 'DOC.RELEASED',
        objectClass,
        objectKey: input.documentNumber,
        messageKey: 'notification.kind.DOC.RELEASED',
        messageParams: { document: input.documentNumber },
      });
    }

    return { ...state, currentStep: nextStep, status: released ? 'RELEASED' : 'PENDING' };
  });
}

export async function cancelDocumentRelease(raw: Omit<ReleaseActInput, 'releaseCode' | 'preparedBy'>): Promise<DocumentReleaseState> {
  return cancelDocumentReleaseImpl(raw, false);
}

/** Seeding and fixtures only, as `releaseDocumentForProvisioning`. */
export async function cancelDocumentReleaseForProvisioning(
  raw: Omit<ReleaseActInput, 'releaseCode' | 'preparedBy' | 'authorization'>,
): Promise<DocumentReleaseState> {
  return cancelDocumentReleaseImpl({ ...raw, authorization: undefined }, true);
}

async function cancelDocumentReleaseImpl(
  raw: Omit<ReleaseActInput, 'releaseCode' | 'preparedBy'>, provisioning: boolean,
): Promise<DocumentReleaseState> {
  return withTenant(raw.client, async (tx) => {
    const input = provisioning ? raw : { ...raw, changedBy: await authorizeReleaseInTx(tx, raw) };
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
      objectKey: input.objectKey ?? input.documentNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      after: { release: 'PENDING', step: 0, cancelled: true, strategy: state.strategyCode },
    });
    const cancelledClass = OBJECT_CLASS_BY_CATEGORY[input.documentCategory];
    const author = await creatorOf(tx, input.client, cancelledClass, input.objectKey ?? input.documentNumber);
    if (author) {
      await notifyOn(tx, {
        client: input.client,
        recipient: author,
        kind: 'DOC.REFUSED',
        objectClass: cancelledClass,
        objectKey: input.documentNumber,
        messageKey: 'notification.kind.DOC.REFUSED',
        messageParams: { document: input.documentNumber },
      });
    }

    return { ...state, currentStep: 0, status: 'PENDING' };
  });
}

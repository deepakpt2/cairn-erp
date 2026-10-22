import { and, count, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { changeDocument } from '../../platform/tables/audit-trail';
import { markActivityComplete } from '../../platform/tenancy';
import { purchasingOrgMayBuyForPlant } from '../foundation/purchasing-org-plant';
import { plant, purchasingOrg, purchasingOrgPlant } from '../foundation/schema';
import {
  purchaseOrder,
  purchaseOrderItem,
  purchasingInfoRecordOrg,
  purchasingQuotaArrangement,
  purchasingQuotaArrangementItem,
  purchasingRfqEvent,
  purchasingRfqEventItem,
  purchasingSourceListEntry,
} from './schema';

/**
 * Assign a purchasing organisation to a plant (OX17 as a search alias only).
 *
 * The pair already stands on `purchasing_org_plant`. Procurement that reads
 * the pair — the request for quotation, the source list, the quota, and
 * supplier purchasing — reads this row. This service maintains it. It does
 * not post stock or a journal, and a closed posting period is not read.
 * A second assignment table, a status, and a configuration version are
 * refused by name: none of them is what those readers read.
 *
 * A pair a procurement document already cites is not deleted. The document
 * keeps the organisation and plant it was saved with.
 */

export { assertPurchasingOrgForPlant, PURCH_ORG_PLANT_NOT_AUTHORIZED } from '../foundation/purchasing-org-plant';
export const ACTIVITY = 'CFG.PROC.PURORG.ASSIGN_PLANT';
export const ROUTE = '/config/purchasing-orgs/assign-plant';

export class PurchasingOrgPlantAssignmentError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'PurchasingOrgPlantAssignmentError';
  }
}

const OBJECT_CLASS = 'purchasing_org_plant';
const PRODUCTION = process.env.NODE_ENV === 'production';

export interface PurchasingOrgPlantInput {
  client: string;
  changedBy: string;
  purchasingOrg: string;
  plant: string;
  reason: string;
  requestKey?: string;
  companyCode?: string;
  status?: string;
  version?: string;
  postingPeriod?: string;
  transportRequest?: string;
  approval?: string;
}

export interface PurchasingOrgPlantCitations {
  purchaseOrders: number;
  requestsForQuotation: number;
  sourceList: number;
  infoRecords: number;
  quotas: number;
}

export interface PurchasingOrgPlantRow {
  purchasingOrg: string;
  purchasingOrgName: string;
  purchasingOrgCompanyCode: string | null;
  plant: string;
  plantName: string;
  plantCompanyCode: string | null;
  changedBy: string | null;
  changedAt: string | null;
  citations: PurchasingOrgPlantCitations;
}

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new PurchasingOrgPlantAssignmentError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new PurchasingOrgPlantAssignmentError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new PurchasingOrgPlantAssignmentError(
      'A reason is required for every purchasing-organisation plant assignment.',
      'State why this assignment is being made.',
    );
  }
  return value;
}

function requireOrg(value: string): string {
  const key = (value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(key)) {
    throw new PurchasingOrgPlantAssignmentError(
      'The purchasing organisation must be 2 to 10 uppercase letters or digits.',
      'Choose a purchasing organisation the master already carries.',
    );
  }
  return key;
}

function requirePlant(value: string): string {
  const key = (value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(key)) {
    throw new PurchasingOrgPlantAssignmentError(
      'The plant must be 1 to 10 uppercase letters or digits.',
      'Choose a plant the master already carries.',
    );
  }
  return key;
}

function requestKeyOf(value: string | undefined): string | null {
  const key = (value ?? '').trim();
  if (!key) return null;
  if (key.length > 64) {
    throw new PurchasingOrgPlantAssignmentError('The request key is longer than 64 characters.', 'Use a shorter key.');
  }
  return key;
}

function objectKey(org: string, plantCode: string): string {
  return `${org}/${plantCode}`;
}

function refuseAbsent(input: PurchasingOrgPlantInput): void {
  const named: Array<[string | undefined, string, string]> = [
    [input.companyCode, 'A company code', 'The company code is read from the plant and, where the organisation has one, from the organisation. It is not stored on the assignment.'],
    [input.status, 'An assignment status', 'The pair stands when the row stands. Procurement readers do not read a status.'],
    [input.version, 'A configuration version', 'The change document is the history. A version is not stored on the assignment.'],
    [input.postingPeriod, 'A posting period', 'This assignment is not a posting. A closed period does not block it.'],
    [input.transportRequest, 'A transport', 'The assignment is recorded as a change document. It is not transported.'],
    [input.approval, 'An approval', 'The assignment is not an approval workflow.'],
  ];
  for (const [value, label, remedy] of named) {
    if (value?.trim()) throw new PurchasingOrgPlantAssignmentError(`${label} is not stored on this assignment.`, remedy);
  }
}

async function priorRequest(tx: Tx, client: string, requestKey: string | null) {
  if (!requestKey) return null;
  const [prior] = await tx
    .select()
    .from(changeDocument)
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, OBJECT_CLASS),
      eq(changeDocument.correlationId, requestKey),
    ))
    .limit(1);
  return prior ?? null;
}

function citationTotal(citations: PurchasingOrgPlantCitations): number {
  return citations.purchaseOrders + citations.requestsForQuotation + citations.sourceList + citations.infoRecords + citations.quotas;
}

function citationText(citations: PurchasingOrgPlantCitations): string {
  return [
    `${citations.purchaseOrders} purchase-order line(s)`,
    `${citations.requestsForQuotation} request-for-quotation line(s)`,
    `${citations.sourceList} source-list line(s)`,
    `${citations.infoRecords} info-record line(s)`,
    `${citations.quotas} quota line(s)`,
  ].join(', ');
}

async function documentCitations(tx: Tx, client: string, org: string, plantCode: string): Promise<PurchasingOrgPlantCitations> {
  const [orders] = await tx
    .select({ n: count() })
    .from(purchaseOrderItem)
    .innerJoin(purchaseOrder, and(
      eq(purchaseOrder.client, purchaseOrderItem.client),
      eq(purchaseOrder.orderNumber, purchaseOrderItem.orderNumber),
    ))
    .where(and(
      eq(purchaseOrderItem.client, client),
      eq(purchaseOrderItem.plant, plantCode),
      eq(purchaseOrder.purchasingOrg, org),
    ));
  const [events] = await tx
    .select({ n: count() })
    .from(purchasingRfqEventItem)
    .innerJoin(purchasingRfqEvent, and(
      eq(purchasingRfqEvent.client, purchasingRfqEventItem.client),
      eq(purchasingRfqEvent.eventNumber, purchasingRfqEventItem.eventNumber),
    ))
    .where(and(
      eq(purchasingRfqEventItem.client, client),
      eq(purchasingRfqEventItem.plant, plantCode),
      eq(purchasingRfqEvent.purchasingOrg, org),
    ));
  const [sources] = await tx
    .select({ n: count() })
    .from(purchasingSourceListEntry)
    .where(and(
      eq(purchasingSourceListEntry.client, client),
      eq(purchasingSourceListEntry.plant, plantCode),
      eq(purchasingSourceListEntry.purchasingOrg, org),
    ));
  const [info] = await tx
    .select({ n: count() })
    .from(purchasingInfoRecordOrg)
    .where(and(
      eq(purchasingInfoRecordOrg.client, client),
      eq(purchasingInfoRecordOrg.plant, plantCode),
      eq(purchasingInfoRecordOrg.purchasingOrg, org),
    ));
  const [quotas] = await tx
    .select({ n: count() })
    .from(purchasingQuotaArrangementItem)
    .innerJoin(purchasingQuotaArrangement, and(
      eq(purchasingQuotaArrangement.client, purchasingQuotaArrangementItem.client),
      eq(purchasingQuotaArrangement.quotaNumber, purchasingQuotaArrangementItem.quotaNumber),
    ))
    .where(and(
      eq(purchasingQuotaArrangementItem.client, client),
      eq(purchasingQuotaArrangementItem.purchasingOrg, org),
      eq(purchasingQuotaArrangement.plant, plantCode),
    ));
  return {
    purchaseOrders: Number(orders?.n ?? 0),
    requestsForQuotation: Number(events?.n ?? 0),
    sourceList: Number(sources?.n ?? 0),
    infoRecords: Number(info?.n ?? 0),
    quotas: Number(quotas?.n ?? 0),
  };
}

async function loadPair(tx: Tx, client: string, org: string, plantCode: string): Promise<PurchasingOrgPlantRow | null> {
  const [row] = await tx
    .select({
      purchasingOrg: purchasingOrgPlant.purchasingOrg,
      purchasingOrgName: purchasingOrg.name,
      purchasingOrgCompanyCode: purchasingOrg.companyCode,
      plant: purchasingOrgPlant.plant,
      plantName: plant.name,
      plantCompanyCode: plant.companyCode,
      changedBy: purchasingOrgPlant.changedBy,
      changedAt: purchasingOrgPlant.changedAt,
      createdBy: purchasingOrgPlant.createdBy,
      createdAt: purchasingOrgPlant.createdAt,
    })
    .from(purchasingOrgPlant)
    .innerJoin(purchasingOrg, and(
      eq(purchasingOrg.client, purchasingOrgPlant.client),
      eq(purchasingOrg.purchasingOrg, purchasingOrgPlant.purchasingOrg),
    ))
    .innerJoin(plant, and(
      eq(plant.client, purchasingOrgPlant.client),
      eq(plant.plant, purchasingOrgPlant.plant),
    ))
    .where(and(
      eq(purchasingOrgPlant.client, client),
      eq(purchasingOrgPlant.purchasingOrg, org),
      eq(purchasingOrgPlant.plant, plantCode),
    ));
  if (!row) return null;
  return {
    purchasingOrg: row.purchasingOrg,
    purchasingOrgName: row.purchasingOrgName,
    purchasingOrgCompanyCode: row.purchasingOrgCompanyCode,
    plant: row.plant,
    plantName: row.plantName,
    plantCompanyCode: row.plantCompanyCode,
    changedBy: row.changedBy ?? row.createdBy,
    changedAt: (row.changedAt ?? row.createdAt).toISOString(),
    citations: await documentCitations(tx, client, org, plantCode),
  };
}

export async function listPurchasingOrgPlantAssignments(client: string): Promise<PurchasingOrgPlantRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        purchasingOrg: purchasingOrgPlant.purchasingOrg,
        plant: purchasingOrgPlant.plant,
      })
      .from(purchasingOrgPlant)
      .where(eq(purchasingOrgPlant.client, tenant))
      .orderBy(purchasingOrgPlant.purchasingOrg, purchasingOrgPlant.plant);
    const listed: PurchasingOrgPlantRow[] = [];
    for (const row of rows) {
      const loaded = await loadPair(tx, tenant, row.purchasingOrg, row.plant);
      if (loaded) listed.push(loaded);
    }
    return listed;
  });
}

/** A check reads one pair. It writes nothing, and a missing period does not block it. */
export async function checkPurchasingOrgPlant(client: string, purchasingOrgCode: string, plantCode: string) {
  const tenant = requireClient(client);
  const org = requireOrg(purchasingOrgCode);
  const site = requirePlant(plantCode);
  return withTenant(tenant, async (tx) => {
    const allowed = await purchasingOrgMayBuyForPlant(tx, tenant, org, site);
    const row = allowed ? await loadPair(tx, tenant, org, site) : null;
    if (!row) {
      throw new PurchasingOrgPlantAssignmentError(
        `Purchasing organisation ${org} is not assigned to plant ${site}.`,
        'Assign the pair, or check a pair that already stands.',
      );
    }
    return row;
  });
}

export { purchasingOrgMayBuyForPlant };

export async function assignPurchasingOrgPlant(input: PurchasingOrgPlantInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const org = requireOrg(input.purchasingOrg);
  const site = requirePlant(input.plant);
  const requestKey = requestKeyOf(input.requestKey);
  refuseAbsent(input);
  const key = objectKey(org, site);

  return withTenant(client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/purchasing_org_plant/${key}`}, 0))`);
    const prior = await priorRequest(tx, client, requestKey);
    const standing = await loadPair(tx, client, org, site);
    if (prior) {
      if (prior.objectKey !== key) {
        throw new PurchasingOrgPlantAssignmentError(
          `This request key already recorded an assignment of ${prior.objectKey}.`,
          'Use a new request key for a different pair.',
        );
      }
      if (!standing) {
        throw new PurchasingOrgPlantAssignmentError(
          `This request key recorded ${org} / ${site}, which no longer stands.`,
          'Assign it again under a new request key.',
        );
      }
      return { purchasingOrg: org, plant: site, assigned: false, replayed: true };
    }
    if (standing) {
      return { purchasingOrg: org, plant: site, assigned: false, replayed: false };
    }

    const [organisation] = await tx
      .select()
      .from(purchasingOrg)
      .where(and(eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, org)))
      .for('update');
    if (!organisation) {
      throw new PurchasingOrgPlantAssignmentError(
        `Purchasing organisation ${org} does not stand.`,
        'Define it first (CFG.PROC.PURORG.DEFINE).',
      );
    }
    if (!organisation.isActive) {
      throw new PurchasingOrgPlantAssignmentError(
        `Purchasing organisation ${org} is inactive.`,
        'Activate the organisation, or choose an active one.',
      );
    }
    const [siteRow] = await tx
      .select()
      .from(plant)
      .where(and(eq(plant.client, client), eq(plant.plant, site)))
      .for('update');
    if (!siteRow) {
      throw new PurchasingOrgPlantAssignmentError(
        `Plant ${site} does not stand.`,
        'Define the plant first (CFG.ORG.PLANT.DEFINE).',
      );
    }
    if (!siteRow.isActive) {
      throw new PurchasingOrgPlantAssignmentError(
        `Plant ${site} is inactive.`,
        'Activate the plant, or choose an active one.',
      );
    }
    if (!siteRow.companyCode) {
      throw new PurchasingOrgPlantAssignmentError(
        `Plant ${site} has no company code.`,
        'Assign the plant to a company code first (CFG.ORG.PLANT.ASSIGN_COMPANY). The company code is not entered here.',
      );
    }
    if (organisation.companyCode && organisation.companyCode !== siteRow.companyCode) {
      throw new PurchasingOrgPlantAssignmentError(
        `Purchasing organisation ${org} belongs to company code ${organisation.companyCode}, and plant ${site} belongs to ${siteRow.companyCode}.`,
        'Assign a plant of the organisation company code. This product does not authorise one organisation to buy for another company.',
      );
    }

    await tx.insert(purchasingOrgPlant).values({
      client,
      purchasingOrg: org,
      plant: site,
      createdBy: changedBy,
    });
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CREATE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      after: { purchasingOrg: org, plant: site, plantCompanyCode: siteRow.companyCode },
      securityRelevantFields: ['purchasingOrg', 'plant'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { purchasingOrg: org, plant: site, assigned: true, replayed: false };
  });
}

export async function removePurchasingOrgPlant(input: PurchasingOrgPlantInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const org = requireOrg(input.purchasingOrg);
  const site = requirePlant(input.plant);
  const requestKey = requestKeyOf(input.requestKey);
  const key = objectKey(org, site);

  return withTenant(client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/purchasing_org_plant/${key}`}, 0))`);
    const prior = await priorRequest(tx, client, requestKey);
    const [existing] = await tx
      .select()
      .from(purchasingOrgPlant)
      .where(and(
        eq(purchasingOrgPlant.client, client),
        eq(purchasingOrgPlant.purchasingOrg, org),
        eq(purchasingOrgPlant.plant, site),
      ))
      .for('update');
    if (prior?.changeType === 'DELETE' && prior.objectKey === key && !existing) {
      return { purchasingOrg: org, plant: site, removed: false, replayed: true };
    }
    if (!existing) {
      throw new PurchasingOrgPlantAssignmentError(
        `Purchasing organisation ${org} is not assigned to plant ${site}.`,
        'Nothing remains to remove.',
      );
    }
    const cited = await documentCitations(tx, client, org, site);
    if (citationTotal(cited) > 0) {
      throw new PurchasingOrgPlantAssignmentError(
        `Purchasing organisation ${org} and plant ${site} are cited by ${citationText(cited)}. The assignment is not removed.`,
        'Leave it standing. Those documents keep the organisation and plant they were saved with. This removal does not rewrite them.',
      );
    }
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before: { purchasingOrg: org, plant: site },
    });
    await tx.delete(purchasingOrgPlant).where(and(
      eq(purchasingOrgPlant.client, client),
      eq(purchasingOrgPlant.purchasingOrg, org),
      eq(purchasingOrgPlant.plant, site),
    ));
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { purchasingOrg: org, plant: site, removed: true, replayed: false };
  });
}

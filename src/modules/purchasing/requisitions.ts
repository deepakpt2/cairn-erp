/**
 * Purchase requisitions — SCR-055 / R-103 (ME51N create, ME52N change,
 * ME53N display).
 *
 * An item-level purchasing document with no header record. Creation is
 * judged against the standing masters — plant, material and its plant
 * extension, storage location, purchasing group, cost centre and G/L —
 * and never against the FI or material posting periods: saving a
 * requisition posts nothing (R-103, the package's §4). Numbers draw
 * from the PURCHREQ range through the standing engine. Deletion is an
 * item mark, never physical deletion; release, conversion links and
 * ordered quantities belong to later rounds, each named in R-103.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { unitOfMeasure } from '../../platform/tables/reference';
import {
  assertPurchasingOrgForPlant,
  PurchasingOrgPlantAuthorizationError,
} from '../foundation/purchasing-org-plant';
import {
  companyCode, controllingAreaCompany, costCenter, plant, purchasingGroup, storageLocation,
} from '../foundation/schema';
import { glAccount } from '../finance/schema';
import { material, materialGroup, materialPlant } from '../inventory/schema';
import { purchaseRequisitionAssignment, purchaseRequisitionItem } from './schema';
import {
  ReleaseError, assertDocumentNotReleased, requisitionAttributes, syncDocumentRelease,
} from './release';

export const PR_CREATE_CAPABILITY = 'PROC.PR.CREATE';
export const PR_OBJECT_CLASS = 'purchase_requisition';

/** Delivered document types this round; a maintenance screen is deferred (R-103). */
export const REQUISITION_TYPES = [
  { code: 'STANDARD', name: 'Standard requisition', rangeSubObject: 'NB' },
] as const;

export class PurchaseRequisitionError extends Error {
  remedy?: string;
  code?: string;

  constructor(message: string, remedy?: string, code?: string) {
    super(message);
    this.name = 'PurchaseRequisitionError';
    this.remedy = remedy;
    this.code = code;
  }
}

const assignmentInput = z.object({
  glAccount: z.string().trim().min(1).max(10),
  costCenter: z.string().trim().min(1).max(10),
  distributionPercentage: z.coerce.number().positive().max(100),
});

const itemInput = z.object({
  itemNumber: z.coerce.number().int().positive().optional(),
  materialNumber: z.string().trim().max(40).optional().default(''),
  shortText: z.string().trim().max(40).optional().default(''),
  quantity: z.coerce.number().positive(),
  unit: z.string().trim().max(6).optional().default(''),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a delivery date is required'),
  plant: z.string().trim().min(1).max(10),
  storageLocation: z.string().trim().max(10).optional().default(''),
  purchasingGroup: z.string().trim().min(1).max(3),
  /** Not stored. When a caller names an organisation, the pair is judged and then discarded. */
  purchasingOrg: z.string().trim().max(10).optional().default(''),
  estimatedPrice: z.coerce.number().min(0).optional(),
  priceUnit: z.coerce.number().int().positive().optional().default(1),
  currency: z.string().trim().max(5).optional().default(''),
  accountAssignmentCategory: z.enum(['COST_CENTER']).nullable().optional().default(null),
  markedForDeletion: z.boolean().optional().default(false),
  assignments: z.array(assignmentInput).optional().default([]),
});

const documentInput = z.object({
  client: z.string().min(1),
  changedBy: z.string().min(1),
  documentType: z.string().trim().min(1).max(20).optional().default('STANDARD'),
  /** Total planning's run number. A buyer's requisition does not send one. */
  planningRunNumber: z.string().trim().max(12).optional(),
  items: z.array(itemInput).min(1, 'a requisition needs at least one item'),
});

export type RequisitionItemInput = z.input<typeof itemInput>;
export type CreateRequisitionInput = z.input<typeof documentInput>;

export interface RequisitionItemRow {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  quantity: string;
  unit: string;
  deliveryDate: string;
  plant: string;
  storageLocation: string | null;
  purchasingGroup: string;
  materialGroup: string | null;
  estimatedPrice: string | null;
  priceUnit: string;
  currency: string | null;
  accountAssignmentCategory: string | null;
  markedForDeletion: boolean;
  assignments: Array<{ lineNumber: number; glAccount: string; costCenter: string; distributionPercentage: string }>;
}

export interface RequisitionDocument {
  requisitionNumber: string;
  documentType: string;
  requisitionDate: string;
  createdBy: string;
  createdAt: Date;
  items: RequisitionItemRow[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function judgeItem(
  tx: Tx,
  client: string,
  item: z.infer<typeof itemInput>,
  requisitionDate: string,
  warnings: string[],
): Promise<{
  values: typeof purchaseRequisitionItem.$inferInsert;
}> {
  const [plantRow] = await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, item.plant)));
  if (!plantRow) throw new PurchaseRequisitionError(`Plant ${item.plant} does not exist.`, 'Pick a standing plant; plants are maintained on the plants screen.');
  if (item.purchasingOrg) {
    try {
      await assertPurchasingOrgForPlant(tx, {
        client,
        purchasingOrg: item.purchasingOrg,
        plant: item.plant,
        documentType: 'PURCHASE_REQUISITION',
      });
    } catch (error) {
      if (error instanceof PurchasingOrgPlantAuthorizationError) {
        throw new PurchaseRequisitionError(error.message, error.remedy, error.code);
      }
      throw error;
    }
  }
  if (!plantRow.companyCode) {
    throw new PurchaseRequisitionError(
      `Plant ${item.plant} belongs to no company code, so its assignments cannot be judged.`,
      'Assign the plant to a company code first.',
    );
  }
  const [company] = await tx.select().from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, plantRow.companyCode)));

  if (item.storageLocation) {
    const [sl] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, client), eq(storageLocation.plant, item.plant),
      eq(storageLocation.storageLocation, item.storageLocation),
    ));
    if (!sl?.isActive) {
      throw new PurchaseRequisitionError(`Storage location ${item.storageLocation} does not stand active at plant ${item.plant}.`);
    }
  }

  const [group] = await tx.select().from(purchasingGroup)
    .where(and(eq(purchasingGroup.client, client), eq(purchasingGroup.purchasingGroup, item.purchasingGroup)));
  if (!group?.isActive) throw new PurchaseRequisitionError(`Purchasing group ${item.purchasingGroup} does not exist or is inactive.`);

  let shortText = item.shortText;
  let unit = item.unit;
  let group9: string | null = null;
  if (item.materialNumber) {
    const [mat] = await tx.select().from(material)
      .where(and(eq(material.client, client), eq(material.materialNumber, item.materialNumber)));
    if (!mat) throw new PurchaseRequisitionError(`Material ${item.materialNumber} does not exist.`, 'Pick a standing material or clear the field for a text item.');
    const [ext] = await tx.select().from(materialPlant).where(and(
      eq(materialPlant.client, client), eq(materialPlant.materialNumber, item.materialNumber),
      eq(materialPlant.plant, item.plant),
    ));
    if (!ext) {
      throw new PurchaseRequisitionError(
        `Material ${item.materialNumber} is not extended to plant ${item.plant}.`,
        'Extend the material to the plant on the material master, or choose another plant.',
      );
    }
    if (mat.markedForDeletion || ext.markedForDeletion) {
      warnings.push(`Material ${item.materialNumber} is flagged for deletion (SCR-053) — the flag warns here; it does not block a requisition.`);
    }
    if (!shortText) shortText = mat.description;
    if (!unit) unit = mat.baseUnit ?? '';
    if (mat.materialGroup) {
      const [g] = await tx.select().from(materialGroup)
        .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, mat.materialGroup)));
      if (g?.isActive) group9 = g.materialGroup;
    }
  }
  if (!shortText) throw new PurchaseRequisitionError('A short text is required — from the material master or entered for a text item.');
  if (!unit) throw new PurchaseRequisitionError('A unit of measure is required.', 'Enter the unit the quantity is counted in.');
  const [unitRow] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, unit));
  if (!unitRow) throw new PurchaseRequisitionError(`Unit ${unit} is not a standing unit of measure.`);

  const currency = item.currency || (item.estimatedPrice !== undefined ? company?.currency ?? '' : '');
  if (item.estimatedPrice !== undefined && !currency) {
    throw new PurchaseRequisitionError('A currency is required with an estimated price.');
  }

  if (item.accountAssignmentCategory === 'COST_CENTER') {
    if (item.assignments.length === 0) {
      throw new PurchaseRequisitionError('A cost-centre item needs at least one account assignment row.');
    }
    const total = item.assignments.reduce((sum, row) => sum + row.distributionPercentage, 0);
    if (Math.abs(total - 100) > 0.005) {
      throw new PurchaseRequisitionError(`Assignment percentages total ${total.toFixed(2)}, not 100.`, 'Distribute the item fully across its assignment rows.');
    }
    const [area] = await tx.select().from(controllingAreaCompany).where(and(
      eq(controllingAreaCompany.client, client), eq(controllingAreaCompany.companyCode, plantRow.companyCode),
    ));
    for (const row of item.assignments) {
      if (!area) {
        throw new PurchaseRequisitionError(`Company code ${plantRow.companyCode} belongs to no controlling area, so cost centre ${row.costCenter} cannot be judged.`);
      }
      const centres = await tx.select().from(costCenter).where(and(
        eq(costCenter.client, client), eq(costCenter.controllingArea, area.controllingArea),
        eq(costCenter.costCenter, row.costCenter),
      ));
      const standing = centres.find((c) => c.validFrom <= requisitionDate && c.validTo >= requisitionDate);
      if (!standing) {
        throw new PurchaseRequisitionError(`Cost centre ${row.costCenter} does not stand valid on ${requisitionDate} in controlling area ${area.controllingArea}.`);
      }
      if (standing.isPostingLocked) throw new PurchaseRequisitionError(`Cost centre ${row.costCenter} is locked for postings.`);
      if (!company?.chartOfAccounts) throw new PurchaseRequisitionError(`Company code ${plantRow.companyCode} has no chart of accounts assigned.`);
      const [account] = await tx.select().from(glAccount).where(and(
        eq(glAccount.client, client), eq(glAccount.chartOfAccounts, company.chartOfAccounts),
        eq(glAccount.accountNumber, row.glAccount),
      ));
      if (!account) {
        throw new PurchaseRequisitionError(`G/L account ${row.glAccount} does not exist in chart ${company.chartOfAccounts}.`);
      }
      if (account.isBalanceSheet) {
        throw new PurchaseRequisitionError(`G/L account ${row.glAccount} is a balance-sheet account; a consumption assignment needs a P&L account.`);
      }
    }
  } else if (item.assignments.length > 0) {
    throw new PurchaseRequisitionError('A stock item carries no account assignments.', 'Clear the assignment rows or choose the cost-centre category.');
  }

  return {
    values: {
      client,
      requisitionNumber: '',
      itemNumber: 0,
      documentType: 'STANDARD',
      itemCategory: 'STANDARD',
      accountAssignmentCategory: item.accountAssignmentCategory,
      materialNumber: item.materialNumber || null,
      shortText,
      quantity: String(item.quantity),
      unit,
      requisitionDate,
      deliveryDate: item.deliveryDate,
      plant: item.plant,
      storageLocation: item.storageLocation || null,
      purchasingGroup: item.purchasingGroup,
      materialGroup: group9,
      estimatedPrice: item.estimatedPrice !== undefined ? String(item.estimatedPrice) : null,
      priceUnit: String(item.priceUnit),
      currency: currency || null,
      markedForDeletion: item.markedForDeletion,
      creationSource: 'MANUAL',
    },
  };
}

async function loadDocument(tx: Tx, client: string, requisitionNumber: string): Promise<RequisitionDocument | null> {
  const items = await tx.select().from(purchaseRequisitionItem)
    .where(and(eq(purchaseRequisitionItem.client, client), eq(purchaseRequisitionItem.requisitionNumber, requisitionNumber)))
    .orderBy(asc(purchaseRequisitionItem.itemNumber));
  if (items.length === 0) return null;
  const assignments = await tx.select().from(purchaseRequisitionAssignment)
    .where(and(eq(purchaseRequisitionAssignment.client, client), eq(purchaseRequisitionAssignment.requisitionNumber, requisitionNumber)))
    .orderBy(asc(purchaseRequisitionAssignment.itemNumber), asc(purchaseRequisitionAssignment.lineNumber));
  return {
    requisitionNumber,
    documentType: items[0].documentType,
    requisitionDate: items[0].requisitionDate,
    createdBy: items[0].createdBy,
    createdAt: items[0].createdAt,
    items: items.map((item) => ({
      itemNumber: item.itemNumber,
      materialNumber: item.materialNumber,
      shortText: item.shortText,
      quantity: item.quantity,
      unit: item.unit,
      deliveryDate: item.deliveryDate,
      plant: item.plant,
      storageLocation: item.storageLocation,
      purchasingGroup: item.purchasingGroup,
      materialGroup: item.materialGroup,
      estimatedPrice: item.estimatedPrice,
      priceUnit: item.priceUnit,
      currency: item.currency,
      accountAssignmentCategory: item.accountAssignmentCategory,
      markedForDeletion: item.markedForDeletion,
      assignments: assignments
        .filter((a) => a.itemNumber === item.itemNumber)
        .map((a) => ({
          lineNumber: a.lineNumber, glAccount: a.glAccount, costCenter: a.costCenter,
          distributionPercentage: a.distributionPercentage,
        })),
    })),
  };
}

export async function listRequisitions(client: string): Promise<RequisitionDocument[]> {
  return withTenant(client, async (tx) => {
    const numbers = await tx.execute(sql`
      select requisition_number from purchase_requisition_item
      where client = ${client} group by requisition_number order by requisition_number desc limit 100
    `);
    const docs: RequisitionDocument[] = [];
    for (const row of numbers as unknown as Array<{ requisition_number: string }>) {
      const doc = await loadDocument(tx, client, row.requisition_number);
      if (doc) docs.push(doc);
    }
    return docs;
  });
}

export async function getRequisition(client: string, requisitionNumber: string): Promise<RequisitionDocument | null> {
  return withTenant(client, (tx) => loadDocument(tx, client, requisitionNumber));
}

export async function createRequisition(
  raw: CreateRequisitionInput,
): Promise<{ requisitionNumber: string; warnings: string[] }> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PurchaseRequisitionError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const type = REQUISITION_TYPES.find((t) => t.code === input.documentType);
  if (!type) throw new PurchaseRequisitionError(`Document type ${input.documentType} does not stand.`);
  const warnings: string[] = [];
  const requisitionDate = today();

  const requisitionNumber = await withTenant(input.client, async (tx) => {
    if (input.planningRunNumber && input.items[0]?.materialNumber && input.items[0]?.plant) {
      const already = await tx.execute(sql`
        select requisition_number
          from purchase_requisition_item
         where client = ${input.client}
           and planning_run_number = ${input.planningRunNumber}
           and material_number = ${input.items[0].materialNumber}
           and plant = ${input.items[0].plant}
         limit 1
      `) as unknown as Array<{ requisition_number: string }>;
      if (already[0]?.requisition_number) return already[0].requisition_number;
    }
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client,
        objectCode: 'PURCHREQ',
        companyCode: '*',
        subObject: type.rangeSubObject,
        fiscalYear: 0,
        allocatedBy: input.changedBy,
      });
    } catch {
      throw new PurchaseRequisitionError(
        'No active internal PURCHREQ number range stands, so no requisition number can be drawn.',
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }
    const number = drawn.display;
    let itemNumber = 0;
    for (const item of input.items) {
      itemNumber += 10;
      const { values } = await judgeItem(tx, input.client, item, requisitionDate, warnings);
      await tx.insert(purchaseRequisitionItem).values({
        ...values,
        documentType: type.code,
        requisitionNumber: number,
        itemNumber,
        createdBy: input.changedBy,
        planningRunNumber: input.planningRunNumber ?? null,
      });
      let line = 0;
      for (const row of item.assignments) {
        line += 1;
        await tx.insert(purchaseRequisitionAssignment).values({
          client: input.client,
          requisitionNumber: number,
          itemNumber,
          lineNumber: line,
          glAccount: row.glAccount,
          costCenter: row.costCenter,
          distributionPercentage: String(row.distributionPercentage),
          createdBy: input.changedBy,
        });
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: PR_OBJECT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      after: { documentType: type.code, items: input.items.length, requisitionDate },
    });
    await syncDocumentRelease(
      tx, input.client, 'PURCHASE_REQUISITION', number,
      await requisitionAttributes(tx, input.client, number), input.changedBy,
    );
    return number;
  });
  return { requisitionNumber, warnings };
}

export async function changeRequisition(
  raw: CreateRequisitionInput & { requisitionNumber: string },
): Promise<{ requisitionNumber: string; warnings: string[] }> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PurchaseRequisitionError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const warnings: string[] = [];

  await withTenant(input.client, async (tx) => {
    const before = await loadDocument(tx, input.client, raw.requisitionNumber);
    if (!before) throw new PurchaseRequisitionError(`Requisition ${raw.requisitionNumber} does not exist.`);
    try {
      await assertDocumentNotReleased(tx, input.client, 'PURCHASE_REQUISITION', raw.requisitionNumber, 'Requisition');
    } catch (error) {
      if (error instanceof ReleaseError) throw new PurchaseRequisitionError(error.message, error.remedy);
      throw error;
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/purchase-requisition/${raw.requisitionNumber}`}, 0))`);

    const standingNumbers = new Set(before.items.map((i) => i.itemNumber));
    let maxItem = Math.max(0, ...standingNumbers);
    for (const item of input.items) {
      const isNew = item.itemNumber === undefined || !standingNumbers.has(item.itemNumber);
      const itemNumber = isNew ? (maxItem += 10) : (item.itemNumber as number);
      const { values } = await judgeItem(tx, input.client, item, before.requisitionDate, warnings);
      if (isNew) {
        await tx.insert(purchaseRequisitionItem).values({
          ...values,
          documentType: before.documentType,
          requisitionNumber: raw.requisitionNumber,
          itemNumber,
          requisitionDate: before.requisitionDate,
          createdBy: input.changedBy,
        });
      } else {
        await tx.update(purchaseRequisitionItem).set({
          ...values,
          requisitionNumber: raw.requisitionNumber,
          itemNumber,
          requisitionDate: before.requisitionDate,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(purchaseRequisitionItem.client, input.client),
          eq(purchaseRequisitionItem.requisitionNumber, raw.requisitionNumber),
          eq(purchaseRequisitionItem.itemNumber, itemNumber),
        ));
        await tx.delete(purchaseRequisitionAssignment).where(and(
          eq(purchaseRequisitionAssignment.client, input.client),
          eq(purchaseRequisitionAssignment.requisitionNumber, raw.requisitionNumber),
          eq(purchaseRequisitionAssignment.itemNumber, itemNumber),
        ));
      }
      let line = 0;
      for (const row of item.assignments) {
        line += 1;
        await tx.insert(purchaseRequisitionAssignment).values({
          client: input.client,
          requisitionNumber: raw.requisitionNumber,
          itemNumber,
          lineNumber: line,
          glAccount: row.glAccount,
          costCenter: row.costCenter,
          distributionPercentage: String(row.distributionPercentage),
          createdBy: input.changedBy,
        });
      }
    }
    await syncDocumentRelease(
      tx, input.client, 'PURCHASE_REQUISITION', raw.requisitionNumber,
      await requisitionAttributes(tx, input.client, raw.requisitionNumber), input.changedBy,
    );
    const after = await loadDocument(tx, input.client, raw.requisitionNumber);
    await recordChange(tx, {
      client: input.client,
      objectClass: PR_OBJECT_CLASS,
      objectKey: raw.requisitionNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      before: { items: before.items.map((i) => ({ item: i.itemNumber, qty: i.quantity, deleted: i.markedForDeletion })) },
      after: { items: after?.items.map((i) => ({ item: i.itemNumber, qty: i.quantity, deleted: i.markedForDeletion })) },
    });
  });
  return { requisitionNumber: raw.requisitionNumber, warnings };
}

export interface RequisitionChoices {
  plants: Array<{ plant: string; name: string; companyCode: string | null }>;
  storageLocations: Array<{ plant: string; storageLocation: string; name: string }>;
  purchasingGroups: Array<{ purchasingGroup: string; name: string }>;
  units: string[];
}

export async function requisitionChoices(client: string): Promise<RequisitionChoices> {
  return withTenant(client, async (tx) => {
    const plantRows = await tx.select().from(plant).where(eq(plant.client, client)).orderBy(asc(plant.plant));
    const slRows = await tx.select().from(storageLocation).where(eq(storageLocation.client, client));
    const groupRows = await tx.select().from(purchasingGroup).where(eq(purchasingGroup.client, client));
    const unitRows = await tx.select().from(unitOfMeasure).orderBy(asc(unitOfMeasure.code));
    return {
      plants: plantRows.map((p) => ({ plant: p.plant, name: p.name, companyCode: p.companyCode })),
      storageLocations: slRows.filter((s) => s.isActive).map((s) => ({
        plant: s.plant, storageLocation: s.storageLocation, name: s.name,
      })),
      purchasingGroups: groupRows.filter((g) => g.isActive).map((g) => ({
        purchasingGroup: g.purchasingGroup, name: g.name,
      })),
      units: unitRows.map((u) => u.code),
    };
  });
}

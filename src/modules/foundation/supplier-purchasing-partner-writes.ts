/** Audited tenant-scoped writes for directed supplier purchasing partner assignments. */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { businessPartner, bpRole } from './business-partner-schema';
import { purchasingOrg } from './schema';
import { supplierPartnerFunction, supplierPurchasingPartner, SUPPLIER_PARTNER_FUNCTION_CODES } from './supplier-partner-schema';
import { supplierPurchasing } from './supplier-purchasing-schema';

const partnerNumber = z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/);
const code = z.string().regex(/^[A-Z0-9]{2,10}$/);
const saveSchema = z.object({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  partnerNumber,
  purchasingOrg: code,
  functionCode: z.enum(SUPPLIER_PARTNER_FUNCTION_CODES),
  assignedPartnerNumber: partnerNumber,
  /** Existing related supplier key when atomically replacing that assignment. */
  replaceAssignedPartnerNumber: partnerNumber.optional(),
  /** Zero for create; otherwise the current assignment version being edited/replaced. */
  expectedVersion: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  changedBy: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(3).max(500),
});
const removeSchema = z.object({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  partnerNumber,
  purchasingOrg: code,
  functionCode: z.enum(SUPPLIER_PARTNER_FUNCTION_CODES),
  assignedPartnerNumber: partnerNumber,
  expectedVersion: z.number().int().positive(),
  changedBy: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(3).max(500),
});

export type SupplierPurchasingPartnerInput = z.input<typeof saveSchema>;
export type RemoveSupplierPurchasingPartnerInput = z.input<typeof removeSchema>;

export class SupplierPurchasingPartnerError extends Error {
  constructor(message: string, readonly remedy = 'Review the supplier partner assignment and try again.') {
    super(message);
  }
}

const slotKey = (client: string, partner: string, org: string, functionCode: string) => and(
  eq(supplierPurchasingPartner.client, client),
  eq(supplierPurchasingPartner.partnerNumber, partner),
  eq(supplierPurchasingPartner.purchasingOrg, org),
  eq(supplierPurchasingPartner.functionCode, functionCode),
);
const rowKey = (client: string, partner: string, org: string, functionCode: string, assigned: string) => and(
  slotKey(client, partner, org, functionCode),
  eq(supplierPurchasingPartner.assignedPartnerNumber, assigned),
);
const assignmentObjectKey = (partner: string, org: string, functionCode: string, assigned: string) =>
  `${partner}/${org}/${functionCode}/${assigned}`;

function state(row: {
  partnerNumber: string;
  purchasingOrg: string;
  functionCode: string;
  assignedPartnerNumber: string;
  isDefault: boolean;
}) {
  return {
    partnerNumber: row.partnerNumber,
    purchasingOrg: row.purchasingOrg,
    functionCode: row.functionCode,
    assignedPartnerNumber: row.assignedPartnerNumber,
    assignedRoleCode: 'SUPPLIER',
    isDefault: row.isDefault,
  };
}

async function lockSlot(tx: Tx, client: string, partner: string, org: string, functionCode: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/supplier_partner_function/${partner}/${org}/${functionCode}`}, 0))`);
}

async function validateContext(
  tx: Tx,
  client: string,
  partner: string,
  org: string,
  functionCode: string,
  assigned: string,
) {
  const [owner] = await tx.select({ partnerNumber: businessPartner.partnerNumber }).from(businessPartner)
    .where(and(eq(businessPartner.client, client), eq(businessPartner.partnerNumber, partner)));
  const [ownerRole] = await tx.select({ isActive: bpRole.isActive }).from(bpRole)
    .where(and(eq(bpRole.client, client), eq(bpRole.partnerNumber, partner), eq(bpRole.roleCode, 'SUPPLIER')));
  if (!owner || !ownerRole?.isActive) throw new SupplierPurchasingPartnerError('An active Supplier role is required for the focal partner.');

  const [segment] = await tx.select({ partnerNumber: supplierPurchasing.partnerNumber }).from(supplierPurchasing)
    .where(and(eq(supplierPurchasing.client, client), eq(supplierPurchasing.partnerNumber, partner), eq(supplierPurchasing.purchasingOrg, org)));
  if (!segment) throw new SupplierPurchasingPartnerError('Create the focal supplier purchasing-organisation segment first.');
  const [organisation] = await tx.select({ isActive: purchasingOrg.isActive }).from(purchasingOrg)
    .where(and(eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, org)));
  if (!organisation?.isActive) throw new SupplierPurchasingPartnerError('Purchasing organisation is missing or inactive.');

  // Lock the rule for the duration of the write so future configuration writes cannot
  // race cardinality validation. The advisory lock serializes all assignments in this slot.
  const [fn] = await tx.select().from(supplierPartnerFunction)
    .where(and(eq(supplierPartnerFunction.client, client), eq(supplierPartnerFunction.functionCode, functionCode)))
    .for('update');
  if (!fn?.isActive) throw new SupplierPurchasingPartnerError('Supplier partner function is missing or inactive.');

  const [related] = await tx.select({ partnerNumber: businessPartner.partnerNumber }).from(businessPartner)
    .where(and(eq(businessPartner.client, client), eq(businessPartner.partnerNumber, assigned)));
  const [relatedRole] = await tx.select({ isActive: bpRole.isActive }).from(bpRole)
    .where(and(eq(bpRole.client, client), eq(bpRole.partnerNumber, assigned), eq(bpRole.roleCode, 'SUPPLIER')));
  if (!related || !relatedRole?.isActive) throw new SupplierPurchasingPartnerError('The assigned partner must have an active Supplier role in this tenant.');
  return fn;
}

/** Create, update its default flag, or atomically replace a directed Supplier assignment. */
export async function saveSupplierPurchasingPartner(raw: SupplierPurchasingPartnerInput) {
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) throw new SupplierPurchasingPartnerError(parsed.error.issues[0].message);
  const {
    client, partnerNumber: partner, purchasingOrg: org, functionCode,
    assignedPartnerNumber: assigned, replaceAssignedPartnerNumber, expectedVersion,
    isDefault, changedBy, reason,
  } = parsed.data;

  return withTenant(client, async tx => {
    await lockSlot(tx, client, partner, org, functionCode);
    const fn = await validateContext(tx, client, partner, org, functionCode, assigned);
    const rows = await tx.select().from(supplierPurchasingPartner).where(slotKey(client, partner, org, functionCode)).for('update');
    const replacementSource = replaceAssignedPartnerNumber === assigned ? undefined : replaceAssignedPartnerNumber;
    const target = rows.find(row => row.assignedPartnerNumber === assigned);
    const current = replacementSource
      ? rows.find(row => row.assignedPartnerNumber === replacementSource)
      : target;

    if (replacementSource && !current) {
      throw new SupplierPurchasingPartnerError('The assignment being replaced no longer exists.','Reload the purchasing-organisation partner list before replacing it.');
    }
    if (replacementSource && target && target !== current) {
      throw new SupplierPurchasingPartnerError('The assigned Supplier is already listed for this function.');
    }
    if (current ? current.version !== expectedVersion : expectedVersion !== 0) {
      throw new SupplierPurchasingPartnerError('Supplier partner assignments changed after the list was opened.','Reload the current assignments before saving.');
    }
    if (isDefault && !fn.allowsMultiple) {
      throw new SupplierPurchasingPartnerError('A default can only be selected for a function configured to allow multiple Suppliers.');
    }
    if (!fn.allowsMultiple && (rows.length > 1 || (rows.length === 1 && rows[0] !== current))) {
      throw new SupplierPurchasingPartnerError('This function allows only one assigned Supplier.','Remove or resolve existing assignments before changing the unique function.');
    }
    if (!replacementSource && current && current.isDefault === isDefault) {
      return { changed: false, version: current.version, isDefault: current.isDefault };
    }

    const priorDefault = isDefault
      ? rows.find(row => row.isDefault && row.assignedPartnerNumber !== current?.assignedPartnerNumber)
      : undefined;
    if (priorDefault) {
      await tx.update(supplierPurchasingPartner)
        .set({ isDefault: false, version: priorDefault.version + 1, changedBy, changedAt: new Date() })
        .where(rowKey(client, partner, org, functionCode, priorDefault.assignedPartnerNumber));
      await recordChange(tx, {
        client, objectClass: 'supplier_purchasing_partner',
        objectKey: assignmentObjectKey(partner, org, functionCode, priorDefault.assignedPartnerNumber),
        changeType: 'CHANGE', changedBy, reason, transactionCode: 'PROC.SUPPLIER.PARTNERFUNCTION.MAINTAIN',
        before: state(priorDefault), after: { ...state(priorDefault), isDefault: false },
        fieldLabels: { isDefault: 'Default assignment' }, securityRelevantFields: ['isDefault'],
      });
    }

    const nextVersion = (current?.version ?? 0) + 1;
    if (current && replacementSource) {
      await tx.delete(supplierPurchasingPartner)
        .where(rowKey(client, partner, org, functionCode, current.assignedPartnerNumber));
      await tx.insert(supplierPurchasingPartner).values({
        client, partnerNumber: partner, purchasingOrg: org, functionCode,
        assignedPartnerNumber: assigned, assignedRoleCode: 'SUPPLIER', isDefault,
        version: nextVersion, createdBy: changedBy,
      });
      await recordChange(tx, {
        client, objectClass: 'supplier_purchasing_partner',
        objectKey: assignmentObjectKey(partner, org, functionCode, current.assignedPartnerNumber),
        changeType: 'CHANGE', changedBy, reason, transactionCode: 'PROC.SUPPLIER.PARTNERFUNCTION.MAINTAIN',
        before: state(current), after: { assignmentRemoved: true },
        fieldLabels: { assignedPartnerNumber: 'Assigned Supplier', isDefault: 'Default assignment' },
        securityRelevantFields: ['assignedPartnerNumber', 'isDefault'],
      });
      await recordChange(tx, {
        client, objectClass: 'supplier_purchasing_partner',
        objectKey: assignmentObjectKey(partner, org, functionCode, assigned),
        changeType: 'CREATE', changedBy, reason, transactionCode: 'PROC.SUPPLIER.PARTNERFUNCTION.MAINTAIN',
        after: state({ partnerNumber: partner, purchasingOrg: org, functionCode, assignedPartnerNumber: assigned, isDefault }),
        fieldLabels: { assignedPartnerNumber: 'Assigned Supplier', isDefault: 'Default assignment' },
        securityRelevantFields: ['functionCode', 'assignedPartnerNumber', 'isDefault'],
      });
    } else if (current) {
      await tx.update(supplierPurchasingPartner)
        .set({ isDefault, version: nextVersion, changedBy, changedAt: new Date() })
        .where(rowKey(client, partner, org, functionCode, assigned));
      await recordChange(tx, {
        client, objectClass: 'supplier_purchasing_partner',
        objectKey: assignmentObjectKey(partner, org, functionCode, assigned),
        changeType: 'CHANGE', changedBy, reason, transactionCode: 'PROC.SUPPLIER.PARTNERFUNCTION.MAINTAIN',
        before: state(current), after: { ...state(current), isDefault },
        fieldLabels: { isDefault: 'Default assignment' }, securityRelevantFields: ['isDefault'],
      });
    } else {
      await tx.insert(supplierPurchasingPartner).values({
        client, partnerNumber: partner, purchasingOrg: org, functionCode,
        assignedPartnerNumber: assigned, assignedRoleCode: 'SUPPLIER', isDefault,
        version: nextVersion, createdBy: changedBy,
      });
      await recordChange(tx, {
        client, objectClass: 'supplier_purchasing_partner',
        objectKey: assignmentObjectKey(partner, org, functionCode, assigned),
        changeType: 'CREATE', changedBy, reason, transactionCode: 'PROC.SUPPLIER.PARTNERFUNCTION.MAINTAIN',
        after: state({ partnerNumber: partner, purchasingOrg: org, functionCode, assignedPartnerNumber: assigned, isDefault }),
        fieldLabels: { assignedPartnerNumber: 'Assigned Supplier', isDefault: 'Default assignment' },
        securityRelevantFields: ['functionCode', 'assignedPartnerNumber', 'isDefault'],
      });
    }
    return { changed: true, version: nextVersion, isDefault };
  });
}

/** Remove an assignment without promoting another; a multiple-valued function may have no default. */
export async function removeSupplierPurchasingPartner(raw: RemoveSupplierPurchasingPartnerInput) {
  const parsed = removeSchema.safeParse(raw);
  if (!parsed.success) throw new SupplierPurchasingPartnerError(parsed.error.issues[0].message);
  const { client, partnerNumber: partner, purchasingOrg: org, functionCode, assignedPartnerNumber: assigned, expectedVersion, changedBy, reason } = parsed.data;

  return withTenant(client, async tx => {
    await lockSlot(tx, client, partner, org, functionCode);
    const [current] = await tx.select().from(supplierPurchasingPartner)
      .where(rowKey(client, partner, org, functionCode, assigned)).for('update');
    if (!current || current.version !== expectedVersion) {
      throw new SupplierPurchasingPartnerError('The supplier partner assignment changed or was removed.','Reload the current assignments before removing it.');
    }
    await tx.delete(supplierPurchasingPartner)
      .where(rowKey(client, partner, org, functionCode, assigned));
    await recordChange(tx, {
      client, objectClass: 'supplier_purchasing_partner',
      objectKey: assignmentObjectKey(partner, org, functionCode, assigned),
      changeType: 'CHANGE', changedBy, reason, transactionCode: 'PROC.SUPPLIER.PARTNERFUNCTION.MAINTAIN',
      before: state(current), after: { assignmentRemoved: true },
      fieldLabels: { assignedPartnerNumber: 'Assigned Supplier', isDefault: 'Default assignment' },
      securityRelevantFields: ['assignedPartnerNumber', 'isDefault'],
    });
    return { changed: true, removedVersion: current.version };
  });
}

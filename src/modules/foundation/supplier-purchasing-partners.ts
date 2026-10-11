/** Tenant-scoped read queries for supplier partner-function configuration and assignments. */
import { and, asc, desc, eq } from 'drizzle-orm';
import { withTenant } from '../../platform/db/client';
import { bpRole, businessPartner } from './business-partner-schema';
import { supplierPartnerFunction, supplierPurchasingPartner } from './supplier-partner-schema';

/** Returns configured functions, including inactive rows for configuration/review screens. */
export async function listSupplierPartnerFunctions(client: string) {
  return withTenant(client, tx => tx.select().from(supplierPartnerFunction)
    .where(eq(supplierPartnerFunction.client, client))
    .orderBy(asc(supplierPartnerFunction.functionCode)));
}

/** Supplies same-tenant active Supplier roles for assignment pickers. */
export async function listSupplierPartnerChoices(client: string) {
  return withTenant(client, tx => tx.select({
    partnerNumber: businessPartner.partnerNumber,
    name: businessPartner.name,
    generalStatus: businessPartner.generalStatus,
    isBlocked: businessPartner.isBlocked,
  })
    .from(businessPartner)
    .innerJoin(bpRole, and(
      eq(bpRole.client, businessPartner.client),
      eq(bpRole.partnerNumber, businessPartner.partnerNumber),
      eq(bpRole.roleCode, 'SUPPLIER'),
    ))
    .where(and(
      eq(businessPartner.client, client),
      eq(bpRole.isActive, true),
    ))
    .orderBy(asc(businessPartner.partnerNumber))
    .limit(200));
}

/**
 * Lists a supplier's current assignments for one purchasing organisation.
 * Inactive linked roles/functions are included so maintenance screens can show
 * and resolve stale assignments rather than silently hiding them.
 */
export async function listSupplierPurchasingPartners(client: string, partnerNumber: string, purchasingOrg: string) {
  return withTenant(client, tx => tx.select({
    functionCode: supplierPurchasingPartner.functionCode,
    functionName: supplierPartnerFunction.displayName,
    functionAllowsMultiple: supplierPartnerFunction.allowsMultiple,
    functionIsActive: supplierPartnerFunction.isActive,
    partnerNumber: supplierPurchasingPartner.partnerNumber,
    purchasingOrg: supplierPurchasingPartner.purchasingOrg,
    assignedPartnerNumber: supplierPurchasingPartner.assignedPartnerNumber,
    assignedPartnerName: businessPartner.name,
    assignedPartnerStatus: businessPartner.generalStatus,
    assignedPartnerIsBlocked: businessPartner.isBlocked,
    assignedSupplierIsActive: bpRole.isActive,
    isDefault: supplierPurchasingPartner.isDefault,
    version: supplierPurchasingPartner.version,
  })
    .from(supplierPurchasingPartner)
    .innerJoin(supplierPartnerFunction, and(
      eq(supplierPartnerFunction.client, supplierPurchasingPartner.client),
      eq(supplierPartnerFunction.functionCode, supplierPurchasingPartner.functionCode),
    ))
    .innerJoin(businessPartner, and(
      eq(businessPartner.client, supplierPurchasingPartner.client),
      eq(businessPartner.partnerNumber, supplierPurchasingPartner.assignedPartnerNumber),
    ))
    .innerJoin(bpRole, and(
      eq(bpRole.client, supplierPurchasingPartner.client),
      eq(bpRole.partnerNumber, supplierPurchasingPartner.assignedPartnerNumber),
      eq(bpRole.roleCode, supplierPurchasingPartner.assignedRoleCode),
    ))
    .where(and(
      eq(supplierPurchasingPartner.client, client),
      eq(supplierPurchasingPartner.partnerNumber, partnerNumber),
      eq(supplierPurchasingPartner.purchasingOrg, purchasingOrg),
    ))
    .orderBy(
      asc(supplierPurchasingPartner.functionCode),
      desc(supplierPurchasingPartner.isDefault),
      asc(supplierPurchasingPartner.assignedPartnerNumber),
    ));
}

'use server';
import { revalidatePath } from 'next/cache';
import { AuthzError, can, requireCapability, requireSession } from '@/platform/auth/current';
import { listSupplierPartnerFunctions, listSupplierPurchasingPartners } from '@/modules/foundation/supplier-purchasing-partners';
import {
  removeSupplierPurchasingPartner,
  saveSupplierPurchasingPartner,
  SupplierPurchasingPartnerError,
  type SupplierPurchasingPartnerInput,
} from '@/modules/foundation/supplier-purchasing-partner-writes';

export interface PartnerFunctionActionState {
  ok: boolean;
  changed?: boolean;
  message?: string;
  remedy?: string;
  version?: number;
  isDefault?: boolean;
  removedVersion?: number;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}

/** Tenant is always session-derived; display, maintain, or audit authority permits this read. */
export async function readSupplierPurchasingPartnerAssignmentsAction(partnerNumber: string, purchasingOrg: string) {
  const session = await requireSession('/foundation/partners');
  if (!can(session, 'PROC.SUPPLIER.PURCHASING.DISPLAY') &&
      !can(session, 'PROC.SUPPLIER.PURCHASING.MAINTAIN') &&
      !can(session, 'AUDIT.WORKSPACE')) {
    const error = new AuthzError('PROC.SUPPLIER.PURCHASING.DISPLAY', session.user.username);
    return { ok: false as const, message: error.message, remedy: error.remedy };
  }
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,39}$/.test(partnerNumber) || !/^[A-Z0-9]{2,10}$/.test(purchasingOrg)) {
    return { ok: false as const, message: 'Supplier and purchasing organisation keys are invalid.', remedy: 'Select a valid Supplier and purchasing organisation.' };
  }
  const [catalogue, assignments] = await Promise.all([
    listSupplierPartnerFunctions(session.user.client),
    listSupplierPurchasingPartners(session.user.client, partnerNumber, purchasingOrg),
  ]);
  return {
    ok: true as const,
    functions: catalogue.map(({ functionCode, displayName, allowsMultiple, isActive }) => ({ functionCode, displayName, allowsMultiple, isActive })),
    assignments,
  };
}

export async function saveSupplierPurchasingPartnerAction(
  _previous: PartnerFunctionActionState,
  form: FormData,
): Promise<PartnerFunctionActionState> {
  const session = await requireSession('/foundation/partners');
  try {
    await requireCapability('PROC.SUPPLIER.PURCHASING.MAINTAIN', session);
    const replaceAssignedPartnerNumber = read(form, 'replaceAssignedPartnerNumber');
    const input: SupplierPurchasingPartnerInput = {
      client: session.user.client,
      changedBy: session.user.username,
      partnerNumber: read(form, 'partnerNumber'),
      purchasingOrg: read(form, 'purchasingOrg'),
      functionCode: read(form, 'functionCode') as SupplierPurchasingPartnerInput['functionCode'],
      assignedPartnerNumber: read(form, 'assignedPartnerNumber'),
      ...(replaceAssignedPartnerNumber ? { replaceAssignedPartnerNumber } : {}),
      expectedVersion: Number(read(form, 'expectedVersion')),
      isDefault: ['on', 'true'].includes(String(form.get('isDefault') ?? '').toLowerCase()),
      reason: read(form, 'reason'),
    };
    const result = await saveSupplierPurchasingPartner(input);
    revalidatePath('/foundation/partners');
    return { ok: true, changed: result.changed, version: result.version, isDefault: result.isDefault };
  } catch (error) {
    if (error instanceof SupplierPurchasingPartnerError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function removeSupplierPurchasingPartnerAction(
  _previous: PartnerFunctionActionState,
  form: FormData,
): Promise<PartnerFunctionActionState> {
  const session = await requireSession('/foundation/partners');
  try {
    await requireCapability('PROC.SUPPLIER.PURCHASING.MAINTAIN', session);
    const result = await removeSupplierPurchasingPartner({
      client: session.user.client,
      changedBy: session.user.username,
      partnerNumber: read(form, 'partnerNumber'),
      purchasingOrg: read(form, 'purchasingOrg'),
      functionCode: read(form, 'functionCode') as SupplierPurchasingPartnerInput['functionCode'],
      assignedPartnerNumber: read(form, 'assignedPartnerNumber'),
      expectedVersion: Number(read(form, 'expectedVersion')),
      reason: read(form, 'reason'),
    });
    revalidatePath('/foundation/partners');
    return { ok: true, changed: result.changed, removedVersion: result.removedVersion };
  } catch (error) {
    if (error instanceof SupplierPurchasingPartnerError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

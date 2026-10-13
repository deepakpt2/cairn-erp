'use server';

/** Exact-capability SCR-020 definition actions; Company Code assignment stays in SCR-021. */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  deactivateSalesOrg,
  SalesOrgMaintenanceError,
  saveSalesOrgDefinition,
  type SalesOrgMaintenanceMode,
} from '@/modules/foundation/sales-organization-maintenance';
import { t } from '@/platform/i18n';

const ACTIVITY = 'CFG.ORG.SALESORG.DEFINE';
const ROUTE = '/config/sales-orgs';

export interface SalesOrgMaintenanceActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  salesOrg?: string;
  version?: number;
  changed?: boolean;
  isActive?: boolean;
  addressNumber?: string | null;
}

function read(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}
function expectedVersion(form: FormData) {
  const value = read(form, 'expectedVersion');
  return value === '' ? Number.NaN : Number(value);
}
function revalidateSalesOrgViews() {
  revalidatePath(ROUTE);
  revalidatePath('/config');
}

/** Tenant and actor are always taken from the verified session, never the request. */
export async function saveSalesOrgDefinitionAction(
  _previous: SalesOrgMaintenanceActionState,
  form: FormData,
): Promise<SalesOrgMaintenanceActionState> {
  const session = await requireSession(ROUTE);
  const code = read(form, 'salesOrg').toUpperCase();
  try {
    await requireCapability(ACTIVITY, session);
    const result = await saveSalesOrgDefinition({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') as SalesOrgMaintenanceMode,
      salesOrg: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
      languageKey: session.user.logonLanguage ?? 'E',
      values: {
        name: read(form, 'name'),
        formText: read(form, 'formText'),
        currency: read(form, 'currency').toUpperCase(),
        factoryCalendar: read(form, 'factoryCalendar').toUpperCase(),
        purchasingOrganization: read(form, 'purchasingOrganization').toUpperCase(),
        referenceSalesOrg: read(form, 'referenceSalesOrg').toUpperCase(),
        alePurchaseOrders: form.get('alePurchaseOrders') === 'X',
        rebateProcessingActive: form.get('rebateProcessingActive') === 'X',
        address: {
          country: read(form, 'addressCountry').toUpperCase(),
          searchTerm1: read(form, 'searchTerm1'),
          searchTerm2: read(form, 'searchTerm2'),
          street: read(form, 'street'),
          houseNumber: read(form, 'houseNumber'),
          postalCode: read(form, 'postalCode'),
          city: read(form, 'city'),
          region: read(form, 'region').toUpperCase(),
          poBox: read(form, 'poBox'),
          poBoxPostalCode: read(form, 'poBoxPostalCode'),
          companyPostalCode: read(form, 'companyPostalCode'),
          telephone: read(form, 'telephone'),
          telephoneExtension: read(form, 'telephoneExtension'),
          mobilePhone: read(form, 'mobilePhone'),
          faxNumber: read(form, 'faxNumber'),
          faxExtension: read(form, 'faxExtension'),
          emailAddress: read(form, 'emailAddress'),
        },
        intercompanyBillingCustomer: read(form, 'intercompanyBillingCustomer').toUpperCase(),
        intercompanyBillingVendor: read(form, 'intercompanyBillingVendor'),
      },
    });
    revalidateSalesOrgViews();
    return {
      ok: true,
      message: result.created
        ? t('salesOrg.created', { code: result.salesOrg })
        : result.changed
          ? t('salesOrg.changed', { code: result.salesOrg })
          : t('salesOrg.unchanged', { code: result.salesOrg }),
      salesOrg: result.salesOrg,
      addressNumber: result.addressNumber,
      version: result.version,
      changed: result.changed,
      isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof SalesOrgMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, salesOrg: code };
    }
    throw error;
  }
}

/** Soft deactivation retains the organisation and is refused while sales-area data depends on it. */
export async function deactivateSalesOrgAction(
  _previous: SalesOrgMaintenanceActionState,
  form: FormData,
): Promise<SalesOrgMaintenanceActionState> {
  const session = await requireSession(ROUTE);
  const code = read(form, 'salesOrg').toUpperCase();
  try {
    await requireCapability(ACTIVITY, session);
    if (form.get('confirmDeactivation') !== 'on') {
      return { ok: false, message: t('salesOrg.confirmationRequired'), salesOrg: code };
    }
    const result = await deactivateSalesOrg({
      client: session.user.client,
      changedBy: session.user.username,
      salesOrg: code,
      expectedVersion: expectedVersion(form),
      reason: read(form, 'reason'),
    });
    revalidateSalesOrgViews();
    return {
      ok: true,
      message: result.changed ? t('salesOrg.deactivated', { code: result.salesOrg }) : t('salesOrg.alreadyInactive', { code: result.salesOrg }),
      salesOrg: result.salesOrg,
      version: result.version,
      changed: result.changed,
      isActive: result.isActive,
    };
  } catch (error) {
    if (error instanceof SalesOrgMaintenanceError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy, salesOrg: code };
    }
    throw error;
  }
}

'use server';

import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import {
  PurchasingOrgPlantAssignmentError,
  assignPurchasingOrgPlant,
  checkPurchasingOrgPlant,
  removePurchasingOrgPlant,
} from '@/modules/purchasing/purchasing-org-plant-assignment';

export interface PurchasingOrgPlantActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  purchasingOrg?: string;
  plant?: string;
}

const ACTIVITY = 'CFG.PROC.PURORG.ASSIGN_PLANT';
const ROUTE = '/config/purchasing-orgs/assign-plant';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): PurchasingOrgPlantActionState {
  if (error instanceof PurchasingOrgPlantAssignmentError || error instanceof AuthzError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

async function authorised() {
  const session = await requireSession(ROUTE);
  await requireCapability(ACTIVITY, session);
  return session;
}

export async function assignPurchasingOrgPlantAction(
  _previous: PurchasingOrgPlantActionState,
  form: FormData,
): Promise<PurchasingOrgPlantActionState> {
  try {
    const session = await authorised();
    const result = await assignPurchasingOrgPlant({
      client: session.user.client,
      changedBy: session.user.username,
      purchasingOrg: read(form, 'purchasingOrg'),
      plant: read(form, 'plant'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      companyCode: read(form, 'companyCode'),
      status: read(form, 'status'),
      version: read(form, 'version'),
      postingPeriod: read(form, 'postingPeriod'),
      transportRequest: read(form, 'transportRequest'),
      approval: read(form, 'approval'),
    });
    const verb = result.replayed ? 'already stood' : result.assigned ? 'assigned' : 'already stands';
    return {
      ok: true,
      purchasingOrg: result.purchasingOrg,
      plant: result.plant,
      message: `Purchasing organisation ${result.purchasingOrg} ${verb} for plant ${result.plant}.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function checkPurchasingOrgPlantAction(
  _previous: PurchasingOrgPlantActionState,
  form: FormData,
): Promise<PurchasingOrgPlantActionState> {
  try {
    const session = await authorised();
    const row = await checkPurchasingOrgPlant(session.user.client, read(form, 'purchasingOrg'), read(form, 'plant'));
    const cited = row.citations.purchaseOrders + row.citations.requestsForQuotation + row.citations.sourceList + row.citations.infoRecords + row.citations.quotas;
    return {
      ok: true,
      purchasingOrg: row.purchasingOrg,
      plant: row.plant,
      message: cited > 0
        ? `${row.purchasingOrg} may buy for ${row.plant}. ${cited} procurement line(s) cite the pair. A check writes nothing.`
        : `${row.purchasingOrg} may buy for ${row.plant}. The pair is not yet cited. A check writes nothing.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function removePurchasingOrgPlantAction(
  _previous: PurchasingOrgPlantActionState,
  form: FormData,
): Promise<PurchasingOrgPlantActionState> {
  try {
    const session = await authorised();
    const result = await removePurchasingOrgPlant({
      client: session.user.client,
      changedBy: session.user.username,
      purchasingOrg: read(form, 'purchasingOrg'),
      plant: read(form, 'plant'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
    });
    return {
      ok: true,
      purchasingOrg: result.purchasingOrg,
      plant: result.plant,
      message: result.replayed
        ? `The assignment of ${result.purchasingOrg} to ${result.plant} was already removed.`
        : `Purchasing organisation ${result.purchasingOrg} is no longer assigned to plant ${result.plant}.`,
    };
  } catch (error) {
    return fail(error);
  }
}

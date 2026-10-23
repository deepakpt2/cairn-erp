'use server';

import { revalidatePath } from 'next/cache';

import { requireCapability } from '@/platform/auth/current';
import {
  createSchedulingAgreementReleases,
  RELEASE_CREATE_CAPABILITY,
  RELEASE_ROUTE,
  SchedulingAgreementReleaseError,
  type ReleaseRunResult,
} from '@/modules/purchasing/scheduling-agreement-release';

export interface ReleaseActionState {
  ok: boolean;
  message?: string;
  result?: ReleaseRunResult;
}

export async function createSchedulingReleasesAction(
  _previous: ReleaseActionState,
  formData: FormData,
): Promise<ReleaseActionState> {
  const session = await requireCapability(RELEASE_CREATE_CAPABILITY);
  const payload = String(formData.get('payload') ?? '');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return { ok: false, message: 'The selection could not be read.' };
  }
  const types = Array.isArray(input.releaseTypes) ? input.releaseTypes.filter((value) => value === 'FRC' || value === 'JIT') : [];
  try {
    const result = await createSchedulingAgreementReleases({
      client: session.user.client,
      changedBy: session.user.username,
      agreementFrom: String(input.agreementFrom ?? ''),
      agreementTo: String(input.agreementTo ?? ''),
      supplierNumber: String(input.supplierNumber ?? ''),
      purchasingOrg: String(input.purchasingOrg ?? ''),
      purchasingGroup: String(input.purchasingGroup ?? ''),
      plant: String(input.plant ?? ''),
      itemFrom: input.itemFrom ? Number(input.itemFrom) : undefined,
      itemTo: input.itemTo ? Number(input.itemTo) : undefined,
      releaseTypes: types.length > 0 ? types : ['FRC'],
      generationDate: String(input.generationDate ?? '') || undefined,
      profileCode: String(input.profileCode ?? ''),
      requestKey: String(input.requestKey ?? '') || undefined,
    });
    revalidatePath(RELEASE_ROUTE);
    const created = result.created.filter((row) => !row.reused).length;
    return {
      ok: true,
      result,
      message: `${created} release${created === 1 ? '' : 's'} created. ${result.skipped.length} skipped. ${result.failed.length} failed. Nothing was posted, and the supplier was not notified.`,
    };
  } catch (error) {
    const message = error instanceof SchedulingAgreementReleaseError ? error.message : 'The releases could not be created.';
    return { ok: false, message };
  }
}

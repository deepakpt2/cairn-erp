'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  CONTRACT_MAINTAIN_CAPABILITY,
  PurchaseContractError,
  changePurchaseContract,
  createPurchaseContract,
  type CreateContractInput,
} from '@/modules/purchasing/contract';
import {
  RELEASE_CAPABILITIES,
  ReleaseError,
  cancelDocumentRelease,
  releaseDocument,
} from '@/modules/purchasing/release';

export interface ContractActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  contractNumber?: string;
  warnings?: string[];
}

const ROUTE = '/purchasing/contracts';

export async function saveContractAction(
  _previous: ContractActionState,
  form: FormData,
): Promise<ContractActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, CONTRACT_MAINTAIN_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the purchase-contract maintain capability.' };
  }
  const raw = form.get('payload');
  if (typeof raw !== 'string') return { ok: false, message: 'The contract payload is missing.' };
  let payload: CreateContractInput & { contractNumber?: string };
  try {
    payload = JSON.parse(raw) as CreateContractInput & { contractNumber?: string };
  } catch {
    return { ok: false, message: 'The contract payload is not valid JSON.' };
  }
  const input = {
    ...payload,
    client: session.user.client,
    changedBy: session.user.username,
  };
  try {
    if (payload.contractNumber) {
      await assertChangeForSession(session, {
        lockObject: 'PURCHASE_CONTRACT',
        argument: payload.contractNumber,
      });
      const saved = await changePurchaseContract({ ...input, contractNumber: payload.contractNumber });
      revalidatePath(ROUTE);
      return { ok: true, contractNumber: saved.contractNumber, warnings: saved.warnings, message: `Contract ${saved.contractNumber} was changed. Stock and accounting were not posted.` };
    }
    const saved = await createPurchaseContract(input);
    revalidatePath(ROUTE);
    return { ok: true, contractNumber: saved.contractNumber, warnings: saved.warnings, message: `Contract ${saved.contractNumber} was created. Stock and accounting were not posted.` };
  } catch (error) {
    if (error instanceof PurchaseContractError || error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: 'remedy' in error ? error.remedy : undefined };
    }
    throw error;
  }
}

export async function releaseContractAction(
  _previous: ContractActionState,
  form: FormData,
): Promise<ContractActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.PURCHASE_CONTRACT)) {
    return { ok: false, message: 'You do not hold the purchase-contract release capability.' };
  }
  const number = form.get('contractNumber');
  const code = form.get('releaseCode');
  if (typeof number !== 'string' || typeof code !== 'string') {
    return { ok: false, message: 'A contract number and a release code are required.' };
  }
  try {
    const state = await releaseDocument({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'PURCHASE_CONTRACT',
      documentNumber: number.trim(),
      releaseCode: code.trim(),
    });
    revalidatePath(ROUTE);
    return { ok: true, contractNumber: number.trim(), message: `Contract ${number.trim()} is ${state.status}.` };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

export async function cancelContractReleaseAction(
  _previous: ContractActionState,
  form: FormData,
): Promise<ContractActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RELEASE_CAPABILITIES.PURCHASE_CONTRACT)) {
    return { ok: false, message: 'You do not hold the purchase-contract release capability.' };
  }
  const number = form.get('contractNumber');
  if (typeof number !== 'string') return { ok: false, message: 'A contract number is required.' };
  try {
    await cancelDocumentRelease({
      client: session.user.client,
      changedBy: session.user.username,
      documentCategory: 'PURCHASE_CONTRACT',
      documentNumber: number.trim(),
    });
    revalidatePath(ROUTE);
    return { ok: true, contractNumber: number.trim(), message: `Release of ${number.trim()} was cancelled.` };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

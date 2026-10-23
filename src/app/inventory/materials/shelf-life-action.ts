'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';
import { MaterialShelfLifeError, saveMaterialShelfLife } from '@/modules/inventory/material-shelf-life';

export async function saveMaterialShelfLifeAction(form: FormData): Promise<void> {
  const session = await requireSession('/inventory/materials');
  const read = (name: string) => String(form.get(name) ?? '').trim();
  const number = read('materialNumber').toUpperCase();
  const count = (name: string): number | null => {
    const value = read(name);
    return value === '' ? null : Number(value);
  };
  try {
    await requireCapability('INV.MATERIAL.MAINTAIN', session);
    await saveMaterialShelfLife({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber: number,
      minRemainingShelfLife: count('minRemainingShelfLife'),
      totalShelfLife: count('totalShelfLife'),
      storagePercentage: count('storagePercentage'),
      periodIndicator: read('periodIndicator'),
      reason: read('reason'),
    });
  } catch (error) {
    if (error instanceof MaterialShelfLifeError || error instanceof AuthzError) {
      redirect(`/inventory/materials?material=${encodeURIComponent(number)}&shelfLife=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }
  revalidatePath('/inventory/materials');
  redirect(`/inventory/materials?material=${encodeURIComponent(number)}&shelfLife=saved`);
}

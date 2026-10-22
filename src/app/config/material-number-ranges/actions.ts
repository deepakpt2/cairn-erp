'use server';

import { revalidatePath } from 'next/cache';

import { requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  MaterialRangeGroupError,
  deleteMaterialNumberRangeGroup,
  saveMaterialNumberRangeGroup,
} from '@/modules/inventory/material-number-range-groups';

export interface MaterialRangeGroupActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

const ROUTE = '/config/material-number-ranges';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): MaterialRangeGroupActionState {
  if (error instanceof MaterialRangeGroupError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function saveMaterialRangeGroupAction(
  _previous: MaterialRangeGroupActionState,
  form: FormData,
): Promise<MaterialRangeGroupActionState> {
  const session = await requireSession(ROUTE);
  try {
    if (read(form, 'mode') === 'CHANGE') {
      await assertChangeForSession(session, {
        lockObject: 'MATERIAL_RANGE_GROUP',
        argument: `${read(form, 'internalRangeKey')}/${read(form, 'externalRangeKey')}`,
      });
    }
    const result = await saveMaterialNumberRangeGroup({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      internalRangeKey: read(form, 'internalRangeKey'),
      externalRangeKey: read(form, 'externalRangeKey'),
      description: read(form, 'description'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return result.changed
      ? {
          ok: true,
          message: `Number range group ${result.internalKey}/${result.externalKey} saved.`,
        }
      : {
          ok: true,
          message: `Number range group ${result.internalKey}/${result.externalKey} already holds this description; nothing was changed.`,
        };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteMaterialRangeGroupAction(
  _previous: MaterialRangeGroupActionState,
  form: FormData,
): Promise<MaterialRangeGroupActionState> {
  const session = await requireSession(ROUTE);
  try {
    await assertChangeForSession(session, {
      lockObject: 'MATERIAL_RANGE_GROUP',
      argument: `${read(form, 'internalRangeKey')}/${read(form, 'externalRangeKey')}`,
    });
    const result = await deleteMaterialNumberRangeGroup({
      client: session.user.client,
      changedBy: session.user.username,
      internalRangeKey: read(form, 'internalRangeKey'),
      externalRangeKey: read(form, 'externalRangeKey'),
      reason: read(form, 'reason'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Number range group ${result.internalKey}/${result.externalKey} deleted.`,
    };
  } catch (error) {
    return fail(error);
  }
}

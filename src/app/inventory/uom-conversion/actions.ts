'use server';

/**
 * SCR-144 / INV.STOCK.UOM — maintaining a material's alternative units.
 *
 * The action does no judging of its own beyond presence: the ratio, the unit code and the
 * base-unit rule all belong to `defineUomConversion`, so a screen and a script cannot disagree
 * about what a conversion is. What comes back is the service's own refusal, in its own words.
 */
import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  defineUomConversion,
  listUomConversions,
  removeUomConversion,
  UnitConversionError,
  UOM_CAPABILITY,
} from '@/modules/inventory/unit-conversion';

const UOM_ROUTE = '/inventory/uom-conversion';

export interface UomActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const text = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();

export async function defineConversionAction(
  _previous: UomActionState,
  form: FormData,
): Promise<UomActionState> {
  const session = await requireSession(UOM_ROUTE);
  if (!can(session, UOM_CAPABILITY)) {
    return { ok: false, message: `You do not hold the unit conversion capability (${UOM_CAPABILITY}).` };
  }

  try {
    const materialNumber = text(form, 'materialNumber');
    const alternativeUnit = text(form, 'alternativeUnit').toUpperCase();
    const standing = await listUomConversions(session.user.client, { materialNumber });
    if (standing.some((row) => row.alternativeUnit.toUpperCase() === alternativeUnit)) {
      await assertChangeForSession(session, {
        lockObject: 'UOM_CONVERSION',
        argument: `${materialNumber}/${alternativeUnit}`,
      });
    }
    await defineUomConversion({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber: text(form, 'materialNumber'),
      alternativeUnit: text(form, 'alternativeUnit'),
      numerator: Number(text(form, 'numerator') || '0'),
      denominator: Number(text(form, 'denominator') || '0'),
    });
    revalidatePath(UOM_ROUTE);
    return {
      ok: true,
      message: `1 ${text(form, 'alternativeUnit').toUpperCase()} = ${text(form, 'numerator')}/${text(form, 'denominator')} of material ${text(form, 'materialNumber').toUpperCase()}'s base unit.`,
    };
  } catch (caught) {
    if (caught instanceof EnqueueError) return { ok: false, message: caught.message, remedy: caught.remedy };
    if (caught instanceof UnitConversionError) {
      return { ok: false, message: caught.message, remedy: caught.remedy };
    }
    return { ok: false, message: 'The conversion could not be maintained.' };
  }
}

export interface DeleteConversionState {
  ok: boolean;
  message: string;
}

/** Remove one conversion: a material then accepts only its base unit again. */
export async function deleteConversionAction(
  _previous: DeleteConversionState,
  form: FormData,
): Promise<DeleteConversionState> {
  const session = await requireSession(UOM_ROUTE);
  if (!can(session, UOM_CAPABILITY)) {
    return { ok: false, message: `You do not hold the unit conversion capability (${UOM_CAPABILITY}).` };
  }
  try {
    await assertChangeForSession(session, {
      lockObject: 'UOM_CONVERSION',
      argument: `${text(form, 'materialNumber')}/${text(form, 'alternativeUnit')}`,
    });
    await removeUomConversion({
      client: session.user.client,
      changedBy: session.user.username,
      materialNumber: text(form, 'materialNumber'),
      alternativeUnit: text(form, 'alternativeUnit'),
    });
    revalidatePath(UOM_ROUTE);
    return { ok: true, message: `Conversion ${text(form, 'alternativeUnit')} removed.` };
  } catch (caught) {
    if (caught instanceof EnqueueError) {
      return { ok: false, message: caught.remedy ? `${caught.message} ${caught.remedy}` : caught.message };
    }
    if (caught instanceof UnitConversionError) {
      return { ok: false, message: caught.message };
    }
    return { ok: false, message: 'The conversion could not be removed.' };
  }
}

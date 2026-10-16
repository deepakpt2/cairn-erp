'use server';

/**
 * Capability-protected OB29 actions (SCR-029).
 *
 * One capability guards the registry and its periods, because a period list is not a separate
 * object a consultant maintains elsewhere: it is the second half of the same definition, and
 * splitting the authority would let one role change how many periods a year has and another
 * decide where they end.
 *
 * The tenant and the actor come from the session, never from the form. The period grid posts
 * one set of repeated fields in row order — number, month, day and year shift — and the action
 * zips them by position, so a request cannot pair one period's number with another's end.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  FiscalYearVariantError,
  saveFiscalYearPeriods,
  saveFiscalYearVariant,
  setFiscalYearVariantActive,
} from '@/modules/foundation/fiscal-year-variant-maintenance';

const ROUTE = '/config/fiscal-year-variants';
const ACTIVITY = 'CFG.FIN.FYV.DEFINE';

export interface FiscalYearVariantActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateVariantRoutes() {
  // The variant is read by Company Codes, Controlling Areas and every posting path.
  revalidatePath(ROUTE);
  revalidatePath('/config/company-codes');
  revalidatePath('/config/controlling-area');
  revalidatePath('/config/posting-periods');
  revalidatePath('/config');
}

function mapVariantError(error: unknown): FiscalYearVariantActionState {
  if (error instanceof FiscalYearVariantError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('auth.missingAuthority', { authority: error.capability }),
      remedy: t('auth.readOnly', { authority: error.capability }),
    };
  }
  return {
    ok: false,
    message: t('fiscalYearVariant.unexpected'),
    remedy: t('fiscalYearVariant.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();
const readNumber = (form: FormData, field: string) => Number(read(form, field));
const readFlag = (form: FormData, field: string) => form.get(field) === 'on';

export async function saveFiscalYearVariantAction(
  _previous: FiscalYearVariantActionState,
  form: FormData,
): Promise<FiscalYearVariantActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    const result = await saveFiscalYearVariant({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      expectedVersion: readNumber(form, 'expectedVersion'),
      variant: read(form, 'variant'),
      name: read(form, 'name'),
      isCalendarYear: readFlag(form, 'isCalendarYear'),
      regularPeriods: readNumber(form, 'regularPeriods'),
      specialPeriods: readNumber(form, 'specialPeriods'),
      isYearDependent: readFlag(form, 'isYearDependent'),
      reason: read(form, 'reason'),
    });

    revalidateVariantRoutes();

    if (result.mode === 'UNCHANGED') {
      return { ok: true, message: t('fiscalYearVariant.unchanged', { variant: result.variant }) };
    }
    return {
      ok: true,
      message:
        result.mode === 'CREATED'
          ? t('fiscalYearVariant.created', {
              variant: result.variant,
              periods: String(result.periodsWritten),
            })
          : t('fiscalYearVariant.changed', {
              variant: result.variant,
              version: String(result.version),
              periods: String(result.periodsWritten),
            }),
    };
  } catch (error) {
    return mapVariantError(error);
  }
}

export async function setFiscalYearVariantActiveAction(
  _previous: FiscalYearVariantActionState,
  form: FormData,
): Promise<FiscalYearVariantActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);
    const result = await setFiscalYearVariantActive({
      client: session.user.client,
      changedBy: session.user.username,
      variant: read(form, 'variant'),
      isActive: read(form, 'isActive') === 'true',
      expectedVersion: readNumber(form, 'expectedVersion'),
      reason: read(form, 'reason'),
    });

    revalidateVariantRoutes();

    if (!result.changed) {
      return { ok: true, message: t('fiscalYearVariant.lifecycleUnchanged', { variant: result.variant }) };
    }
    return {
      ok: true,
      message: result.isActive
        ? t('fiscalYearVariant.reactivated', { variant: result.variant })
        : t('fiscalYearVariant.deactivatedMessage', { variant: result.variant }),
    };
  } catch (error) {
    return mapVariantError(error);
  }
}

export async function saveFiscalYearPeriodsAction(
  _previous: FiscalYearVariantActionState,
  form: FormData,
): Promise<FiscalYearVariantActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);

    // Repeated fields arrive in row order, so the grid cannot pair one period's number with
    // another period's end.
    const numbers = form.getAll('periodNumber').map((value) => Number(String(value)));
    const months = form.getAll('periodMonth').map((value) => Number(String(value)));
    const days = form.getAll('periodDay').map((value) => Number(String(value)));
    const shifts = form.getAll('periodYearShift').map((value) => Number(String(value)));
    if (
      numbers.length === 0 ||
      months.length !== numbers.length ||
      days.length !== numbers.length ||
      shifts.length !== numbers.length
    ) {
      return {
        ok: false,
        message: t('fiscalYearVariant.periodGridIncomplete'),
        remedy: t('fiscalYearVariant.periodGridIncompleteRemedy'),
      };
    }

    const result = await saveFiscalYearPeriods({
      client: session.user.client,
      changedBy: session.user.username,
      variant: read(form, 'variant'),
      calendarYear: readNumber(form, 'calendarYear'),
      expectedVersion: readNumber(form, 'expectedVersion'),
      reason: read(form, 'reason'),
      periods: numbers.map((period, index) => ({
        period,
        month: months[index]!,
        day: days[index]!,
        yearShift: shifts[index]!,
      })),
    });

    revalidateVariantRoutes();

    // A list that was already stored exactly as submitted is not a change, and saying "saved"
    // would tell the operator a version moved when it did not.
    if (result.unchanged) {
      return {
        ok: true,
        message: t('fiscalYearVariant.periodsUnchanged', {
          variant: result.variant,
          year: result.calendarYear === 0
            ? t('fiscalYearVariant.everyYear')
            : String(result.calendarYear),
        }),
      };
    }

    return {
      ok: true,
      message: t('fiscalYearVariant.periodsSaved', {
        variant: result.variant,
        count: String(result.periods),
        year: result.calendarYear === 0 ? t('fiscalYearVariant.everyYear') : String(result.calendarYear),
        version: String(result.version),
      }),
    };
  } catch (error) {
    return mapVariantError(error);
  }
}

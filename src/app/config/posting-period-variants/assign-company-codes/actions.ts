'use server';

/**
 * Capability-protected OBBP assignment action (SCR-033).
 *
 * Two authorities, because the write touches two things: the assignment's own activity, and the
 * one that owns the record being changed — the same pair OB37 asks for. The tenant and the
 * actor come from the session, never from the form. `expectedVariant` does come from the form,
 * and that is the point: it is what the operator was looking at, so a request that was already
 * stale when it arrived is refused instead of overwriting somebody else's assignment.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  PostingPeriodVariantAssignmentError,
  assignPostingPeriodVariant,
} from '@/modules/foundation/posting-period-variant-assignment';

const ROUTE = '/config/posting-period-variants/assign-company-codes';
const COMPANY_CODE_DEFINE = 'CFG.ORG.COMPANYCODE.DEFINE';

export interface PpvAssignmentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateAssignmentRoutes() {
  // The variant decides which periods are open, so every screen that reads a Company Code or a
  // period has to be re-read rather than shown from cache.
  revalidatePath(ROUTE);
  revalidatePath('/config/company-codes');
  revalidatePath('/config/posting-period-variants');
  revalidatePath('/config/posting-periods');
  revalidatePath('/config');
}

function mapAssignmentError(error: unknown): PpvAssignmentActionState {
  if (error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof PostingPeriodVariantAssignmentError) {
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
    message: t('ppvAssign.unexpected'),
    remedy: t('ppvAssign.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

export async function assignPostingPeriodVariantAction(
  _previous: PpvAssignmentActionState,
  form: FormData,
): Promise<PpvAssignmentActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);
    await requireCapability(COMPANY_CODE_DEFINE, session);
    await assertChangeForSession(session, { lockObject: 'PPV_COMPANY', argument: read(form, 'companyCode') });

    const result = await assignPostingPeriodVariant({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: read(form, 'companyCode'),
      postingPeriodVariant: read(form, 'postingPeriodVariant'),
      expectedVariant: read(form, 'expectedVariant'),
      reason: read(form, 'reason'),
    });

    revalidateAssignmentRoutes();

    if (!result.assigned) {
      return {
        ok: true,
        message: result.postingPeriodVariant === null
          ? t('ppvAssign.unchangedUnassigned', { companyCode: result.companyCode })
          : t('ppvAssign.unchangedVariant', {
              companyCode: result.companyCode,
              variant: result.postingPeriodVariant,
            }),
      };
    }

    if (result.postingPeriodVariant === null) {
      return {
        ok: true,
        message: t('ppvAssign.cleared', {
          companyCode: result.companyCode,
          from: result.previousVariant ?? '',
        }),
      };
    }

    return {
      ok: true,
      message: t('ppvAssign.assigned', {
        companyCode: result.companyCode,
        to: result.postingPeriodVariant,
        from: result.previousVariant ?? t('cc.unassigned'),
      }),
    };
  } catch (error) {
    return mapAssignmentError(error);
  }
}

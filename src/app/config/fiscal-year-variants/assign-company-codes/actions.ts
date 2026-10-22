'use server';

/**
 * Capability-protected OB37 assignment action (SCR-030).
 *
 * Two authorities, because the write touches two things: the assignment's own activity, and the
 * one that owns the record being changed. OX19 asks for the same pair, and an action that asked
 * for only its own would let a role change a Company Code it has no other business touching.
 *
 * The tenant and the actor come from the session, never from the form. `expectedVariant` does
 * come from the form, and that is the point: it is what the operator was looking at, so a
 * request that was already stale when it arrived is refused instead of overwriting somebody
 * else's assignment.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { t } from '@/platform/i18n';
import {
  FiscalYearVariantAssignmentError,
  assignFiscalYearVariant,
} from '@/modules/foundation/fiscal-year-variant-assignment';

const ROUTE = '/config/fiscal-year-variants/assign-company-codes';
const ACTIVITY = 'CFG.FIN.FYV.ASSIGN';
const COMPANY_CODE_DEFINE = 'CFG.ORG.COMPANYCODE.DEFINE';

export interface FyvAssignmentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateAssignmentRoutes() {
  // The variant decides which period a document lands in, so every screen that reads a Company
  // Code or a period has to be re-read rather than shown from cache.
  revalidatePath(ROUTE);
  revalidatePath('/config/company-codes');
  revalidatePath('/config/fiscal-year-variants');
  revalidatePath('/config/controlling-area');
  revalidatePath('/config/posting-periods');
  revalidatePath('/config');
}

function mapAssignmentError(error: unknown): FyvAssignmentActionState {
  if (error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof FiscalYearVariantAssignmentError) {
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
    message: t('fyvAssignment.unexpected'),
    remedy: t('fyvAssignment.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

export async function assignFiscalYearVariantAction(
  _previous: FyvAssignmentActionState,
  form: FormData,
): Promise<FyvAssignmentActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);
    await requireCapability(COMPANY_CODE_DEFINE, session);
    await assertChangeForSession(session, { lockObject: 'FYV_COMPANY', argument: read(form, 'companyCode') });

    const result = await assignFiscalYearVariant({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: read(form, 'companyCode'),
      fiscalYearVariant: read(form, 'fiscalYearVariant'),
      expectedVariant: read(form, 'expectedVariant'),
      reason: read(form, 'reason'),
    });

    revalidateAssignmentRoutes();

    if (!result.assigned) {
      return {
        ok: true,
        message: t('fyvAssignment.alreadyPostedIn', {
          companyCode: result.companyCode,
          variant: result.fiscalYearVariant,
        }),
      };
    }

    return {
      ok: true,
      message: t('fyvAssignment.assigned', {
        companyCode: result.companyCode,
        to: result.fiscalYearVariant,
        from: result.previousVariant ?? t('fyvAssignment.unassigned'),
      }),
      // The exposure the reason had to cover, said back to the operator rather than only filed.
      remedy: result.postedDocuments > 0
        ? t('fyvAssignment.postingsRecorded', {
            count: String(result.postedDocuments),
            years: result.firstPostedYear === result.lastPostedYear
              ? String(result.firstPostedYear)
              : `${result.firstPostedYear ?? ''}–${result.lastPostedYear ?? ''}`,
          })
        : undefined,
    };
  } catch (error) {
    return mapAssignmentError(error);
  }
}

'use server';

/**
 * Capability-protected OBY7 actions (SCR-027).
 *
 * One capability guards the copy: `CFG.FIN.COA.COPY`. Reading the screen needs nothing
 * beyond a session, so an operator without the authority sees the choices and the refusals
 * they would cause, but cannot execute — the same split FS00 makes between Display and
 * Change. The tenant and the actor come from the session, never from the form, so a
 * hand-built request cannot copy into another tenant or attribute the copy to someone else.
 *
 * The options are read from the posted form because they are the operator's decision, but
 * every consequence of them is recomputed server-side: the length rule, the padding, the
 * Account Group prerequisite and the overwrite guard all live in the service, so a request
 * that posts `padLeadingZeros` against a narrower target chart is still refused.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ConfigError } from '@/modules/foundation/services';
import { copyChartOfAccounts } from '@/modules/finance/chart-of-accounts-copy';

const ROUTE = '/config/chart-of-accounts/copy';
const ACTIVITY = 'CFG.FIN.COA.COPY';

export interface CopyChartActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  /** Extra sentences the confirmation adds: padding, dropped fields, the document key. */
  details?: string[];
}

function revalidateCopyRoutes() {
  // The copy writes accounts, so every screen that lists them or the charts is stale.
  revalidatePath(ROUTE);
  revalidatePath('/config/chart-of-accounts');
  revalidatePath('/config/gl-accounts');
  revalidatePath('/config');
}

function mapCopyError(error: unknown): CopyChartActionState {
  if (error instanceof ConfigError) {
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
    message: t('chartCopy.unexpected'),
    remedy: t('chartCopy.unexpectedRemedy'),
  };
}

export async function copyChart(
  _previous: CopyChartActionState | null,
  formData: FormData,
): Promise<CopyChartActionState> {
  const session = await requireSession(ROUTE);
  try {
    await requireCapability(ACTIVITY, session);

    const result = await copyChartOfAccounts({
      client: session.user.client,
      sourceChartOfAccounts: String(formData.get('sourceChartOfAccounts') ?? ''),
      targetChartOfAccounts: String(formData.get('targetChartOfAccounts') ?? ''),
      // Unchecked boxes post nothing at all, so absence means false rather than a parse.
      copyLongTexts: formData.get('copyLongTexts') === 'on',
      overwriteExisting: formData.get('overwriteExisting') === 'on',
      padLeadingZeros: formData.get('padLeadingZeros') === 'on',
      reason: String(formData.get('reason') ?? ''),
      changedBy: session.user.username,
    });

    revalidateCopyRoutes();

    const details: string[] = [];
    if (result.padded) {
      details.push(t('chartCopy.paddedNote', {
        target: result.targetChartOfAccounts,
      }));
    }
    if (result.droppedFields.length > 0) {
      details.push(t('chartCopy.droppedNote', { fields: result.droppedFields.join(', ') }));
    }
    details.push(t('chartCopy.documentNote', {
      key: `${result.sourceChartOfAccounts}->${result.targetChartOfAccounts}`,
    }));

    return {
      ok: true,
      message: t('chartCopy.copied', {
        source: result.sourceChartOfAccounts,
        target: result.targetChartOfAccounts,
        total: String(result.created + result.overwritten + result.unchanged),
        created: String(result.created),
        overwritten: String(result.overwritten),
        unchanged: String(result.unchanged),
      }),
      details,
    };
  } catch (error) {
    return mapCopyError(error);
  }
}

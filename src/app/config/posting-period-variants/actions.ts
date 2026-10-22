'use server';

/**
 * Capability-protected OBBO actions (SCR-031).
 *
 * One authority, because one registry is written. Unlike the fiscal year variant assignment,
 * nothing here changes a record somebody else owns: a variant is defined, described and
 * deleted within its own table pair, and the Company Codes that point at one are refused
 * rather than touched.
 *
 * The tenant and the actor come from the session, never from the form. The mode does come
 * from the form, and that is deliberate: New Entries and editing a row are different acts
 * with different refusals, and a service that guessed between them would turn a mistyped key
 * into somebody else's description change.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  PostingPeriodVariantError,
  deletePostingPeriodVariant,
  savePostingPeriodVariant,
} from '@/modules/foundation/posting-period-variant-definition';

const ROUTE = '/config/posting-period-variants';
const ACTIVITY = 'CFG.FIN.PPV.DEFINE';

export interface PostingPeriodVariantActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateVariantRoutes() {
  // Defining a variant completes a workbench activity, and the control screen reads the
  // variant its Company Code posts against. Both are re-read rather than shown from cache.
  revalidatePath(ROUTE);
  revalidatePath('/config/posting-periods');
  revalidatePath('/config');
}

function mapVariantError(error: unknown): PostingPeriodVariantActionState {
  if (error instanceof PostingPeriodVariantError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('auth.missingAuthority', { authority: error.capability }),
      remedy: t('auth.readOnly', { authority: error.capability }),
    };
  }
  return {
    ok: false,
    message: t('ppv.unexpected'),
    remedy: t('ppv.unexpectedRemedy'),
  };
}

/**
 * `redirect()` throws to unwind, and the catch below would otherwise turn that control flow
 * into an error message — the classic way a redirect gets swallowed. Next marks it with a
 * `NEXT_REDIRECT` digest rather than a type that can be imported stably.
 */
function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown })?.digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

/** Define a posting period variant, or change the description of one that exists. */
export async function savePostingPeriodVariantAction(
  _previous: PostingPeriodVariantActionState,
  form: FormData,
): Promise<PostingPeriodVariantActionState> {
  // Kept outside the try, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);
  const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';

  try {
    await requireCapability(ACTIVITY, session);
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'POSTING_PERIOD_VARIANT', argument: read(form, 'variant') });
    }

    const result = await savePostingPeriodVariant({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      variant: read(form, 'variant'),
      name: read(form, 'name'),
    });

    revalidateVariantRoutes();

    if (result.mode === 'CREATED') {
      return {
        ok: true,
        message: t('ppv.created', {
          variant: result.variant,
          intervals: String(result.intervalsCreated),
        }),
        // The consequence of the ruling that a variant is born usable: it is also born open.
        remedy: t('ppv.createdNote'),
      };
    }
    if (result.mode === 'UNCHANGED') {
      return { ok: true, message: t('ppv.unchanged', { variant: result.variant }) };
    }
    return { ok: true, message: t('ppv.descriptionSaved', { variant: result.variant }) };
  } catch (error) {
    return mapVariantError(error);
  }
}

/**
 * Delete a posting period variant with the intervals it owns.
 *
 * The confirmation cannot be rendered into the dialog that asked for it: the dialog lives in
 * the row the deletion removes. So it confirms through the registry's own banner instead, the
 * way the G/L account deletion does.
 */
export async function deletePostingPeriodVariantAction(
  _previous: PostingPeriodVariantActionState,
  form: FormData,
): Promise<PostingPeriodVariantActionState> {
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);
    await assertChangeForSession(session, { lockObject: 'POSTING_PERIOD_VARIANT', argument: read(form, 'variant') });

    const result = await deletePostingPeriodVariant({
      client: session.user.client,
      changedBy: session.user.username,
      variant: read(form, 'variant'),
    });

    revalidateVariantRoutes();
    redirect(
      `${ROUTE}?deleted=${encodeURIComponent(result.variant)}` +
        `&intervals=${encodeURIComponent(String(result.intervalsRemoved))}`,
    );
  } catch (error) {
    if (isRedirect(error)) throw error;
    return mapVariantError(error);
  }
}

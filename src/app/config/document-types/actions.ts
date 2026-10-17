'use server';

/**
 * Capability-protected OBA7 definition actions (SCR-038).
 *
 * The tenant and the actor come from the session, never from the form. The
 * interval arrives as one "OBJECT|SUB" choice, because the form offers the
 * intervals that are defined as one list; the service still receives the
 * object and the interval separately, the way it stores and validates them.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  DocumentTypeError,
  deleteDocumentType,
  saveDocumentType,
  setDocumentTypeActive,
} from '@/modules/foundation/document-type-definition';

const ROUTE = '/config/document-types';

export interface DocumentTypeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateDocTypeRoutes() {
  revalidatePath(ROUTE);
  revalidatePath('/config/number-ranges');
  revalidatePath('/config');
}

function mapDocTypeError(error: unknown): DocumentTypeActionState {
  if (error instanceof DocumentTypeError) {
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
    message: t('docType.unexpected'),
    remedy: t('docType.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

/** The interval choice arrives as one "OBJECT|SUB" string; stored as two. */
function readInterval(form: FormData): { numberRangeObject: string; numberRangeSubObject: string } {
  const [numberRangeObject = '', ...rest] = read(form, 'interval').split('|');
  return { numberRangeObject, numberRangeSubObject: rest.join('|') };
}

export async function saveDocumentTypeAction(
  _previous: DocumentTypeActionState,
  form: FormData,
): Promise<DocumentTypeActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    const result = await saveDocumentType({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      documentType: read(form, 'documentType'),
      name: read(form, 'name'),
      ...readInterval(form),
      allowedAccountTypes: form.getAll('accountTypes').map((value) => String(value)) as Array<'A' | 'D' | 'K' | 'M' | 'S'>,
      reversalMode: read(form, 'reversalMode') as 'REVERSE_AND_ALT_DATE' | 'REVERSE_ONLY' | 'NO_REVERSE',
      reversalDocumentType: read(form, 'reversalDocumentType'),
      requiresReference: form.get('requiresReference') === 'on',
      requiresLineText: form.get('requiresLineText') === 'on',
      reason: read(form, 'reason'),
    });

    revalidateDocTypeRoutes();

    if (mode === 'CREATE') {
      return { ok: true, message: t('docType.created', { code: result.documentType }) };
    }
    if (!result.changed) {
      return { ok: true, message: t('docType.unchanged', { code: result.documentType }) };
    }
    return {
      ok: true,
      message: t('docType.changed', { code: result.documentType }),
      remedy: result.usedByEntries > 0
        ? t('docType.changeUsedNote', { count: String(result.usedByEntries) })
        : undefined,
    };
  } catch (error) {
    return mapDocTypeError(error);
  }
}

export async function setDocumentTypeActiveAction(
  _previous: DocumentTypeActionState,
  form: FormData,
): Promise<DocumentTypeActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const active = read(form, 'active') === 'true';
    const result = await setDocumentTypeActive({
      client: session.user.client,
      changedBy: session.user.username,
      documentType: read(form, 'documentType'),
      active,
      reason: read(form, 'reason'),
    });

    revalidateDocTypeRoutes();

    if (!result.changed) {
      return { ok: true, message: t('docType.unchanged', { code: result.documentType }) };
    }
    return {
      ok: true,
      message: t(active ? 'docType.reactivated' : 'docType.deactivated', { code: result.documentType }),
    };
  } catch (error) {
    return mapDocTypeError(error);
  }
}

export async function deleteDocumentTypeAction(
  _previous: DocumentTypeActionState,
  form: FormData,
): Promise<DocumentTypeActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const code = read(form, 'documentType');
    await deleteDocumentType({
      client: session.user.client,
      changedBy: session.user.username,
      documentType: code,
      reason: read(form, 'reason'),
    });

    revalidateDocTypeRoutes();

    return { ok: true, message: t('docType.deleted', { code }) };
  } catch (error) {
    return mapDocTypeError(error);
  }
}

'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  DOCUMENT_LAYOUT_CAPABILITY,
  DOCUMENT_LAYOUT_ROUTE,
  DocumentLayoutError,
  removeLogo,
  saveDocumentLayout,
} from '@/modules/output/document-layout';

export interface DocumentLayoutActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function refuse(error: unknown): DocumentLayoutActionState {
  if (error instanceof DocumentLayoutError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

async function authorised() {
  const session = await requireSession(DOCUMENT_LAYOUT_ROUTE);
  if (!can(session, DOCUMENT_LAYOUT_CAPABILITY)) {
    return {
      session,
      denied: {
        ok: false,
        message: `The document layout needs ${DOCUMENT_LAYOUT_CAPABILITY}, which this session does not hold.`,
        remedy: `Ask an administrator to grant ${DOCUMENT_LAYOUT_CAPABILITY} to one of your roles.`,
      } satisfies DocumentLayoutActionState,
    };
  }
  return { session, denied: null };
}

/** FormData names, exactly: companyCode, displayName, addressOverride, headerText, footerText, logo (file), removeLogo, showPageNumbers. */
export async function saveDocumentLayoutAction(_previous: DocumentLayoutActionState, form: FormData): Promise<DocumentLayoutActionState> {
  const { session, denied } = await authorised();
  if (denied) return denied;
  try {
    const file = form.get('logo');
    const logo = file instanceof File && file.size > 0
      ? { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name }
      : null;
    await saveDocumentLayout({
      client: session.user.client,
      companyCode: text(form, 'companyCode').trim(),
      changedBy: session.user.username,
      displayName: text(form, 'displayName'),
      addressOverride: text(form, 'addressOverride'),
      headerText: text(form, 'headerText'),
      footerText: text(form, 'footerText'),
      logo,
      removeLogo: text(form, 'removeLogo') === '1',
      showPageNumbers: text(form, 'showPageNumbers') === '1',
    }, session.user.capabilities);
    revalidatePath(DOCUMENT_LAYOUT_ROUTE);
    return { ok: true, message: 'The document layout was saved.' };
  } catch (error) {
    return refuse(error);
  }
}

export async function removeLogoAction(_previous: DocumentLayoutActionState, form: FormData): Promise<DocumentLayoutActionState> {
  const { session, denied } = await authorised();
  if (denied) return denied;
  try {
    await removeLogo({
      client: session.user.client,
      companyCode: text(form, 'companyCode').trim(),
      changedBy: session.user.username,
    }, session.user.capabilities);
    revalidatePath(DOCUMENT_LAYOUT_ROUTE);
    return { ok: true, message: 'The logo was removed; the texts were left as they were.' };
  } catch (error) {
    return refuse(error);
  }
}

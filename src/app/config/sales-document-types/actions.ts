'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  DOCUMENT_TYPE_DEFINE_CAPABILITY,
  SalesDocumentTypeError,
  changeSalesDocumentType,
  defineSalesDocumentType,
  setSalesDocumentTypeActive,
} from '@/modules/sales/document-type-maintenance';

export interface DocumentTypeActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/config/sales-document-types';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function refuse(error: unknown): DocumentTypeActionState {
  if (error instanceof SalesDocumentTypeError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function denied(): DocumentTypeActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${DOCUMENT_TYPE_DEFINE_CAPABILITY}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/**
 * Define a type that does not stand yet. The gate precedes the call, as it does on every document
 * screen: maintaining what a document *is* is a configuration act, not a sales one.
 */
export async function defineDocumentTypeAction(
  _previous: DocumentTypeActionState,
  form: FormData,
): Promise<DocumentTypeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DOCUMENT_TYPE_DEFINE_CAPABILITY)) return denied();

  try {
    const { documentType } = await defineSalesDocumentType({
      client: session.user.client,
      changedBy: session.user.username,
      documentType: text(form, 'documentType'),
      name: text(form, 'name'),
      numberRangeObject: text(form, 'numberRangeObject'),
      numberRangeSubObject: text(form, 'numberRangeSubObject'),
      cancellationDocumentType: text(form, 'cancellationDocumentType') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Document type ${documentType} now stands for this tenant.` };
  } catch (error) {
    return refuse(error);
  }
}

/** Redefine a type that stands: the name a screen shows, and what a document of it cancels into. */
export async function changeDocumentTypeAction(
  _previous: DocumentTypeActionState,
  form: FormData,
): Promise<DocumentTypeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DOCUMENT_TYPE_DEFINE_CAPABILITY)) return denied();

  try {
    const { documentType } = await changeSalesDocumentType({
      client: session.user.client,
      changedBy: session.user.username,
      documentType: text(form, 'documentType'),
      name: text(form, 'name'),
      cancellationDocumentType: text(form, 'cancellationDocumentType') || null,
      // Blank clears it: a tenant that stops billing a customer by list says so here, and the documents
      // already waiting stay waiting — relevance is a fact of the day each one was billed.
      invoiceListType: text(form, 'invoiceListType') || null,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Document type ${documentType} now reads as configured.` };
  } catch (error) {
    return refuse(error);
  }
}

/**
 * Activate or deactivate a type. Deactivating does not undo history: documents already created keep the
 * type they were created with, and the type is simply no longer offered to a document about to be
 * created — which is why there is no delete button on this screen.
 */
export async function setDocumentTypeActiveAction(
  _previous: DocumentTypeActionState,
  form: FormData,
): Promise<DocumentTypeActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, DOCUMENT_TYPE_DEFINE_CAPABILITY)) return denied();

  try {
    const result = await setSalesDocumentTypeActive({
      client: session.user.client,
      changedBy: session.user.username,
      documentType: text(form, 'documentType'),
      isActive: text(form, 'isActive') === 'true',
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: result.isActive
        ? `Document type ${result.documentType} may be used again. ${result.documentsStanding} document(s) stand under it.`
        : `Document type ${result.documentType} is no longer offered. ${result.documentsStanding} document(s) stand under it and keep reading it.`,
    };
  } catch (error) {
    return refuse(error);
  }
}

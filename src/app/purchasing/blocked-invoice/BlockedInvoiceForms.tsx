'use client';

import { useActionState, useState, type ReactNode } from 'react';

import {
  blockedInvoiceIdle,
  checkBlockedInvoiceAction,
  placeBlockedInvoiceAction,
  releaseBlockedInvoiceAction,
  type BlockedInvoiceActionState,
} from './actions';

function Notice({ state }: { state: BlockedInvoiceActionState }) {
  if (!state.message) return null;
  return (
    <p
      className={state.ok ? 'text-sm text-ink' : 'text-sm text-red-700'}
      role={state.ok ? 'status' : 'alert'}
      data-blocked-invoice-notice
      data-blocked-invoice-nothing-written={state.wrote === true ? undefined : 'true'}
    >
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

export function PlaceHoldForm({ invoiceNumber, invoiceLabel, commentLabel, checkLabel, placeLabel, checkingLabel, placingLabel, selection }: {
  invoiceNumber: string;
  invoiceLabel: string;
  commentLabel: string;
  checkLabel: string;
  placeLabel: string;
  checkingLabel: string;
  placingLabel: string;
  selection: Record<string, string>;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [checkState, checkAction, checking] = useActionState(checkBlockedInvoiceAction, blockedInvoiceIdle);
  const [placeState, placeAction, placing] = useActionState(placeBlockedInvoiceAction, blockedInvoiceIdle);
  const notice = placeState.message ? placeState : checkState;
  return (
    <form className="space-y-2">
      <input type="hidden" name="intent" value="place" />
      <input type="hidden" name="requestKey" value={key} />
      {Object.entries(selection).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={invoiceLabel}>
          <input name="invoiceNumber" className="input w-full" defaultValue={invoiceNumber} required maxLength={20} />
        </Field>
        <Field label={commentLabel}>
          <input name="comment" className="input w-full" required maxLength={100} />
        </Field>
        <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={checking || placing} data-blocked-invoice-place-check>{checking ? checkingLabel : checkLabel}</button>
        <button type="submit" formAction={placeAction} className="btn btn-primary min-h-11 sm:min-h-8" disabled={checking || placing} data-blocked-invoice-place-save>{placing ? placingLabel : placeLabel}</button>
      </div>
      <Notice state={notice} />
    </form>
  );
}

export function ReleaseHoldForm({ invoiceNumber, version, commentLabel, checkLabel, releaseLabel, checkingLabel, releasingLabel, selection }: {
  invoiceNumber: string;
  version: number;
  commentLabel: string;
  checkLabel: string;
  releaseLabel: string;
  checkingLabel: string;
  releasingLabel: string;
  selection: Record<string, string>;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [checkState, checkAction, checking] = useActionState(checkBlockedInvoiceAction, blockedInvoiceIdle);
  const [releaseState, releaseAction, releasing] = useActionState(releaseBlockedInvoiceAction, blockedInvoiceIdle);
  const notice = releaseState.message ? releaseState : checkState;
  return (
    <form className="space-y-2">
      <input type="hidden" name="intent" value="release" />
      <input type="hidden" name="invoiceNumber" value={invoiceNumber} />
      <input type="hidden" name="expectedVersion" value={String(version)} />
      <input type="hidden" name="requestKey" value={key} />
      {Object.entries(selection).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <div className="flex flex-wrap items-end gap-2">
        <input name="comment" className="input min-w-48 flex-1" required maxLength={100} aria-label={commentLabel} placeholder={commentLabel} />
        <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={checking || releasing} data-blocked-invoice-release-check>{checking ? checkingLabel : checkLabel}</button>
        <button type="submit" formAction={releaseAction} className="btn btn-primary min-h-11 sm:min-h-8" disabled={checking || releasing} data-blocked-invoice-release-save>{releasing ? releasingLabel : releaseLabel}</button>
      </div>
      <Notice state={notice} />
    </form>
  );
}

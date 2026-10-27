'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState, type ReactNode } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import {
  checkBlockedInvoiceAction,
  placeBlockedInvoiceAction,
  releaseBlockedInvoiceAction,
  type BlockedInvoiceActionState,
} from './actions';

const blockedInvoiceIdle: BlockedInvoiceActionState = { ok: false, message: '' };
const ROUTE = '/purchasing/blocked-invoice';

function useRemember(state: BlockedInvoiceActionState) {
  const router = useRouter();
  useEffect(() => {
    if (!state.ok || !state.invoiceNumber) return;
    const params = new URLSearchParams(window.location.search);
    params.set('invoiceNumber', state.invoiceNumber);
    params.set('notice', state.message);
    router.replace(`${ROUTE}?${params.toString()}`);
  }, [router, state.ok, state.invoiceNumber, state.message]);
}

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
  const [key, setKey] = useState('');
  const [invoice, setInvoice] = useState(invoiceNumber);
  const [comment, setComment] = useState('');
  useEffect(() => { setKey(crypto.randomUUID()); }, []);
  const [checkState, checkAction, checking] = useActionState(checkBlockedInvoiceAction, blockedInvoiceIdle);
  const [placeState, placeAction, placing] = useActionState(placeBlockedInvoiceAction, blockedInvoiceIdle);
  const lock = useChangeLock('SUPPLIER_INVOICE', invoice.trim() || null, 'PROC.INV.BLOCK', Boolean(invoice.trim()));
  const held = lock?.mode === 'CHANGE';
  useRemember(placeState);
  const notice = placeState.message ? placeState : checkState;
  return (
    <form className="space-y-2">
      <input type="hidden" name="intent" value="place" />
      <input type="hidden" name="requestKey" value={key} />
      {Object.entries(selection).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={invoiceLabel}>
          <input name="invoiceNumber" className="input w-full" value={invoice} onChange={(event) => setInvoice(event.target.value)} required maxLength={20} />
        </Field>
        <Field label={commentLabel}>
          <input name="comment" className="input w-full" value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={100} />
        </Field>
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
        <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!key || checking || placing} data-blocked-invoice-place-check>{checking ? checkingLabel : checkLabel}</button>
        <button type="submit" formAction={placeAction} className="btn btn-primary min-h-11 sm:min-h-8" disabled={!key || checking || placing || !held} data-blocked-invoice-place-save>{placing ? placingLabel : placeLabel}</button>
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
  const [key, setKey] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => { setKey(crypto.randomUUID()); }, []);
  const [checkState, checkAction, checking] = useActionState(checkBlockedInvoiceAction, blockedInvoiceIdle);
  const [releaseState, releaseAction, releasing] = useActionState(releaseBlockedInvoiceAction, blockedInvoiceIdle);
  const lock = useChangeLock('SUPPLIER_INVOICE', invoiceNumber.trim(), 'PROC.INV.BLOCK.RELEASE', Boolean(comment.trim()));
  const held = lock?.mode === 'CHANGE';
  useRemember(releaseState);
  const notice = releaseState.message ? releaseState : checkState;
  return (
    <form className="space-y-2">
      <input type="hidden" name="intent" value="release" />
      <input type="hidden" name="invoiceNumber" value={invoiceNumber} />
      <input type="hidden" name="expectedVersion" value={String(version)} />
      <input type="hidden" name="requestKey" value={key} />
      {Object.entries(selection).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <div className="flex flex-wrap items-end gap-2">
        <input name="comment" className="input min-w-48 flex-1" value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={100} aria-label={commentLabel} placeholder={commentLabel} />
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
        <button type="submit" formAction={checkAction} className="btn btn-default min-h-11 sm:min-h-8" disabled={!key || checking || releasing} data-blocked-invoice-release-check>{checking ? checkingLabel : checkLabel}</button>
        <button type="submit" formAction={releaseAction} className="btn btn-primary min-h-11 sm:min-h-8" disabled={!key || checking || releasing || !held} data-blocked-invoice-release-save>{releasing ? releasingLabel : releaseLabel}</button>
      </div>
      <Notice state={notice} />
    </form>
  );
}

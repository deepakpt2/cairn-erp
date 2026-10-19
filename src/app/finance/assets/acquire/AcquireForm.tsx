'use client';

import { useActionState, useState, type ChangeEvent } from 'react';

import type { AcquisitionPreview } from '@/modules/finance/asset-acquisition';
import {
  postAction, reverseAction, simulateAction, type AcquireActionState,
} from './actions';

const INITIAL: AcquireActionState = { ok: false, message: '' };

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export default function AcquireForm({ preview: initialPreview, canAcquire, today }: {
  preview: AcquisitionPreview | null;
  canAcquire: boolean;
  today: string;
}) {
  const [simState, simulate, simulating] = useActionState(simulateAction, INITIAL);
  const [postState, post, posting] = useActionState(postAction, INITIAL);
  const [reverseState, reverse, reversing] = useActionState(reverseAction, INITIAL);
  const [requestKey] = useState(() => crypto.randomUUID());
  // Controlled entry fields: React resets uncontrolled inputs after a
  // form action, which would wipe the entry between Simulate and Post.
  const [fields, setFields] = useState({
    companyCode: '', assetNumber: '', subNumber: '0000',
    documentDate: today, postingDate: today, assetValueDate: today,
    documentType: 'AA', currency: '', amount: '', offsetAccount: '',
    transactionType: 'ACQ', reference: '', text: '',
  });
  const bind = (name: keyof typeof fields) => ({
    name,
    value: fields[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setFields((f) => ({ ...f, [name]: e.target.value })),
  });
  const preview = simState.preview ?? initialPreview;
  return (
    <>
      <section aria-labelledby="aq-entry" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="aq-entry" className="text-sm font-semibold">Acquisition details</h2>
        <form className="mt-3">
          <input type="hidden" name="requestKey" value={requestKey} />
          {(simState.message || postState.message) && (
            <p role="status" className={`mb-3 text-sm ${(postState.message ? postState.ok : simState.ok) ? 'text-ink' : 'text-red-700'}`}>
              {postState.message || simState.message}
              {postState.remedy ?? simState.remedy ? ` ${postState.remedy ?? simState.remedy}` : ''}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className={labelCls}>Company code</span>
              <input {...bind('companyCode')} className={inputCls} placeholder="1000" required /></label>
            <label className="block"><span className={labelCls}>Asset main number</span>
              <input {...bind('assetNumber')} className={inputCls} placeholder="AS-0000001" required /></label>
            <label className="block"><span className={labelCls}>Asset sub-number</span>
              <input {...bind('subNumber')} className={inputCls} /></label>
            <label className="block"><span className={labelCls}>Document date</span>
              <input type="date" {...bind('documentDate')} className={inputCls} required /></label>
            <label className="block"><span className={labelCls}>Posting date</span>
              <input type="date" {...bind('postingDate')} className={inputCls} required /></label>
            <label className="block"><span className={labelCls}>Asset value date</span>
              <input type="date" {...bind('assetValueDate')} className={inputCls} required /></label>
            <label className="block"><span className={labelCls}>Document type</span>
              <input {...bind('documentType')} className={inputCls} maxLength={2} required /></label>
            <label className="block"><span className={labelCls}>Currency</span>
              <input {...bind('currency')} className={inputCls} placeholder="USD" required /></label>
            <label className="block"><span className={labelCls}>Acquisition amount</span>
              <input {...bind('amount')} className={inputCls} placeholder="25000" required /></label>
            <label className="block"><span className={labelCls}>Offsetting G/L account</span>
              <input {...bind('offsetAccount')} className={inputCls} placeholder="199000" required /></label>
            <label className="block"><span className={labelCls}>Asset transaction type</span>
              <input {...bind('transactionType')} className={inputCls} required /></label>
            <label className="block"><span className={labelCls}>Reference</span>
              <input {...bind('reference')} className={inputCls} placeholder="PO-2026-118" /></label>
            <label className="block sm:col-span-2"><span className={labelCls}>Text</span>
              <input {...bind('text')} className={inputCls} maxLength={50} placeholder="CNC machine acquisition" /></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" formAction={simulate} className="btn btn-default min-h-11 sm:min-h-8"
              disabled={!canAcquire || simulating}>
              Simulate
            </button>
            <button type="submit" formAction={post} className="btn btn-primary min-h-11 sm:min-h-8"
              disabled={!canAcquire || posting}>
              Post acquisition
            </button>
          </div>
          {!canAcquire && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the asset acquisition capability.</p>
          )}
          <p className="mt-2 text-sm text-ink-soft">
            No vendor stands in this posting: the asset account is debited through the asset
            subledger and the offsetting account credited, in one balanced document.
          </p>
        </form>
      </section>

      <section aria-labelledby="aq-preview" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="aq-preview" className="text-sm font-semibold">Simulation preview</h2>
        {!preview ? (
          <p className="mt-2 text-sm text-ink-soft">Simulate to preview the determined posting before anything is written.</p>
        ) : (
          <div className="mt-2 text-sm">
            <p>{preview.assetDescription} · Class {preview.assetClass} · Capitalization {preview.capitalizationDate}</p>
            <table className="mt-2 min-w-full text-left">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Account</th><th className="px-2 py-2">Debit</th><th className="px-2 py-2">Credit</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-line">
                  <td className="px-2 py-2">{preview.reconAccount} (asset)</td>
                  <td className="px-2 py-2">{preview.debitAmount.toFixed(2)} {preview.currency}</td>
                  <td className="px-2 py-2">—</td>
                </tr>
                <tr className="border-t border-line">
                  <td className="px-2 py-2">{preview.offsetAccount} (offsetting)</td>
                  <td className="px-2 py-2">—</td>
                  <td className="px-2 py-2">{preview.creditAmount.toFixed(2)} {preview.currency}</td>
                </tr>
              </tbody>
            </table>
            {preview.warnings.map((w) => (
              <p key={w} className="mt-1 text-ink-soft">{w}</p>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="aq-reverse" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="aq-reverse" className="text-sm font-semibold">Reverse an acquisition</h2>
        {reverseState.message && (
          <p role="status" className={`mt-2 text-sm ${reverseState.ok ? 'text-ink' : 'text-red-700'}`}>
            {reverseState.message}{reverseState.remedy ? ` ${reverseState.remedy}` : ''}
          </p>
        )}
        <form action={reverse} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block"><span className={labelCls}>Company code</span>
            <input name="companyCode" className={inputCls} placeholder="1000" required /></label>
          <label className="block"><span className={labelCls}>Asset main number</span>
            <input name="assetNumber" className={inputCls} required /></label>
          <label className="block"><span className={labelCls}>Sub-number</span>
            <input name="subNumber" className={inputCls} defaultValue="0000" /></label>
          <label className="block"><span className={labelCls}>Acquisition document</span>
            <input name="documentNumber" className={inputCls} required /></label>
          <label className="block"><span className={labelCls}>Fiscal year</span>
            <input name="fiscalYear" className={inputCls} placeholder="2026" required /></label>
          <label className="block"><span className={labelCls}>Reversal date</span>
            <input type="date" name="reversalDate" className={inputCls} defaultValue={today} required /></label>
          <label className="block"><span className={labelCls}>Reason</span>
            <input name="reason" className={inputCls} placeholder="Wrong amount" /></label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canAcquire || reversing}>
              Reverse acquisition
            </button>
          </div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">
          The reversal is asset-aware: the journal reverses and the value record flips to
          REVERSED with its link, so the finance reversal screen refuses these documents.
        </p>
      </section>
    </>
  );
}

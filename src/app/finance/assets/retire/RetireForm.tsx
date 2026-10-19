'use client';

import { useActionState, useState, type ChangeEvent } from 'react';

import type { RetirementPreview, RetirementScope } from '@/modules/finance/asset-retirement';
import {
  postAction, reverseAction, simulateAction, type RetireActionState,
} from './actions';

const INITIAL: RetireActionState = { ok: false, message: '' };

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export interface RetireableAssetOption {
  companyCode: string;
  assetNumber: string;
  subNumber: string;
  description1: string;
  status: string;
  acquiredValue: number;
  retiredValue: number;
  remainingValue: number;
  currency: string;
}

export default function RetireForm({ canRetire, today, assets }: {
  canRetire: boolean;
  today: string;
  assets: RetireableAssetOption[];
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
    documentType: 'AB', currency: '', transactionType: 'RET',
    retirementPercent: '', retirementAmount: '', reference: '', text: '',
  });
  const [scope, setScope] = useState<RetirementScope>('COMPLETE');
  const bind = (name: keyof typeof fields) => ({
    name,
    value: fields[name],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setFields((f) => ({ ...f, [name]: e.target.value })),
  });
  const pickAsset = (e: ChangeEvent<HTMLSelectElement>) => {
    const asset = assets.find((a) => `${a.companyCode}/${a.assetNumber}/${a.subNumber}` === e.target.value);
    if (asset) {
      setFields((f) => ({
        ...f, companyCode: asset.companyCode, assetNumber: asset.assetNumber,
        subNumber: asset.subNumber, currency: asset.currency || f.currency,
      }));
    }
  };
  const preview: RetirementPreview | null = simState.preview ?? null;
  const selected = assets.find(
    (a) => a.companyCode === fields.companyCode && a.assetNumber === fields.assetNumber && a.subNumber === fields.subNumber,
  );
  return (
    <>
      <section aria-labelledby="rt-select" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rt-select" className="text-sm font-semibold">Select asset</h2>
        <label className="mt-3 block"><span className={labelCls}>Standing assets and book values</span>
          <select className={inputCls} defaultValue="" onChange={pickAsset}>
            <option value="">Choose an asset to fill the entry…</option>
            {assets.map((a) => (
              <option key={`${a.companyCode}/${a.assetNumber}/${a.subNumber}`} value={`${a.companyCode}/${a.assetNumber}/${a.subNumber}`}>
                {a.companyCode} · {a.assetNumber}/{a.subNumber} · {a.description1} · {a.status} ·
                acquired {a.acquiredValue.toFixed(2)} · retired {a.retiredValue.toFixed(2)} ·
                book value {a.remainingValue.toFixed(2)} {a.currency}
              </option>
            ))}
          </select></label>
        {selected && (
          <p className="mt-2 text-sm text-ink-soft">
            {selected.description1}: book value {selected.remainingValue.toFixed(2)} {selected.currency}
            of {selected.acquiredValue.toFixed(2)} acquired ({selected.retiredValue.toFixed(2)} already retired), status {selected.status}.
          </p>
        )}
      </section>

      <section aria-labelledby="rt-entry" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rt-entry" className="text-sm font-semibold">Retirement details</h2>
        <form className="mt-3">
          <input type="hidden" name="requestKey" value={requestKey} />
          <input type="hidden" name="scope" value={scope} />
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
            <label className="block"><span className={labelCls}>Currency (acquisition currency)</span>
              <input {...bind('currency')} className={inputCls} placeholder="USD" required /></label>
            <label className="block"><span className={labelCls}>Asset transaction type</span>
              <input {...bind('transactionType')} className={inputCls} required /></label>
            <label className="block"><span className={labelCls}>Retirement scope</span>
              <select className={inputCls} value={scope}
                onChange={(e) => setScope(e.target.value as RetirementScope)}>
                <option value="COMPLETE">Complete retirement</option>
                <option value="PERCENT">Partial — percentage</option>
                <option value="AMOUNT">Partial — amount</option>
              </select></label>
            {scope === 'PERCENT' && (
              <label className="block"><span className={labelCls}>Retirement percentage (of remaining)</span>
                <input {...bind('retirementPercent')} className={inputCls} placeholder="25" required /></label>
            )}
            {scope === 'AMOUNT' && (
              <label className="block"><span className={labelCls}>Acquisition value to retire</span>
                <input {...bind('retirementAmount')} className={inputCls} placeholder="25000" required /></label>
            )}
            <label className="block"><span className={labelCls}>Reference</span>
              <input {...bind('reference')} className={inputCls} placeholder="SCRAP-2026-04" /></label>
            <label className="block sm:col-span-2"><span className={labelCls}>Text</span>
              <input {...bind('text')} className={inputCls} maxLength={50} placeholder="Scrapped after failure" /></label>
          </div>
          {scope === 'COMPLETE' && (
            <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Warning: a complete retirement ends this asset. It leaves future depreciation and
              takes no further acquisition or retirement once posted. Reverse it asset-aware if
              it was posted in error — never delete it.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" formAction={simulate} className="btn btn-default min-h-11 sm:min-h-8"
              disabled={!canRetire || simulating}>
              Simulate
            </button>
            <button type="submit" formAction={post} className="btn btn-primary min-h-11 sm:min-h-8"
              disabled={!canRetire || posting}>
              Post retirement
            </button>
          </div>
          {!canRetire && (
            <p className="mt-2 text-sm text-ink-soft">You do not hold the asset retirement capability.</p>
          )}
          <p className="mt-2 text-sm text-ink-soft">
            Scrapping without proceeds: the retired acquisition value is credited to the asset
            account, accumulated depreciation is reversed for its share, and the remaining book
            value is written off as a loss — in one balanced document.
          </p>
        </form>
      </section>

      <section aria-labelledby="rt-preview" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rt-preview" className="text-sm font-semibold">Simulation preview</h2>
        {!preview ? (
          <p className="mt-2 text-sm text-ink-soft">Simulate to preview the determined posting before anything is written.</p>
        ) : (
          <div className="mt-2 text-sm">
            <p>
              {preview.assetDescription} · Class {preview.assetClass} · Acquired {preview.acquiredValue.toFixed(2)} ·
              already retired {preview.alreadyRetiredValue.toFixed(2)} · accumulated depreciation {preview.accumulatedDepreciation.toFixed(2)} {preview.currency}
            </p>
            <table className="mt-2 min-w-full text-left">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Account</th><th className="px-2 py-2">Debit</th><th className="px-2 py-2">Credit</th>
                </tr>
              </thead>
              <tbody>
                {preview.depreciationReversed > 0 && (
                  <tr className="border-t border-line">
                    <td className="px-2 py-2">{preview.accumAccount} (accumulated depreciation)</td>
                    <td className="px-2 py-2">{preview.depreciationReversed.toFixed(2)} {preview.currency}</td>
                    <td className="px-2 py-2">—</td>
                  </tr>
                )}
                {preview.lossAmount > 0 && (
                  <tr className="border-t border-line">
                    <td className="px-2 py-2">{preview.lossAccount} (loss on retirement)</td>
                    <td className="px-2 py-2">{preview.lossAmount.toFixed(2)} {preview.currency}</td>
                    <td className="px-2 py-2">—</td>
                  </tr>
                )}
                <tr className="border-t border-line">
                  <td className="px-2 py-2">{preview.reconAccount} (asset)</td>
                  <td className="px-2 py-2">—</td>
                  <td className="px-2 py-2">{preview.retiredAcquisitionValue.toFixed(2)} {preview.currency}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2">
              Remaining after posting: acquisition {preview.remainingAcquisitionValue.toFixed(2)},
              book value {preview.remainingNetBookValue.toFixed(2)} {preview.currency}.
            </p>
            {preview.warnings.map((w) => (
              <p key={w} className="mt-1 text-ink-soft">{w}</p>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="rt-reverse" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rt-reverse" className="text-sm font-semibold">Reverse a retirement</h2>
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
          <label className="block"><span className={labelCls}>Retirement document</span>
            <input name="documentNumber" className={inputCls} required /></label>
          <label className="block"><span className={labelCls}>Fiscal year</span>
            <input name="fiscalYear" className={inputCls} placeholder="2026" required /></label>
          <label className="block"><span className={labelCls}>Reversal date</span>
            <input type="date" name="reversalDate" className={inputCls} defaultValue={today} required /></label>
          <label className="block"><span className={labelCls}>Reason</span>
            <input name="reason" className={inputCls} placeholder="Retired in error" /></label>
          <div className="flex items-end">
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canRetire || reversing}>
              Reverse retirement
            </button>
          </div>
        </form>
        <p className="mt-2 text-sm text-ink-soft">
          The reversal is asset-aware: the journal reverses, the retirement record flips to
          REVERSED, and a completed asset returns to ACTIVE — so the finance reversal screen
          refuses these documents.
        </p>
      </section>
    </>
  );
}

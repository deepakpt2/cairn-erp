'use client';

import { useState } from 'react';

import type { RetirementPreview } from '@/modules/finance/asset-retirement';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

/**
 * Guided ABZON-style shell for retirement by scrapping (SCR-093
 * stage 1): the field matrix stands complete; the service wires in
 * stage 3 of R-141.
 */
export default function RetireForm({ canRetire, today }: {
  canRetire: boolean;
  today: string;
}) {
  const [scope, setScope] = useState<'COMPLETE' | 'PERCENT' | 'AMOUNT'>('COMPLETE');
  const [preview] = useState<RetirementPreview | null>(null);
  return (
    <>
      <section aria-labelledby="rt-entry" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="rt-entry" className="text-sm font-semibold">Retirement details</h2>
        <form className="mt-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className={labelCls}>Company code</span>
              <input name="companyCode" className={inputCls} placeholder="1000" required /></label>
            <label className="block"><span className={labelCls}>Asset main number</span>
              <input name="assetNumber" className={inputCls} placeholder="AS-0000001" required /></label>
            <label className="block"><span className={labelCls}>Asset sub-number</span>
              <input name="subNumber" className={inputCls} defaultValue="0000" /></label>
            <label className="block"><span className={labelCls}>Document date</span>
              <input type="date" name="documentDate" className={inputCls} defaultValue={today} required /></label>
            <label className="block"><span className={labelCls}>Posting date</span>
              <input type="date" name="postingDate" className={inputCls} defaultValue={today} required /></label>
            <label className="block"><span className={labelCls}>Asset value date</span>
              <input type="date" name="assetValueDate" className={inputCls} defaultValue={today} required /></label>
            <label className="block"><span className={labelCls}>Document type</span>
              <input name="documentType" className={inputCls} defaultValue="AB" maxLength={2} required /></label>
            <label className="block"><span className={labelCls}>Currency</span>
              <input name="currency" className={inputCls} placeholder="USD" required /></label>
            <label className="block"><span className={labelCls}>Asset transaction type</span>
              <input name="transactionType" className={inputCls} defaultValue="RET" required /></label>
            <label className="block"><span className={labelCls}>Retirement scope</span>
              <select name="scope" className={inputCls} value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}>
                <option value="COMPLETE">Complete retirement</option>
                <option value="PERCENT">Partial — percentage</option>
                <option value="AMOUNT">Partial — amount</option>
              </select></label>
            {scope === 'PERCENT' && (
              <label className="block"><span className={labelCls}>Retirement percentage (of remaining)</span>
                <input name="retirementPercent" className={inputCls} placeholder="25" required /></label>
            )}
            {scope === 'AMOUNT' && (
              <label className="block"><span className={labelCls}>Acquisition value to retire</span>
                <input name="retirementAmount" className={inputCls} placeholder="25000" required /></label>
            )}
            <label className="block"><span className={labelCls}>Reference</span>
              <input name="reference" className={inputCls} placeholder="SCRAP-2026-04" /></label>
            <label className="block sm:col-span-2"><span className={labelCls}>Text</span>
              <input name="text" className={inputCls} maxLength={50} placeholder="Scrapped after failure" /></label>
          </div>
          {scope === 'COMPLETE' && (
            <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Warning: a complete retirement ends this asset. It leaves future depreciation and
              takes no further acquisition or retirement once posted. Reverse it asset-aware if
              it was posted in error — never delete it.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled>
              Simulate
            </button>
            <button type="button" className="btn btn-primary min-h-11 sm:min-h-8" disabled>
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
        ) : null}
      </section>
    </>
  );
}

'use client';

import type { AcquisitionPreview } from '@/modules/finance/asset-acquisition';

const inputCls = 'input w-full';
const labelCls = 'mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint';

export default function AcquireForm({ preview, canAcquire, today }: {
  preview: AcquisitionPreview | null;
  canAcquire: boolean;
  today: string;
}) {
  return (
    <>
      <section aria-labelledby="aq-entry" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="aq-entry" className="text-sm font-semibold">Acquisition details</h2>
        <form className="mt-3">
          <input type="hidden" name="requestKey" value="" />
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
              <input name="documentType" className={inputCls} defaultValue="AA" maxLength={2} required /></label>
            <label className="block"><span className={labelCls}>Currency</span>
              <input name="currency" className={inputCls} placeholder="USD" required /></label>
            <label className="block"><span className={labelCls}>Acquisition amount</span>
              <input name="amount" className={inputCls} placeholder="25000" required /></label>
            <label className="block"><span className={labelCls}>Offsetting G/L account</span>
              <input name="offsetAccount" className={inputCls} placeholder="199000" required /></label>
            <label className="block"><span className={labelCls}>Asset transaction type</span>
              <input name="transactionType" className={inputCls} defaultValue="ACQ" required /></label>
            <label className="block"><span className={labelCls}>Reference</span>
              <input name="reference" className={inputCls} placeholder="PO-2026-118" /></label>
            <label className="block sm:col-span-2"><span className={labelCls}>Text</span>
              <input name="text" className={inputCls} maxLength={50} placeholder="CNC machine acquisition" /></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8"
              disabled title="Simulation stands disabled until the acquisition service lands.">
              Simulate
            </button>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
              disabled title="Posting stands disabled until the acquisition service lands.">
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
    </>
  );
}

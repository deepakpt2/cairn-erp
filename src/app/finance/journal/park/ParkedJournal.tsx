'use client';

import { useState } from 'react';

import type { ParkedJournalView } from '@/modules/finance/parked-journal';

interface LineRow {
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: string;
  costCenter: string;
  profitCenter: string;
  taxCode: string;
  assignment: string;
  lineText: string;
}

const blankLine = (): LineRow => ({
  glAccount: '', debitCredit: 'S', amount: '', costCenter: '', profitCenter: '', taxCode: '', assignment: '', lineText: '',
});

export default function ParkedJournal({ parked, canPark, today }: {
  parked: ParkedJournalView[];
  canPark: boolean;
  today: string;
}) {
  const [lines, setLines] = useState<LineRow[]>([blankLine(), blankLine()]);

  const total = (side: 'S' | 'H') => Math.round(lines
    .filter((l) => l.debitCredit === side)
    .reduce((s, l) => s + (Number(l.amount) || 0), 0) * 100) / 100;
  const debit = total('S');
  const credit = total('H');
  const balance = Math.round((debit - credit) * 100) / 100;

  const setLine = (index: number, patch: Partial<LineRow>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <>
      <section aria-labelledby="pj-header" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pj-header" className="text-sm font-semibold">Park a document</h2>
        <form>
          <input type="hidden" name="requestKey" value="" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
              <input name="companyCode" className="input w-full" placeholder="1000" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
              <input type="date" name="documentDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
              <input type="date" name="postingDate" className="input w-full" defaultValue={today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document type</span>
              <input name="documentType" className="input w-full" defaultValue="SA" maxLength={2} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Currency</span>
              <input name="currency" className="input w-full" placeholder="USD" required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reference</span>
              <input name="reference" className="input w-full" placeholder="INV-2026-PARK" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Header text</span>
              <input name="headerText" className="input w-full" placeholder="Accrual entry" maxLength={100} />
            </label>
          </div>

          <h3 className="mt-4 text-sm font-semibold">Line items</h3>
          <div className="mt-2 space-y-2">
            {lines.map((line, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">G/L account</span>
                  <input aria-label="G/L account" className="input w-28" value={line.glAccount}
                    onChange={(e) => setLine(index, { glAccount: e.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">D/C</span>
                  <select aria-label="Debit or credit" className="input w-20" value={line.debitCredit}
                    onChange={(e) => setLine(index, { debitCredit: e.target.value as 'S' | 'H' })}>
                    <option value="S">S debit</option>
                    <option value="H">H credit</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Amount</span>
                  <input aria-label="Amount" className="input w-28" value={line.amount}
                    onChange={(e) => setLine(index, { amount: e.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Cost centre</span>
                  <input aria-label="Cost centre" className="input w-28" value={line.costCenter}
                    onChange={(e) => setLine(index, { costCenter: e.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Profit centre</span>
                  <input aria-label="Profit centre" className="input w-28" value={line.profitCenter}
                    onChange={(e) => setLine(index, { profitCenter: e.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Tax code</span>
                  <input aria-label="Tax code" className="input w-20" value={line.taxCode}
                    onChange={(e) => setLine(index, { taxCode: e.target.value })} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Line text</span>
                  <input aria-label="Line text" className="input w-40" value={line.lineText}
                    onChange={(e) => setLine(index, { lineText: e.target.value })} />
                </label>
                <button type="button" className="btn btn-default min-h-11 sm:min-h-8"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-default mt-2 min-h-11 sm:min-h-8"
            onClick={() => setLines((prev) => [...prev, blankLine()])}>
            Add line
          </button>

          <p className="mt-2 text-sm text-ink-soft">
            Debits {debit.toFixed(2)} · Credits {credit.toFixed(2)} · Difference {balance.toFixed(2)}.
            A parked document may stand unbalanced; it must balance before it can be saved as
            complete or posted. Parking moves no account and changes no balance.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8"
              disabled title="Parking stands disabled until the parked-document service lands.">
              Park document
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="pj-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pj-list" className="text-sm font-semibold">Parked documents</h2>
        {parked.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No documents stand parked.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Parked document</th><th className="px-2 py-2">Company</th>
                  <th className="px-2 py-2">Type</th><th className="px-2 py-2">Posting date</th>
                  <th className="px-2 py-2">Currency</th><th className="px-2 py-2">Debits</th>
                  <th className="px-2 py-2">Credits</th><th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Posted as</th>
                </tr>
              </thead>
              <tbody>
                {parked.map((doc) => (
                  <tr key={doc.parkedNumber} className="border-t border-line">
                    <td className="px-2 py-2">{doc.parkedNumber}</td>
                    <td className="px-2 py-2">{doc.companyCode}</td>
                    <td className="px-2 py-2">{doc.documentType}</td>
                    <td className="px-2 py-2">{doc.postingDate}</td>
                    <td className="px-2 py-2">{doc.currency}</td>
                    <td className="px-2 py-2">{doc.totalDebit.toFixed(2)}</td>
                    <td className="px-2 py-2">{doc.totalCredit.toFixed(2)}</td>
                    <td className="px-2 py-2">{doc.status}</td>
                    <td className="px-2 py-2">{doc.postedDocumentNumber ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canPark && (
          <p className="mt-2 text-sm text-ink-soft">You do not hold the journal parking capability.</p>
        )}
      </section>
    </>
  );
}

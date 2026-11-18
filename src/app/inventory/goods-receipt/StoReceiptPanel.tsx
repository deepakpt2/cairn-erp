'use client';

import { useActionState, useEffect, useState } from 'react';

import type { StoOrderStatus } from '@/modules/inventory/stock-transport';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import { postGoodsReceiptAction, type GoodsReceiptActionState } from './actions';

const INITIAL: GoodsReceiptActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Goods receipt from transit for a stock transport order (ITEM-22), on the existing goods receipt screen.
 *
 * It shows only what stands in transit, never a supplier GR/IR: no supplier, no price, no invoice. A receipt takes
 * transit stock of the receiving plant into unrestricted stock of the storage location named here, in a batch that
 * was issued. The allocation table shows each issue (351) the receipt will draw from, oldest first, with the value it
 * carried. Transit is not received until this posts; a posted receipt (or the issue) is reversed on the material
 * document reversal screen.
 */
export default function StoReceiptPanel({ status, canPost, today }: {
  status: StoOrderStatus;
  canPost: boolean;
  today: string;
}) {
  const [state, action, pending] = useActionState(postGoodsReceiptAction, INITIAL);
  const [key, setKey] = useState(newRequestKey);
  useEffect(() => {
    if (state.ok) setKey(newRequestKey());
  }, [state]);

  return (
    <section aria-labelledby="gr-sto" className="border border-line bg-surface p-4" data-sto-receipt>
      <h2 id="gr-sto" className="text-sm font-semibold">Goods receipt from transit · stock transport order {status.orderNumber}</h2>
      <p className="mt-1 text-sm text-ink-soft" data-sto-flow>
        From plant {status.supplyingPlant} (company {status.supplyingCompany}) to company {status.companyCode}
        {' · '}{status.crossCompany ? 'cross-company' : 'same company'}. Stock in transit is not received and not available until it is posted here.
      </p>
      {state.message && (
        <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      <form action={action}>
        <input type="hidden" name="orderNumber" value={status.orderNumber} />
        <input type="hidden" name="requestKey" value={key} />
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
            <input type="date" name="postingDate" className="input w-full" defaultValue={today} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Document date</span>
            <input type="date" name="documentDate" className="input w-full" defaultValue={today} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Header text</span>
            <input name="headerText" maxLength={25} className="input w-full" />
          </label>
        </div>
        <div className="table-scroll mt-3">
          <table className="grid-table text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th>Item</th><th>Material</th><th>Receiving plant</th>
                <th className="text-right">Ordered</th><th className="text-right">Net issued</th>
                <th className="text-right">Net received</th><th className="text-right">In transit</th>
                <th>Quantity received</th><th>Storage location</th><th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {status.items.map((item) => {
                const batches = [...new Set(item.allocations.filter((a) => Number(a.inTransit) > 0).map((a) => a.batch))];
                return (
                  <tr key={item.itemNumber}>
                    <td>{item.itemNumber}</td>
                    <td>{item.materialNumber}</td>
                    <td>{item.receivingPlant}</td>
                    <td className="num">{item.orderedBase} {item.baseUnit}</td>
                    <td className="num">{item.netIssued}</td>
                    <td className="num">{item.netReceived}</td>
                    <td className="num" data-transit>{item.inTransit}</td>
                    <td>
                      <input name={`qty-${item.itemNumber}`} className="input w-28" inputMode="decimal"
                        placeholder={item.baseUnit} disabled={Number(item.inTransit) === 0} />
                    </td>
                    <td>
                      <ConstrainedField kind="storage-location" name={`sloc-${item.itemNumber}`} className="input w-24"
                        context={{ plant: item.receivingPlant }} defaultValue={item.storageLocation ?? ''} />
                    </td>
                    <td>
                      {batches.length > 1 ? (
                        <select name={`batch-${item.itemNumber}`} className="input w-28" defaultValue="">
                          <option value="">— choose —</option>
                          {batches.map((b) => <option key={b} value={b}>{b || '(none)'}</option>)}
                        </select>
                      ) : (
                        <input name={`batch-${item.itemNumber}`} className="input w-28" maxLength={10} defaultValue={batches[0] ?? ''} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="submit" disabled={!canPost || pending} className="btn btn-primary mt-3 min-h-11 sm:min-h-8">
          Post goods receipt (101) from transit
        </button>
      </form>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">Issues in transit (oldest first)</h3>
      <div className="table-scroll mt-1">
        <table className="grid-table text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <th>Item</th><th>Issue document</th><th>Batch</th><th>Posted</th>
              <th className="text-right">Issued</th><th className="text-right">Received</th><th className="text-right">In transit</th>
              <th className="text-right">Issue value</th><th className="text-right">Value carried</th>
            </tr>
          </thead>
          <tbody>
            {status.items.flatMap((item) => item.allocations.map((a) => (
              <tr key={`${a.issueDocument}/${a.issueLine}`}>
                <td>{item.itemNumber}</td>
                <td><a className="underline" href={`/inventory/material-documents?document=${encodeURIComponent(a.issueDocument)}`}>{a.issueDocument}/{a.issueLine}</a></td>
                <td>{a.batch || '—'}</td>
                <td>{a.postingDate}</td>
                <td className="num">{a.issued}</td>
                <td className="num">{a.received}</td>
                <td className="num">{a.inTransit}</td>
                <td className="num">{a.issueValue} {a.sourceCurrency}</td>
                <td className="num">{a.transitValue} {a.receivingCurrency}</td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

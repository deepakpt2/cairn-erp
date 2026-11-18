'use client';

import { useActionState, useEffect, useState } from 'react';

import type { StoOrderStatus } from '@/modules/inventory/stock-transport';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import { postStoIssueAction, type StoIssueActionState } from './actions';

const INITIAL: StoIssueActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Stock transport order goods issue (351), on the existing transfer posting screen (ITEM-22).
 *
 * The order is looked up by number; the items, the plants and the material come from the ORDER, and only the
 * quantity, the issuing storage location and the batch are typed. It shows what the issue will rest on: ordered,
 * net issued (351 less 352), in transit and issueable. A 351 puts the stock into transit of the receiving plant
 * (not into its unrestricted stock); the receipt is posted on the goods receipt screen, and either movement is
 * reversed on the material document reversal screen.
 */
export default function StoIssuePanel({ status, orderNumber, canPost, today, lookupMessage }: {
  status: StoOrderStatus | null;
  orderNumber: string;
  canPost: boolean;
  today: string;
  lookupMessage: string | null;
}) {
  const [state, action, pending] = useActionState(postStoIssueAction, INITIAL);
  const [key, setKey] = useState(newRequestKey);
  useEffect(() => {
    if (state.ok) setKey(newRequestKey());
  }, [state]);

  return (
    <section aria-labelledby="sto-issue" className="mt-4 border border-line bg-surface p-4" data-sto-issue>
      <h2 id="sto-issue" className="text-sm font-semibold">Stock transport order goods issue (351)</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Issues stock from the supplying plant into transit of the receiving plant. It is not received yet: the receipt (101)
        is posted from transit on the goods receipt screen.
      </p>
      <form method="get" action="/inventory/transfer-posting" className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Stock transport order</span>
          <input name="sto" className="input w-48" placeholder="Order number" defaultValue={orderNumber} />
        </label>
        <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load order</button>
      </form>
      {lookupMessage && <p role="status" className="mt-2 text-sm text-signal-error">{lookupMessage}</p>}

      {status && (
        <>
          <p className="mt-3 text-sm text-ink-soft" data-sto-flow>
            Supplying plant {status.supplyingPlant} (company {status.supplyingCompany}) → receiving company {status.companyCode}
            {' · '}{status.crossCompany ? 'cross-company: two accounting documents, one per company' : 'same company'}
            {status.releaseStatus === 'UNRELEASED' ? ' · release pending' : ''}
          </p>
          {state.message && (
            <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
              {state.message}{state.remedy ? ` ${state.remedy}` : ''}
              {state.ok && state.documentNumber && (
                <>{' '}<a className="underline" href={`/inventory/material-documents?document=${encodeURIComponent(state.documentNumber)}`}>Display document</a></>
              )}
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
                    <th className="text-right">In transit</th><th className="text-right">Issueable</th>
                    <th>Quantity to issue</th><th>Issuing storage location</th><th>Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {status.items.map((item) => (
                    <tr key={item.itemNumber}>
                      <td>{item.itemNumber}</td>
                      <td>{item.materialNumber}</td>
                      <td>{item.receivingPlant}</td>
                      <td className="num">{item.orderedBase} {item.baseUnit}</td>
                      <td className="num">{item.netIssued}</td>
                      <td className="num" data-transit>{item.inTransit}</td>
                      <td className="num">{item.issueable}</td>
                      <td>
                        <input name={`qty-${item.itemNumber}`} className="input w-28" inputMode="decimal"
                          placeholder={item.baseUnit} disabled={item.markedForDeletion || Number(item.issueable) === 0} />
                      </td>
                      <td>
                        <ConstrainedField kind="storage-location" name={`sloc-${item.itemNumber}`} className="input w-24"
                          context={{ plant: status.supplyingPlant }} />
                      </td>
                      <td><input name={`batch-${item.itemNumber}`} className="input w-24" maxLength={10} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="submit" disabled={!canPost || pending} className="btn btn-primary mt-3 min-h-11 sm:min-h-8">
              Post goods issue (351)
            </button>
          </form>
        </>
      )}
    </section>
  );
}

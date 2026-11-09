'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import type {
  InvoiceListDueRow,
  InvoiceListRow,
} from '@/modules/sales/invoice-list';
import {
  cancelInvoiceListAction,
  createInvoiceListAction,
  releaseInvoiceListAction,
  type InvoiceListActionState,
} from './actions';

const INITIAL: InvoiceListActionState = { ok: false, message: '' };

const money = (value: number) => value.toFixed(2);

/**
 * Grouping the month — SAP's `VF21`.
 *
 * One form for the whole queue, because the act is one act: a list is raised for everything the reader
 * ticked, and ticking is what chooses. The list is for **one payer in one currency in one company code
 * for one list date**, which is why the queue is shown grouped and a cross-group ticking is refused by
 * the service rather than silently narrowed here.
 */
function CreateForm({
  due, canCreate,
}: { due: InvoiceListDueRow[]; canCreate: boolean }) {
  const [state, action, pending] = useActionState(createInvoiceListAction, INITIAL);

  // What one list may be made of: the group the first ticked document belongs to. Ticking across two
  // groups is a refusal, and saying so before the button is pressed is cheaper than after.
  const groups = new Map<string, InvoiceListDueRow[]>();
  for (const row of due) {
    const key = [row.payer, row.companyCode, row.currency, row.invoiceListDate].join('|');
    const bucket = groups.get(key);
    if (bucket) bucket.push(row); else groups.set(key, [row]);
  }

  if (due.length === 0) {
    return (
      <p className="mt-2 text-sm text-ink-soft">
        Nothing is waiting for an invoice list. A document has to be billed, and to carry both a list
        type on its billing type and a schedule on its payer, before a list can take it.
      </p>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-3">
      <div className="overflow-x-auto">
        <table className="grid-table text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-ink-faint">
              <th>Take</th>
              <th>Document</th>
              <th>Type</th>
              <th>Billed</th>
              <th>List date</th>
              <th>Payer</th>
              <th className="text-right">Net</th>
              <th className="text-right">Tax</th>
              <th className="text-right">Gross</th>
            </tr>
          </thead>
          <tbody>
            {due.map((row) => (
              <tr key={row.billingNumber}>
                <td>
                  <input
                    type="checkbox"
                    name="billingNumber"
                    value={row.billingNumber}
                    aria-label={`Take ${row.billingNumber}`}
                    className="min-h-4 min-w-4"
                  />
                </td>
                <td className="font-mono">
                  <Link href={`/sales/billing?billing=${row.billingNumber}`} className="link">
                    {row.billingNumber}
                  </Link>
                </td>
                <td className="font-mono">{row.documentType}</td>
                <td>{row.billingDate}</td>
                <td className="font-mono">{row.invoiceListDate}</td>
                <td className="font-mono">{row.payer}</td>
                <td className="text-right">{money(row.netValue)}</td>
                <td className="text-right">{money(row.taxValue)}</td>
                <td className="text-right">{money(row.grossValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-ink-faint">What the list says</span>
          <input
            name="referenceDocumentText"
            maxLength={100}
            placeholder="Invoices for the period"
            className="mt-1 min-h-11 w-72 border border-line bg-surface px-2 sm:min-h-8"
          />
        </label>
        {canCreate && (
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>
            {pending ? 'Grouping…' : 'Group onto an invoice list'}
          </button>
        )}
      </div>

      {groups.size > 1 && (
        <p role="status" className="max-w-3xl text-xs text-ink-faint">
          {groups.size} groups are waiting, and one list is raised for one payer, company code, currency
          and list date. Tick inside one group at a time.
        </p>
      )}
      {state.message && (
        <p role="status" className={`max-w-3xl text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}
          {!state.ok && state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
    </form>
  );
}

/** One standing list: what it is worth, what it stands at, and the two acts that move it. */
function ListRow({ row, canCreate, canRelease }: {
  row: InvoiceListRow; canCreate: boolean; canRelease: boolean;
}) {
  const [released, releaseAction, releasing] = useActionState(releaseInvoiceListAction, INITIAL);
  const [cancelled, cancelAction, cancelling] = useActionState(cancelInvoiceListAction, INITIAL);
  const open = row.status === 'OPEN';

  return (
    <tr>
      <td className="font-mono">
        <Link href={`/sales/billing?billing=${row.billingNumber}`} className="link">
          {row.billingNumber}
        </Link>
      </td>
      <td>{row.billingDate}</td>
      <td className="font-mono">{row.payer}</td>
      <td className="font-mono">{row.documentType}</td>
      <td>{row.itemCount}</td>
      <td className="text-right">{money(row.grossValue)}</td>
      <td>{row.status}</td>
      <td className="font-mono">{row.customerInvoiceNumber ?? '—'}</td>
      <td>
        {open ? (
          <div className="flex flex-wrap items-center gap-2">
            {canRelease && (
              <form action={releaseAction}>
                <input type="hidden" name="invoiceListNumber" value={row.billingNumber} />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={releasing}>
                  {releasing ? 'Releasing…' : 'Release to accounting'}
                </button>
              </form>
            )}
            {canCreate && (
              <form action={cancelAction}>
                <input type="hidden" name="invoiceListNumber" value={row.billingNumber} />
                <input name="reason" maxLength={200} placeholder="Why" aria-label="Why this list is cancelled"
                  className="min-h-11 w-40 border border-line bg-surface px-2 sm:min-h-8" />
                <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={cancelling}>
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              </form>
            )}
          </div>
        ) : (
          <span className="text-ink-faint">
            {row.status === 'POSTED' ? 'Released — cancel the accounting invoice' : 'Cancelled'}
          </span>
        )}
        {released.message && (
          <span role="status" className={`block text-xs ${released.ok ? 'text-ink' : 'text-red-700'}`}>
            {released.message}
            {!released.ok && released.remedy ? ` ${released.remedy}` : ''}
          </span>
        )}
        {cancelled.message && (
          <span role="status" className={`block text-xs ${cancelled.ok ? 'text-ink' : 'text-red-700'}`}>
            {cancelled.message}
            {!cancelled.ok && cancelled.remedy ? ` ${cancelled.remedy}` : ''}
          </span>
        )}
      </td>
    </tr>
  );
}

export function InvoiceLists({ due, lists, canCreate, canRelease }: {
  due: InvoiceListDueRow[];
  lists: InvoiceListRow[];
  canCreate: boolean;
  canRelease: boolean;
}) {
  return (
    <>
      <section aria-labelledby="invoice-list-due" className="border border-line bg-surface p-4">
        <h2 id="invoice-list-due" className="text-sm font-semibold">What is waiting to be listed</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Every document here has been billed and released to the customer, and none of them has been
          released to accounting: they are waiting for a list, and the list&apos;s release is what posts
          the receivable. A document that is not waiting is not here — it posted on its own, the day it
          was billed.
        </p>
        <CreateForm due={due} canCreate={canCreate} />
      </section>

      <section aria-labelledby="invoice-list-standing" className="border border-line bg-surface p-4">
        <h2 id="invoice-list-standing" className="text-sm font-semibold">Invoice lists as they stand</h2>
        {lists.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No invoice list stands for this tenant.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>List</th>
                  <th>Dated</th>
                  <th>Payer</th>
                  <th>Type</th>
                  <th>Documents</th>
                  <th className="text-right">Gross</th>
                  <th>Stands</th>
                  <th>Accounting invoice</th>
                  <th>{canCreate || canRelease ? 'What it does' : ''}</th>
                </tr>
              </thead>
              <tbody>
                {lists.map((row) => (
                  <ListRow key={row.billingNumber} row={row} canCreate={canCreate} canRelease={canRelease} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 max-w-3xl text-xs text-ink-faint">
          Releasing is the act that posts, and it is a separate authority from grouping: one receivable
          for the whole list, raised by the accounting-invoice service under a key that makes a retry
          raise no second one. Cancelling a list that has not been released gives its documents back to
          the due list, to be listed again — nothing was posted, so there is nothing to reverse.
        </p>
      </section>
    </>
  );
}

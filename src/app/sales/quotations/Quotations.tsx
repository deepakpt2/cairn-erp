'use client';

import Link from 'next/link';
import { useActionState, useId } from 'react';

import type { QuotationListRow, QuotationView } from '@/modules/sales/quotation';
import { ItemGrid, type GridRow } from '../orders/Orders';
import {
  changeQuotationAction,
  createOrderFromQuotationAction,
  createQuotationAction,
  rejectQuotationAction,
  type QuotationActionState,
} from './actions';

const EMPTY: QuotationActionState = { ok: false };

interface Props {
  documents: QuotationListRow[];
  choices: Awaited<ReturnType<typeof import('@/modules/sales/quotation').quotationChoices>>;
  selected: QuotationView | null;
  canCreate: boolean;
  canRaiseOrder: boolean;
}

const money = (value: string, currency: string) => `${Number(value).toFixed(2)} ${currency.trim()}`;

function Notice({ state }: { state: QuotationActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success p-3 text-sm' : 'panel panel-danger p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.orderNumber ? (
        <p className="mt-2"><Link className="link" href={`/sales/orders?order=${state.orderNumber}`}>Open sales order {state.orderNumber}</Link></p>
      ) : null}
      {state.ok && state.quotationNumber && !state.orderNumber ? (
        <p className="mt-2"><Link className="link" href={`/sales/quotations?quotation=${state.quotationNumber}`}>Open quotation {state.quotationNumber}</Link></p>
      ) : null}
    </div>
  );
}

/** The items that stand; a rejected item number is not reused, so the grid does not offer it. */
function rowsOf(selected: QuotationView): GridRow[] {
  return selected.lines.filter((line) => line.status !== 'REJECTED').map((line, index) => ({
    id: index + 1,
    lineNumber: line.lineNumber,
    materialNumber: line.materialNumber,
    plant: line.plant,
    quantity: String(Number(line.quotationQuantity)),
    unit: line.quantityUnit.trim(),
    tax: line.taxCode ?? '',
    needed: line.requestedDeliveryDate ?? '',
  }));
}

function HeaderFields({ selected }: { selected: QuotationView | null }) {
  const id = useId();
  const today = new Date().toISOString().slice(0, 10);
  const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const field = (name: string, label: string, value: string, placeholder: string) => (
    <label className="block text-xs text-ink-soft" htmlFor={`${id}-${name}`}>
      {label}
      <input className="input mt-1" id={`${id}-${name}`} name={name} defaultValue={value} placeholder={placeholder} autoComplete="off" />
    </label>
  );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {field('customerNumber', 'Customer', selected?.customerNumber ?? '', 'Customer number')}
      {field('salesOrg', 'Sales organization', selected?.salesOrg ?? '', '1000')}
      {field('distributionChannel', 'Distribution channel', selected?.distributionChannel ?? '', '10')}
      {field('division', 'Division', selected?.division ?? '', '01')}
      {field('companyCode', 'Company code', selected?.companyCode ?? '1000', '1000')}
      {field('currency', 'Currency', selected?.currency ?? 'KWD', 'KWD')}
      {field('quotationDate', 'Quotation date', selected?.quotationDate ?? today, 'YYYY-MM-DD')}
      {field('validTo', 'Valid to', selected?.validTo ?? inAWeek, 'YYYY-MM-DD')}
      {field('requestedDate', 'Requested date', selected?.requestedDate ?? '', 'YYYY-MM-DD')}
      {field('purchaseOrderReference', 'Customer enquiry reference', selected?.purchaseOrderReference ?? '', 'Enquiry number')}
      {field('headerText', 'Note', selected?.headerText ?? '', 'Note on the quotation')}
    </div>
  );
}

export default function Quotations({ documents, selected, canCreate, canRaiseOrder }: Props) {
  const [createState, createAction] = useActionState(createQuotationAction, EMPTY);
  const [changeState, changeAction] = useActionState(changeQuotationAction, EMPTY);
  const [rejectState, rejectAction] = useActionState(rejectQuotationAction, EMPTY);
  const [copyState, copyAction] = useActionState(createOrderFromQuotationAction, EMPTY);
  const today = new Date().toISOString().slice(0, 10);
  const open = selected?.status === 'OPEN';

  return (
    <div className="space-y-4">
      {selected ? (
        <section className="panel p-4" data-quotation={selected.quotationNumber} aria-label={`Quotation ${selected.quotationNumber}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Quotation {selected.quotationNumber}</h2>
            <span className="code text-ink-faint">
              {selected.status}{selected.rejectionReason ? ` (${selected.rejectionReason})` : ''}{selected.isExpired ? ' · EXPIRED' : ''}
            </span>
          </div>
          {selected.isExpired ? (
            <p className="mt-2 text-sm text-ink-soft">
              Valid to {selected.validTo}, which has passed. The status stays open — expiry is read from the
              date, never written — and no order can be raised from it until the date is extended.
            </p>
          ) : null}
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <div><dt className="text-ink-faint">Customer</dt><dd>{selected.customerNumber}</dd></div>
            <div><dt className="text-ink-faint">Sales area</dt><dd>{selected.salesOrg}/{selected.distributionChannel}/{selected.division}</dd></div>
            <div><dt className="text-ink-faint">Company code</dt><dd>{selected.companyCode}</dd></div>
            <div><dt className="text-ink-faint">Quotation date</dt><dd>{selected.quotationDate}</dd></div>
            <div><dt className="text-ink-faint">Valid to</dt><dd>{selected.validTo}</dd></div>
            <div><dt className="text-ink-faint">Net value</dt><dd>{money(selected.netValue, selected.currency)}</dd></div>
            <div><dt className="text-ink-faint">Tax</dt><dd>{money(selected.taxValue, selected.currency)}</dd></div>
            <div><dt className="text-ink-faint">Gross value</dt><dd>{money(selected.grossValue, selected.currency)}</dd></div>
            <div><dt className="text-ink-faint">Version</dt><dd>{selected.version}</dd></div>
          </dl>
          {selected.ordersRaised.length > 0 ? (
            <p className="mt-2 text-sm" data-orders-raised>
              Orders raised from this quotation:{' '}
              {selected.ordersRaised.map((n, i) => (
                <span key={n}>{i > 0 ? ', ' : ''}<Link className="link" href={`/sales/orders?order=${n}`}>{n}</Link></span>
              ))}
              . Raising another is allowed; nothing tracks how much of the quotation they consume.
            </p>
          ) : null}

          <table className="grid-table mt-3 text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th>Item</th><th>Material</th><th>Plant</th><th className="text-right">Quantity</th>
                <th className="text-right">Confirmed</th><th>Confirmed for</th><th>Unit</th>
                <th className="text-right">Price</th><th className="text-right">Net</th>
                <th className="text-right">Tax</th><th>Priced from</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {selected.lines.map((line) => (
                <tr key={line.lineNumber}>
                  <td>{line.lineNumber}</td>
                  <td>{line.materialNumber}</td>
                  <td>{line.plant}</td>
                  <td className="text-right num">{Number(line.quotationQuantity).toFixed(3)}</td>
                  <td className="text-right num">{line.confirmedQuantity === null ? '—' : Number(line.confirmedQuantity).toFixed(3)}</td>
                  <td>{line.schedule[0]?.confirmedDate ?? '—'}</td>
                  <td>{line.quantityUnit.trim()}</td>
                  <td className="text-right num">{Number(line.netPrice).toFixed(4)} / {line.priceUnit}</td>
                  <td className="text-right num">{Number(line.netAmount).toFixed(2)}</td>
                  <td className="text-right num">{Number(line.taxAmount).toFixed(2)}</td>
                  <td className="code">{line.conditionNumber}</td>
                  <td>{line.status}{line.rejectionReason ? ` (${line.rejectionReason})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-ink-faint">
            Confirmed is what the check would promise today. It is not a reservation: another quotation or
            order can be promised the same stock.
          </p>

          {canCreate && open ? (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <form action={changeAction} className="space-y-2">
                <h3 className="text-sm font-semibold">Change the quotation</h3>
                <Notice state={changeState} />
                <input type="hidden" name="quotationNumber" value={selected.quotationNumber} />
                <input type="hidden" name="expectedVersion" value={String(selected.version)} />
                <HeaderFields selected={selected} />
                <ItemGrid numbered initialRows={rowsOf(selected)} />
                <label className="block text-xs text-ink-soft">
                  Items to reject, as item=reason (for example 20=PRCE, 30=STCK)
                  <input className="input mt-1" name="rejectLines" autoComplete="off" placeholder="20=PRCE" />
                </label>
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Save changes</button>
              </form>
              <div className="space-y-4">
                <form action={rejectAction} className="space-y-2">
                  <h3 className="text-sm font-semibold">Reject the quotation</h3>
                  <p className="text-xs text-ink-soft">A rejection names a reason code of up to four characters. Version {selected.version}.</p>
                  <Notice state={rejectState} />
                  <input type="hidden" name="quotationNumber" value={selected.quotationNumber} />
                  <input type="hidden" name="expectedVersion" value={String(selected.version)} />
                  <input className="input" name="rejectReason" maxLength={4} placeholder="Reason code" autoComplete="off" />
                  <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Reject quotation</button>
                </form>
                {canRaiseOrder ? (
                  <form action={copyAction} className="space-y-2">
                    <h3 className="text-sm font-semibold">Raise a sales order</h3>
                    <p className="text-xs text-ink-soft">
                      The order is created by the order service, priced on the order date and judged for
                      credit there. It names this quotation.
                    </p>
                    <Notice state={copyState} />
                    <input type="hidden" name="quotationNumber" value={selected.quotationNumber} />
                    <input type="hidden" name="expectedVersion" value={String(selected.version)} />
                    <input type="hidden" name="requestKey" value={`SQO-${selected.quotationNumber}-${selected.version}-${selected.ordersRaised.length}`} />
                    <label className="block text-xs text-ink-soft">Order date
                      <input className="input mt-1" name="orderDate" defaultValue={today} placeholder="YYYY-MM-DD" />
                    </label>
                    <label className="block text-xs text-ink-soft">Requested date
                      <input className="input mt-1" name="requestedDate" defaultValue={selected.requestedDate ?? ''} placeholder="YYYY-MM-DD" />
                    </label>
                    <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={selected.isExpired}>Raise order</button>
                  </form>
                ) : (
                  <p className="text-xs text-ink-soft">Raising an order also needs SALES.ORDER.CREATE.</p>
                )}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {canCreate && !selected ? (
        <form action={createAction} className="panel space-y-3 p-4" aria-label="Create sales quotation">
          <h2 className="text-lg font-semibold">Create sales quotation</h2>
          <Notice state={createState} />
          <HeaderFields selected={null} />
          <ItemGrid numbered={false} />
          <input type="hidden" name="requestKey" value={`SQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`} />
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Create quotation</button>
        </form>
      ) : null}

      <section className="panel p-4" aria-label="Sales quotations">
        <h2 className="text-lg font-semibold">Sales quotations</h2>
        <table className="grid-table mt-2 text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th>Quotation</th><th>Customer</th><th>Date</th><th>Valid to</th><th>Status</th>
              <th className="text-right">Gross value</th><th>Orders</th>
            </tr>
          </thead>
          <tbody>
            {documents.length === 0 ? (
              <tr><td colSpan={7} className="text-ink-soft">No sales quotation stands in this tenant yet.</td></tr>
            ) : documents.map((row) => (
              <tr key={row.quotationNumber}>
                <td><Link className="link" href={`/sales/quotations?quotation=${row.quotationNumber}`}>{row.quotationNumber}</Link></td>
                <td>{row.customerNumber}</td>
                <td>{row.quotationDate}</td>
                <td>{row.validTo}</td>
                <td>{row.status}{row.isExpired ? ' · expired' : ''}</td>
                <td className="text-right">{money(row.grossValue, row.currency)}</td>
                <td>{row.ordersRaised.length ? row.ordersRaised.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

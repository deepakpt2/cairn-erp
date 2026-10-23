import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { CONTRACT_MAINTAIN_CAPABILITY } from '@/modules/purchasing/contract';
import {
  CONTRACT_DISPLAY_CAPABILITY,
  CONTRACT_DISPLAY_ROUTE,
  openPurchaseContractDisplay,
} from '@/modules/purchasing/contract-display';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/**
 * ME33K. This page has no save action. A display user and a change user
 * both read the same contract. Neither path writes from here.
 */
export default async function PurchaseContractDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(CONTRACT_DISPLAY_ROUTE);
  const canDisplay = can(session, CONTRACT_DISPLAY_CAPABILITY) || can(session, CONTRACT_MAINTAIN_CAPABILITY);
  if (!canDisplay) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display purchase contract</h1>
        <p className="mt-2 text-sm">You do not hold the purchase-contract display capability (PROC.CONTRACT.DISPLAY).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const params = {
    contract: last(raw.contract),
    supplier: last(raw.supplier),
    documentType: last(raw.documentType),
    save: last(raw.save),
    price: last(raw.price),
    netPrice: last(raw.netPrice),
    release: last(raw.release),
    output: last(raw.output),
    condition: last(raw.condition),
    stock: last(raw.stock),
    delete: last(raw.delete),
    targetQuantity: last(raw.targetQuantity),
    items: last(raw.items),
    changedBy: last(raw.changedBy),
  };
  const opened = await openPurchaseContractDisplay(session.user.client, params);
  const document = opened.document;
  const canChange = can(session, CONTRACT_MAINTAIN_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.CONTRACT.DISPLAY · ME33K</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Display purchase contract</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          ME33K reads the contract. It does not save, release, reprice, receive goods, or post accounting. Called-off, remaining, goods receipt, and invoice are separate figures.
        </p>
      </header>

      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Contract</span>
          <input className="input" name="contract" defaultValue={params.contract} maxLength={20} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Supplier</span>
          <input className="input" name="supplier" defaultValue={params.supplier} maxLength={40} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Type</span>
          <input className="input" name="documentType" defaultValue={params.documentType} maxLength={4} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Display</button>
      </form>

      {opened.refusal && (
        <p className="text-sm text-danger" role="alert">{opened.refusal.message} {opened.refusal.remedy ?? ''}</p>
      )}

      {document && (
        <section className="space-y-3 text-sm" data-contract-display>
          <h2 className="font-semibold" data-contract-number>{document.contractNumber}</h2>
          <p data-contract-readonly>This display wrote nothing.</p>
          <p>
            {document.documentType} · {document.category} · {document.supplierNumber} · {document.companyCode} · {document.currency}
          </p>
          <p>
            Valid {document.validityStart} – {document.validityEnd}. Target {document.targetValue ?? '—'}. Called-off {document.calledOffValue}. Remaining {document.remainingValue ?? 'not a value commitment'}. Release {document.releaseStatus}.
          </p>
          <table className="w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-2">Item</th>
                <th className="px-2 py-2">Text</th>
                <th className="px-2 py-2">Target qty</th>
                <th className="px-2 py-2">Price</th>
                <th className="px-2 py-2">Called-off</th>
                <th className="px-2 py-2">Remaining</th>
                <th className="px-2 py-2">Goods receipt</th>
                <th className="px-2 py-2">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {document.items.map((item) => (
                <tr key={item.itemNumber} className="border-b">
                  <td className="px-2 py-2">{item.itemNumber}</td>
                  <td className="px-2 py-2">{item.shortText}</td>
                  <td className="px-2 py-2">{item.targetQuantity ?? '—'}</td>
                  <td className="px-2 py-2">{item.netPrice}</td>
                  <td className="px-2 py-2">{item.calledOffQuantity}</td>
                  <td className="px-2 py-2">{item.remainingQuantity ?? '—'}</td>
                  <td className="px-2 py-2">{item.goodsReceiptQuantity}</td>
                  <td className="px-2 py-2">{item.invoiceValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canChange && (
            <Link className="underline" href={`/purchasing/contracts?contract=${encodeURIComponent(document.contractNumber)}`}>
              ME32K change
            </Link>
          )}
          <h3 className="font-semibold">Change history</h3>
          {opened.history.length === 0 && <p className="text-ink-soft">No field change stands.</p>}
          {opened.history.map((entry) => (
            <div key={`${entry.changedAt}-${entry.changeType}`} className="border-b py-2">
              <p>{entry.changeType} · {entry.transactionCode ?? '—'} · {entry.changedBy} · {entry.changedAt}</p>
              {entry.items.map((item) => (
                <p key={item.fieldName}>{item.fieldName}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}</p>
              ))}
            </div>
          ))}
        </section>
      )}

      {!document && opened.rows.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-2 py-2">Contract</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">Validity</th>
              <th className="px-2 py-2">Release</th>
            </tr>
          </thead>
          <tbody>
            {opened.rows.map((row) => (
              <tr key={row.contractNumber} className="border-b">
                <td className="px-2 py-2">
                  <Link className="underline" href={`${CONTRACT_DISPLAY_ROUTE}?contract=${encodeURIComponent(row.contractNumber)}`}>{row.contractNumber}</Link>
                </td>
                <td className="px-2 py-2">{row.documentType}</td>
                <td className="px-2 py-2">{row.supplierNumber}</td>
                <td className="px-2 py-2">{row.validityStart} – {row.validityEnd}</td>
                <td className="px-2 py-2">{row.releaseStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

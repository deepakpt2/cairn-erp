import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY } from '@/modules/purchasing/scheduling-agreement';
import {
  SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY,
  SCHEDULING_AGREEMENT_DISPLAY_ROUTE,
  openSchedulingAgreementDisplay,
} from '@/modules/purchasing/scheduling-agreement-display';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** ME33L. This page has no save action and takes no change lock. */
export default async function SchedulingAgreementDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(SCHEDULING_AGREEMENT_DISPLAY_ROUTE);
  const canDisplay = can(session, SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY) || can(session, SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY);
  if (!canDisplay) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display scheduling agreement</h1>
        <p className="mt-2 text-sm">You do not hold the scheduling-agreement display capability (PROC.SCHEDAGREE.DISPLAY).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const params = {
    agreement: last(raw.agreement),
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
    scheduleLine: last(raw.scheduleLine),
    exchangeRate: last(raw.exchangeRate),
    firmZone: last(raw.firmZone),
    centralContract: last(raw.centralContract),
  };
  const opened = await openSchedulingAgreementDisplay(session.user.client, params);
  const document = opened.document;
  const canChange = can(session, SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.SCHEDAGREE.DISPLAY · ME33L</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Display scheduling agreement</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          ME33L reads the scheduling agreement. It does not save, release, reprice, create a schedule line, receive goods, or post accounting. A scheduled quantity is not a goods receipt.
        </p>
      </header>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Agreement</span>
          <input className="input" name="agreement" defaultValue={params.agreement} maxLength={20} />
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
        <section className="space-y-3 text-sm" data-agreement-display>
          <h2 className="font-semibold" data-agreement-number>{document.agreementNumber}</h2>
          <p data-agreement-readonly>This display wrote nothing.</p>
          <p>
            {document.documentType} · {document.supplierNumber} · {document.companyCode} · {document.currency} · Release {document.releaseStatus}
          </p>
          <p>Valid {document.validityStart} – {document.validityEnd}.</p>
          <table className="w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-2">Item</th>
                <th className="px-2 py-2">Text</th>
                <th className="px-2 py-2">Target</th>
                <th className="px-2 py-2">Price</th>
                <th className="px-2 py-2">Scheduled</th>
                <th className="px-2 py-2">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {document.items.map((item) => (
                <tr key={item.itemNumber} className="border-b">
                  <td className="px-2 py-2">{item.itemNumber}</td>
                  <td className="px-2 py-2">{item.shortText}</td>
                  <td className="px-2 py-2">{item.targetQuantity} {item.unit}</td>
                  <td className="px-2 py-2">{item.netPrice}</td>
                  <td className="px-2 py-2">{item.scheduledQuantity}</td>
                  <td className="px-2 py-2">{item.remainingQuantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="font-semibold">Delivery schedule</h3>
          {document.scheduleLines.length === 0 && <p className="text-ink-soft">No delivery schedule line stands. ME38 maintains schedule lines. This display does not create one.</p>}
          {document.scheduleLines.map((line) => (
            <p key={`${line.itemNumber}-${line.lineNumber}`}>Item {line.itemNumber} line {line.lineNumber}: {line.quantity} on {line.deliveryDate}</p>
          ))}
          {canChange && (
            <Link className="underline" href={`/purchasing/scheduling-agreements?agreement=${encodeURIComponent(document.agreementNumber)}`}>ME32L change</Link>
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
              <th className="px-2 py-2">Agreement</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Supplier</th>
              <th className="px-2 py-2">Validity</th>
              <th className="px-2 py-2">Release</th>
            </tr>
          </thead>
          <tbody>
            {opened.rows.map((row) => (
              <tr key={row.agreementNumber} className="border-b">
                <td className="px-2 py-2">
                  <Link className="underline" href={`${SCHEDULING_AGREEMENT_DISPLAY_ROUTE}?agreement=${encodeURIComponent(row.agreementNumber)}`}>{row.agreementNumber}</Link>
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

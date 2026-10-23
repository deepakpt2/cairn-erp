import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  SCHEDULE_DISPLAY_CAPABILITY,
  SCHEDULE_MAINTAIN_CAPABILITY,
} from '@/modules/purchasing/scheduling-agreement-schedule';
import {
  SCHEDULE_DISPLAY_ROUTE,
  openDeliveryScheduleDisplay,
} from '@/modules/purchasing/scheduling-agreement-schedule-display';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** ME39. No save action and no change lock. */
export default async function DeliveryScheduleDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(SCHEDULE_DISPLAY_ROUTE);
  const allowed = can(session, SCHEDULE_DISPLAY_CAPABILITY) || can(session, SCHEDULE_MAINTAIN_CAPABILITY);
  if (!allowed) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display delivery schedule</h1>
        <p className="mt-2 text-sm">You do not hold the delivery-schedule display capability (PROC.SCHEDLINE.DISPLAY).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const params = {
    agreement: last(raw.agreement),
    item: last(raw.item),
    save: last(raw.save),
    quantity: last(raw.quantity),
    price: last(raw.price),
    release: last(raw.release),
    output: last(raw.output),
    fixed: last(raw.fixed),
    firmZone: last(raw.firmZone),
    mrp: last(raw.mrp),
    stock: last(raw.stock),
  };
  const opened = await openDeliveryScheduleDisplay(session.user.client, params);
  const document = opened.document;
  const canChange = can(session, SCHEDULE_MAINTAIN_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.SCHEDLINE.DISPLAY · ME39</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Display delivery schedule</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          ME39 reads delivery schedule lines. It does not save, fix a line, run MRP, post a goods receipt, or send a supplier release.
        </p>
      </header>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Agreement</span>
          <input className="input" name="agreement" defaultValue={params.agreement} maxLength={20} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Item</span>
          <input className="input w-24" name="item" defaultValue={params.item} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Display</button>
      </form>
      {opened.refusal && <p className="text-sm text-danger" role="alert">{opened.refusal.message} {opened.refusal.remedy ?? ''}</p>}
      {document && (
        <section className="space-y-3 text-sm" data-schedule-display>
          <h2 className="font-semibold">{document.agreementNumber}</h2>
          <p data-schedule-readonly>This display wrote nothing.</p>
          <p>{document.supplierNumber} · {document.purchasingOrg} · {document.companyCode} · Valid {document.validityStart} – {document.validityEnd}. Release {document.releaseStatus}.</p>
          <p>A goods receipt is not linked to these lines. A scheduled quantity is not a receipt.</p>
          <table className="w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-2">Item</th>
                <th className="px-2 py-2">Line</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Quantity</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {document.scheduleLines.map((line) => (
                <tr key={`${line.itemNumber}-${line.lineNumber}`} className="border-b">
                  <td className="px-2 py-2">{line.itemNumber}</td>
                  <td className="px-2 py-2">{line.lineNumber}</td>
                  <td className="px-2 py-2">{line.deliveryDate}</td>
                  <td className="px-2 py-2">{line.quantity} {line.unit ?? ''}</td>
                  <td className="px-2 py-2">{line.markedForDeletion ? 'Cancelled' : 'Open'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {document.scheduleLines.length === 0 && <p className="text-ink-soft">No delivery schedule line stands.</p>}
          {canChange && (
            <Link className="underline" href={`/purchasing/delivery-schedule?agreement=${encodeURIComponent(document.agreementNumber)}${params.item ? `&item=${encodeURIComponent(params.item)}` : ''}`}>ME38 change</Link>
          )}
        </section>
      )}
    </main>
  );
}

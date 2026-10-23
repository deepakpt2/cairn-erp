import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import {
  SCHEDULE_MAINTAIN_CAPABILITY,
  SCHEDULE_ROUTE,
  readDeliverySchedule,
} from '@/modules/purchasing/scheduling-agreement-schedule';
import ScheduleForm from './ScheduleForm';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** ME38. Delivery schedule lines only. This is not ME32L, ME39, or ME84. */
export default async function DeliverySchedulePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(SCHEDULE_ROUTE);
  if (!can(session, SCHEDULE_MAINTAIN_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Delivery schedule</h1>
        <p className="mt-2 text-sm">You do not hold the delivery-schedule maintain capability (PROC.SCHEDLINE.MAINTAIN).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const agreement = last(raw.agreement);
  const itemText = last(raw.item);
  const itemNumber = itemText ? Number(itemText) : undefined;
  const document = agreement ? await readDeliverySchedule(session.user.client, agreement, itemNumber) : null;
  const selectedItem = itemNumber && document?.items.some((item) => item.itemNumber === itemNumber)
    ? itemNumber
    : document?.items.length === 1 ? document.items[0].itemNumber : undefined;
  const changeLock = document
    ? await openChangeForSession(session, {
        lockObject: 'SCHEDULING_AGREEMENT',
        argument: document.agreementNumber,
        transactionCode: 'ME38',
      })
    : null;

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROC.SCHEDLINE.MAINTAIN · ME38</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Maintain delivery schedule</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          ME38 maintains delivery schedule lines for an existing scheduling agreement. It does not change the agreement header, create a purchase order, post a goods receipt, or send a supplier release. ME39 displays the lines and does not save.
        </p>
      </header>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Agreement</span>
          <input className="input" name="agreement" defaultValue={agreement} maxLength={20} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Item</span>
          <input className="input w-24" name="item" defaultValue={itemText} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Open</button>
      </form>
      {agreement && !document && <p className="text-sm text-red-700" role="alert">Scheduling agreement {agreement} does not exist.</p>}
      {document && itemText && document.items.length === 0 && <p className="text-sm text-red-700" role="alert">Item {itemText} does not belong to this agreement.</p>}
      {document && (
        <section className="space-y-2 text-sm">
          <p>
            {document.agreementNumber} · {document.documentType} · {document.supplierNumber} · {document.purchasingOrg} · {document.purchasingGroup} · {document.companyCode} · {document.currency}
          </p>
          <p>Valid {document.validityStart} – {document.validityEnd}. Release {document.releaseStatus}.</p>
          <p>
            <Link className="underline" href={`/purchasing/scheduling-agreements?agreement=${encodeURIComponent(document.agreementNumber)}`}>ME32L agreement</Link>
            {' · '}
            <Link className="underline" href={`/purchasing/delivery-schedule-display?agreement=${encodeURIComponent(document.agreementNumber)}${selectedItem ? `&item=${selectedItem}` : ''}`}>ME39 display</Link>
          </p>
          {document.items.length > 1 && !selectedItem && (
            <ul>
              {document.items.map((item) => (
                <li key={item.itemNumber}>
                  <Link className="underline" href={`${SCHEDULE_ROUTE}?agreement=${encodeURIComponent(document.agreementNumber)}&item=${item.itemNumber}`}>Item {item.itemNumber} · {item.shortText}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {changeLock?.mode === 'DISPLAY' && <p className="text-sm text-ink-soft">{displayOnlyMessage(changeLock)}</p>}
      {changeLock?.mode === 'CHANGE' && document && (
        <ChangeLock lockObject="SCHEDULING_AGREEMENT" argument={document.agreementNumber} />
      )}
      {document && selectedItem && changeLock?.mode !== 'DISPLAY' && (
        <ScheduleForm document={document} itemNumber={selectedItem} />
      )}
    </main>
  );
}

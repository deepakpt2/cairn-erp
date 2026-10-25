import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  TIME_TICKET_CAPABILITY,
  TIME_TICKET_ROUTE,
  TimeTicketError,
  loadTimeTicket,
  timeTicketRefusal,
} from '@/modules/production/time-ticket';
import TimeTicketWorkbench from './TimeTicketWorkbench';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function TimeTicketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(TIME_TICKET_ROUTE);
  const params = await searchParams;
  const refusal = timeTicketRefusal({
    confirmationProfile: one(params.confirmationProfile),
    automatic: one(params.automatic),
    sequence: one(params.sequence),
    suboperation: one(params.suboperation),
    personnel: one(params.personnel),
    backflush: one(params.backflush),
    automaticGoodsReceipt: one(params.automaticGoodsReceipt),
    co13: one(params.co13),
    co15: one(params.co15),
    cost: one(params.cost),
  });
  const orderNumber = one(params.order);
  let loaded = null;
  let openError = refusal ?? '';
  if (!refusal && orderNumber && can(session, TIME_TICKET_CAPABILITY)) {
    try {
      loaded = await loadTimeTicket(session.user.client, {
        orderNumber,
        operationNumber: one(params.operation),
        productionVersion: one(params.version),
        postingDate: one(params.postingDate),
      });
    } catch (error) {
      openError = error instanceof TimeTicketError ? error.message : 'The order could not be read.';
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.CONFIRM.ENTER · CO11N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Enter time ticket</h1>
          <Link href="/production/production-order-display" className="btn btn-default min-h-11 sm:min-h-8">CO03</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Confirm one operation of a released production order. A check writes nothing.
          A posted confirmation is not edited here. The order status is not changed.
          A movement follows the marks on the material, and it posts with the confirmation.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft" data-co11n-gaps>
          The operation is the one stored on the order. A later routing edit is not read. A confirmation profile, automatic confirmation, backflush, automatic goods receipt, and personnel are not this screen. Cancellation is CO13. CO14 is not implemented. CO15 confirms the order, not one operation.
        </p>
      </header>
      {openError && <p role="status" data-co11n-refused className="text-sm text-red-700">{openError}</p>}
      {!can(session, TIME_TICKET_CAPABILITY) && (
        <p className="text-sm">You do not hold the confirmation capability ({TIME_TICKET_CAPABILITY}).</p>
      )}
      <form className="grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Production order" required />
        <input className="input" name="operation" defaultValue={one(params.operation)} maxLength={4} placeholder="Operation" />
        <input className="input" name="version" defaultValue={one(params.version)} maxLength={4} placeholder="Production version" />
        <button className="btn" type="submit">Open</button>
      </form>
      {loaded && (
        <TimeTicketWorkbench
          canConfirm={can(session, TIME_TICKET_CAPABILITY)}
          loaded={loaded}
        />
      )}
    </div>
  );
}

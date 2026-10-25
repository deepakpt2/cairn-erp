import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  CONFIRMATION_CANCEL_CAPABILITY,
  CONFIRMATION_CANCEL_ROUTE,
  ConfirmationCancelError,
  holdsConfirmationCancelAuthority,
  loadConfirmationCancellation,
} from '@/modules/production/confirmation-cancel';
import ConfirmationCancelWorkbench from './ConfirmationCancelWorkbench';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

export default async function ConfirmationCancelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(CONFIRMATION_CANCEL_ROUTE);
  const params = await searchParams;
  const confirmationNumber = one(params.confirmation).toUpperCase();
  const orderNumber = one(params.order).toUpperCase();
  const allowed = can(session, CONFIRMATION_CANCEL_CAPABILITY);
  let loaded = null;
  let openError = '';
  if (allowed && (confirmationNumber || orderNumber)) {
    try {
      loaded = await loadConfirmationCancellation(session.user.client, {
        confirmationNumber,
        orderNumber,
        capabilities: session.user.capabilities,
      });
    } catch (error) {
      openError = error instanceof ConfirmationCancelError ? error.message : 'The confirmation could not be read.';
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.CONFIRM.CANCEL · CO13</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Cancel production order confirmation</h1>
          <Link href="/production/production-order-display" className="btn btn-default min-h-11 sm:min-h-8">CO03</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Cancel one posted confirmation. Load reads. It does not change the confirmation.
          The original quantities stay as posted. No goods movement is posted.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft" data-co13-gaps>
          A time event is not stored. CO14 is not this screen. A material document posted in MIGO is not reversed here.
        </p>
      </header>
      {openError && <p role="status" data-co13-refused className="text-sm text-red-700">{openError}</p>}
      {!allowed && (
        <p className="text-sm">You do not hold the authority {CONFIRMATION_CANCEL_CAPABILITY}.</p>
      )}
      <form className="grid gap-2 sm:grid-cols-3" method="get">
        <input className="input" name="confirmation" defaultValue={confirmationNumber} maxLength={12} placeholder="Confirmation number" />
        <input className="input" name="order" defaultValue={orderNumber} maxLength={12} placeholder="Order, to list confirmations" />
        <button className="btn" type="submit">Load</button>
      </form>
      {loaded?.warning && <p className="text-sm text-ink-soft" data-co13-warning>{loaded.warning}</p>}
      {loaded && loaded.matches.length > 0 && (
        <ul className="text-sm" data-co13-list>
          {loaded.matches.map((row) => (
            <li key={row.confirmationNumber}>
              <Link href={`${CONFIRMATION_CANCEL_ROUTE}?confirmation=${encodeURIComponent(row.confirmationNumber)}`}>{row.confirmationNumber}</Link>
              {' · '}{row.confirmationLevel === 'HEADER' ? 'header' : `operation ${row.operationNumber}`}
              {' · '}{row.confirmationType} · yield {row.yieldQuantity} {row.unit}
              {row.cancelled ? ` · cancelled by ${row.cancellationNumber}` : ' · not cancelled'}
            </li>
          ))}
        </ul>
      )}
      {loaded && !loaded.detail && loaded.matches.length === 0 && !openError && (
        <p className="text-sm">No confirmation stands on this order.</p>
      )}
      {loaded?.detail && (
        <ConfirmationCancelWorkbench
          canCancel={holdsConfirmationCancelAuthority(session.user.capabilities)}
          detail={loaded.detail}
        />
      )}
    </div>
  );
}

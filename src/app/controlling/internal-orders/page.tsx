import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { ChangeLock } from '@/ui/lock/ChangeLock';
import {
  getInternalOrder,
  internalOrderChoices,
  INTERNAL_ORDER_MAINTAIN_CAPABILITY,
  INTERNAL_ORDER_ROUTE,
  listInternalOrders,
} from '@/modules/foundation/internal-order';
import OrderForm from './OrderForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** KO01 and KO02. Master data only. This is not KO88, KO04, or a posting. */
export default async function InternalOrdersPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(INTERNAL_ORDER_ROUTE);
  if (!can(session, INTERNAL_ORDER_MAINTAIN_CAPABILITY)) {
    return (
      <Page
      title="Internal order" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the internal-order maintain capability (CO.ORDER.MAINTAIN).</p>
      </Page>
    );
  }
  const raw = await searchParams;
  const requested = last(raw.order);
  const creating = last(raw.create) === '1' || !requested;
  const document = requested ? await getInternalOrder(session.user.client, requested) : null;
  const [choices, orders] = await Promise.all([
    internalOrderChoices(session.user.client),
    listInternalOrders(session.user.client),
  ]);
  const changeLock = document
    ? await openChangeForSession(session, {
        lockObject: 'INTERNAL_ORDER',
        argument: document.orderNumber,
        transactionCode: 'KO02',
      })
    : null;

  return (
    <Page
      title="Internal order" code="CO.ORDER.MAINTAIN · KO01 / KO02" width="5xl"
      description="KO01 creates an internal order. KO02 changes one. Neither posts, budgets, plans, nor settles. KO03 displays and does not save. No status profile is configured."
    >
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order</span>
          <input className="input" name="order" defaultValue={requested} maxLength={20} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Open</button>
        <Link className="btn btn-default min-h-11 sm:min-h-8" href={`${INTERNAL_ORDER_ROUTE}?create=1`}>Create</Link>
      </form>
      {requested && !document && <p className="text-sm text-signal-error" role="alert">Internal order {requested} does not exist.</p>}
      {document && (
        <p className="text-sm">
          {document.orderNumber} · {document.orderType} · {document.controllingArea} · {document.companyCode} · {document.currency}
          {' · '}
          <Link className="underline" href={`/controlling/internal-order-display?order=${encodeURIComponent(document.orderNumber)}`}>KO03 display</Link>
        </p>
      )}
      {changeLock?.mode === 'DISPLAY' && <p className="text-sm text-ink-soft">{displayOnlyMessage(changeLock)}</p>}
      {changeLock?.mode === 'CHANGE' && document && (
        <ChangeLock lockObject="INTERNAL_ORDER" argument={document.orderNumber} />
      )}
      {(creating || document) && changeLock?.mode !== 'DISPLAY' && (
        <OrderForm document={document} choices={choices} />
      )}
      {orders.length > 0 && (
        <ul className="text-sm">
          {orders.map((row) => (
            <li key={row.orderNumber}>
              <Link className="underline" href={`${INTERNAL_ORDER_ROUTE}?order=${encodeURIComponent(row.orderNumber)}`}>
                {row.orderNumber} · {row.description}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

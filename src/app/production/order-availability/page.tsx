import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import OrderAvailabilityWorkbench from './OrderAvailabilityWorkbench';
import {
  ORDER_AVAILABILITY_ALIAS,
  ORDER_AVAILABILITY_ELEMENTS_CAPABILITY,
  ORDER_AVAILABILITY_GAPS,
  ORDER_AVAILABILITY_ORDER_CAPABILITY,
  ORDER_AVAILABILITY_ROUTE,
  OrderAvailabilityError,
  holdsOrderAvailabilityAuthority,
  orderAvailabilityRefusal,
  checkOrderAvailability,
  type OrderAvailabilityResult,
} from '@/modules/production/order-availability';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/**
 * CO09 slice 1 — the availability of one production order's components.
 *
 * Computed live on every execution and written nowhere: no status, no commitment, no
 * reservation, no log. The screen refuses rather than answering from a default, so a
 * missing checking control, a missing checking rule on it, a component without a
 * checking group, and a component without a scope of check are shown as the four
 * different refusals they are. The list of what is not modelled stands under the
 * title, because an availability figure that is read as a promise is worse than none.
 */
export default async function OrderAvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ORDER_AVAILABILITY_ROUTE);
  const params = await searchParams;
  const orderNumber = one(params.order).toUpperCase();
  const itemNumber = one(params.item);
  const horizonEnd = one(params.horizonEnd);

  const canCheckOrder = can(session, ORDER_AVAILABILITY_ORDER_CAPABILITY);
  const canReadElements = can(session, ORDER_AVAILABILITY_ELEMENTS_CAPABILITY);
  const canUse = holdsOrderAvailabilityAuthority(session.user.capabilities);
  // A selection that asks for more than slice 1 is refused before anything is read.
  const refusal = orderAvailabilityRefusal({
    storageLocation: one(params.storageLocation),
    batch: one(params.batch),
    specialStock: one(params.specialStock),
    commit: one(params.commit),
    reserve: one(params.reserve),
    post: one(params.post),
    release: one(params.release),
    reset: one(params.reset),
    collective: one(params.collective),
    missingParts: one(params.missingParts),
    rule: one(params.rule),
    scopeOfCheck: one(params.scopeOfCheck),
    mrpArea: one(params.mrpArea),
    allocation: one(params.allocation),
  });

  let result: OrderAvailabilityResult | null = null;
  let serviceError: string | null = refusal;
  if (canUse && orderNumber && !refusal) {
    try {
      result = await checkOrderAvailability({
        client: session.user.client,
        orderNumber,
        itemNumber: itemNumber || null,
        today: new Date().toISOString().slice(0, 10),
        horizonEnd: horizonEnd || null,
      });
    } catch (error) {
      serviceError = error instanceof OrderAvailabilityError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : t('co09.serviceError');
    }
  }

  return (
    <div className="mx-auto max-w-[90rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">
          {ORDER_AVAILABILITY_ORDER_CAPABILITY} + {ORDER_AVAILABILITY_ELEMENTS_CAPABILITY} · {ORDER_AVAILABILITY_ALIAS}
        </span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('co09.title')}</h1>
          <Link href="/production/production-order-display" className="btn btn-default min-h-11 sm:min-h-8">CO03</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('co09.subtitle')}</p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft" data-co09-gaps>
          {t('co09.gapsLead')}
        </p>
        <ul className="mt-1 max-w-3xl list-disc space-y-1 ps-5 text-xs text-ink-faint" data-co09-refusals>
          {ORDER_AVAILABILITY_GAPS.map((gap) => <li key={gap}>{gap}</li>)}
        </ul>
      </header>

      <OrderAvailabilityWorkbench
        canUse={canUse}
        canCheckOrder={canCheckOrder}
        canReadElements={canReadElements}
        orderNumber={orderNumber}
        itemNumber={itemNumber}
        horizonEnd={horizonEnd}
        result={result}
        serviceError={serviceError}
        serviceErrorKind={refusal ? 'unsupported' : 'failure'}
      />
    </div>
  );
}

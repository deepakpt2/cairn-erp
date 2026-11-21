import { randomUUID } from 'node:crypto';

import { can, requireSession } from '@/platform/auth/current';
import {
  PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY,
  PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY,
} from '@/platform/auth/capability-policy';
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
import { LinkButton, Page } from '@/ui/kit';

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
  const today = new Date().toISOString().slice(0, 10);
  const actionMessage = one(params.actionMessage);
  const actionMessageKind = one(params.actionKind) === 'success' ? 'success' : 'error';

  const canCheckOrder = can(session, ORDER_AVAILABILITY_ORDER_CAPABILITY);
  const canReadElements = can(session, ORDER_AVAILABILITY_ELEMENTS_CAPABILITY);
  const canUse = holdsOrderAvailabilityAuthority(session.user.capabilities);
  const canCommit = canUse && can(session, PRODUCTION_ORDER_AVAILABILITY_COMMIT_CAPABILITY);
  const canReset = canCheckOrder && can(session, PRODUCTION_ORDER_AVAILABILITY_RESET_CAPABILITY);
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
        today,
        horizonEnd: horizonEnd || null,
      }, { userId: session.user.userId, sessionId: session.sessionId ?? '' });
    } catch (error) {
      serviceError = error instanceof OrderAvailabilityError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : t('co09.serviceError');
    }
  }

  const requestKeys = Object.fromEntries((result?.components ?? []).map((row) => [row.itemNumber, {
    commit: randomUUID(),
    reset: randomUUID(),
  }]));

  return (
    <Page
      title={t('co09.title')} code={<>
          {ORDER_AVAILABILITY_ORDER_CAPABILITY} + {ORDER_AVAILABILITY_ELEMENTS_CAPABILITY} · {ORDER_AVAILABILITY_ALIAS}
        </>} width="90rem" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('co09.subtitle')}</p>
          <p className="max-w-3xl text-sm text-ink-soft" data-co09-gaps>
              {t('co09.gapsLead')}
            </p>
          <ul className="mt-1 max-w-3xl list-disc space-y-1 ps-5 text-xs text-ink-faint" data-co09-refusals>
              {ORDER_AVAILABILITY_GAPS.map((gap) => <li key={gap}>{gap}</li>)}
            </ul>
        </>
      }
      actions={
        <>
          <LinkButton href="/production/production-order-display">CO03</LinkButton>
        </>
      }
    >

      <OrderAvailabilityWorkbench
        canUse={canUse}
        canCheckOrder={canCheckOrder}
        canReadElements={canReadElements}
        canCommit={canCommit}
        canReset={canReset}
        orderNumber={orderNumber}
        itemNumber={itemNumber}
        horizonEnd={horizonEnd}
        today={today}
        result={result}
        serviceError={serviceError}
        serviceErrorKind={refusal ? 'unsupported' : 'failure'}
        actionMessage={actionMessage}
        actionMessageKind={actionMessageKind}
        requestKeys={requestKeys}
      />
    </Page>
  );
}

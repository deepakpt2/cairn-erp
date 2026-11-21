import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { SALES_ORDER_CAPABILITY } from '@/modules/sales/sales-order';
import {
  SALES_QUOTATION_CAPABILITY,
  SALES_QUOTATION_ROUTE,
  getQuotation,
  listQuotations,
  quotationChoices,
} from '@/modules/sales/quotation';
import { NO_SALES_CHOICES } from '@/modules/sales/sales-order';
import Quotations from './Quotations';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Sales quotations: the list, the document read by `?quotation=`, and the forms, on one screen as the
 * order screen does. A quotation is an answer, not a commitment.
 */
export default async function SalesQuotationsPage({ searchParams }: {
  searchParams: Promise<{ quotation?: string; customer?: string }>;
}) {
  const session = await requireSession(SALES_QUOTATION_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };
  const [documents, choices, selected] = await Promise.all([
    listQuotations(client, params.customer ? { customerNumber: params.customer } : {}, authorization).catch(() => []),
    quotationChoices(client, authorization).catch(() => NO_SALES_CHOICES),
    params.quotation ? getQuotation(client, params.quotation.trim(), authorization).catch(() => null) : Promise.resolve(null),
  ]);

  return (
    <Page
      title="Sales quotations" code={SALES_QUOTATION_CAPABILITY}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              A quotation is an answer given before the customer commits. It consumes no availability, it
              creates no receivable, and it is not judged for credit. It holds until its valid-to date, and an
              order is raised from it at <Link className="link" href="/sales/orders">/sales/orders</Link> —
              priced and credit-checked on the day that order is raised.
            </p>
        </>
      }
    >
      <Quotations
        documents={documents}
        choices={choices}
        selected={selected}
        canCreate={can(session, SALES_QUOTATION_CAPABILITY)}
        canRaiseOrder={can(session, SALES_ORDER_CAPABILITY)}
      />
    </Page>
  );
}

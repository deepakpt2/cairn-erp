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
import Quotations from './Quotations';

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
  const [documents, choices, selected] = await Promise.all([
    listQuotations(client, params.customer ? { customerNumber: params.customer } : {}),
    quotationChoices(client),
    params.quotation ? getQuotation(client, params.quotation.trim()) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SALES_QUOTATION_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Sales quotations</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A quotation is an answer given before the customer commits. It consumes no availability, it
          creates no receivable, and it is not judged for credit. It holds until its valid-to date, and an
          order is raised from it at <Link className="link" href="/sales/orders">/sales/orders</Link> —
          priced and credit-checked on the day that order is raised.
        </p>
      </header>
      <Quotations
        documents={documents}
        choices={choices}
        selected={selected}
        canCreate={can(session, SALES_QUOTATION_CAPABILITY)}
        canRaiseOrder={can(session, SALES_ORDER_CAPABILITY)}
      />
    </div>
  );
}

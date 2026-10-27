import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  BILLING_CANCEL_CAPABILITY,
  BILLING_CAPABILITY,
  BILLING_ROUTE,
  getBilling,
  listBillableDeliveries,
  listBillings,
  salesDocumentFlow,
} from '@/modules/sales/billing';
import Billing from './Billing';

export const dynamic = 'force-dynamic';

/**
 * The billing document a goods-issued delivery earns, and the receivable it raises.
 *
 * This screen prices nothing and posts no journal of its own: the quantity is what the movement took out of the
 * plant, the price and the condition record are the order line's, and the invoice is raised by the accounting
 * service that owns the customer's open items, the due date and the tax. What this screen owns is the link —
 * order, delivery, material document, billing document, invoice — and the rule that a delivered line is billed
 * once.
 */
export default async function SalesBillingPage({ searchParams }: {
  searchParams: Promise<{ billing?: string; delivery?: string; customer?: string }>;
}) {
  const session = await requireSession(BILLING_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const billingNumber = (params.billing ?? '').trim().toUpperCase();
  const deliveryNumber = (params.delivery ?? '').trim().toUpperCase();
  const customerNumber = (params.customer ?? '').trim().toUpperCase();
  const [billable, documents, selected] = await Promise.all([
    listBillableDeliveries(client, { deliveryNumber: deliveryNumber || undefined, customerNumber: customerNumber || undefined }),
    listBillings(client, customerNumber ? { customerNumber } : {}),
    billingNumber ? getBilling(client, billingNumber) : Promise.resolve(null),
  ]);
  const flow = selected ? await salesDocumentFlow(client, selected.orderNumber) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{BILLING_CAPABILITY} · {BILLING_CANCEL_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Billing documents</h1>
          <div className="flex gap-2">
            <Link href="/sales/delivery" className="btn btn-default min-h-11 sm:min-h-8">Deliveries</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A billing document is created from the quantity a goods issue actually moved. It quotes the price the
          order line was priced at, from the condition record named on it, and it posts the receivable through
          the accounting-invoice service. A delivery is billed once.
        </p>
      </header>
      <Billing
        billable={billable}
        documents={documents}
        selected={selected}
        flow={flow}
        deliveryNumber={deliveryNumber}
        canCreate={can(session, BILLING_CAPABILITY)}
        canCancel={can(session, BILLING_CANCEL_CAPABILITY)}
      />
    </div>
  );
}


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
import { listBillablePlanDates } from '@/modules/sales/billing-plan';
import { orderDownPayments } from '@/modules/sales/down-payment';
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
  searchParams: Promise<{ billing?: string; delivery?: string; customer?: string; order?: string }>;
}) {
  const session = await requireSession(BILLING_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const billingNumber = (params.billing ?? '').trim().toUpperCase();
  const deliveryNumber = (params.delivery ?? '').trim().toUpperCase();
  const customerNumber = (params.customer ?? '').trim().toUpperCase();
  const orderNumber = (params.order ?? '').trim().toUpperCase();
  const [billable, planDates, documents, selected] = await Promise.all([
    listBillableDeliveries(client, { deliveryNumber: deliveryNumber || undefined, customerNumber: customerNumber || undefined }),
    listBillablePlanDates(client, {
      ...(customerNumber ? { customerNumber } : {}),
      ...(orderNumber ? { orderNumber } : {}),
    }),
    listBillings(client, customerNumber ? { customerNumber } : {}),
    billingNumber ? getBilling(client, billingNumber) : Promise.resolve(null),
  ]);
  const flow = selected ? await salesDocumentFlow(client, selected.orderNumber) : [];
  // What the customer was asked to pay in advance on this order, and what of it arrived: the register
  // beside the document that will consume it.
  const advances = selected
    ? await orderDownPayments(client, selected.orderNumber)
    : [];

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
          A billing document is created from the quantity a goods issue actually moved, or from the date of a
          billing plan whose day has come. Either way it quotes the price the order line was priced at, from
          the condition record named on it, and posts the receivable through the accounting-invoice service. A
          delivery is billed once, and so is a plan date.
        </p>
      </header>
      <Billing
        billable={billable}
        planDates={planDates}
        documents={documents}
        selected={selected}
        flow={flow}
        advances={advances}
        deliveryNumber={deliveryNumber}
        canCreate={can(session, BILLING_CAPABILITY)}
        canCancel={can(session, BILLING_CANCEL_CAPABILITY)}
      />
    </div>
  );
}


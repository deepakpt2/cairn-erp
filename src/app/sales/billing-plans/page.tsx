import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  BILLING_PLAN_CAPABILITY,
  BILLING_PLAN_ROUTE,
  getBillingPlan,
  listBillingPlans,
  planTypeChoices,
} from '@/modules/sales/billing-plan';
import BillingPlans from './BillingPlans';

export const dynamic = 'force-dynamic';

/**
 * When an item is billed — the billing plan.
 *
 * A delivery earns an invoice when its goods go out, and until now that was the only way this package
 * billed anything. It is the right answer for goods and no answer at all for a year of maintenance, a
 * piece of work paid in three stages, or a licence renewed every quarter: none of them is delivered.
 *
 * A plan hangs off the order item and is made of dates, each carrying a share of the item's value and
 * the day it falls due. It is not a reminder and not a report — the plan *is* the billing schedule, and
 * an item that carries one is billed by its dates and not by its deliveries. The two are never both:
 * a share of an item and the whole of it are two answers to one question, and an order that answered
 * it twice would invoice the same value twice.
 */
export default async function SalesBillingPlansPage({ searchParams }: {
  searchParams: Promise<{ order?: string; item?: string; customer?: string }>;
}) {
  const session = await requireSession(BILLING_PLAN_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const orderNumber = (params.order ?? '').trim().toUpperCase();
  const item = (params.item ?? '').trim();
  const orderLineNumber = item ? Number(item) : null;
  const customerNumber = (params.customer ?? '').trim().toUpperCase();
  const [plans, types, selected] = await Promise.all([
    listBillingPlans(client, {
      ...(orderNumber ? { orderNumber } : {}),
      ...(customerNumber ? { customerNumber } : {}),
    }),
    planTypeChoices(client),
    orderNumber && orderLineNumber ? getBillingPlan(client, orderNumber, orderLineNumber) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{BILLING_PLAN_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Billing plans</h1>
          <div className="flex gap-2">
            <Link href="/sales/billing" className="btn btn-default min-h-11 sm:min-h-8">Billing</Link>
            <Link href="/sales/orders" className="btn btn-default min-h-11 sm:min-h-8">Orders</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A billing plan says when an order item is billed, for the sales that are never delivered: dates
          hanging off the item, each carrying a share of its value. The shares total a hundred, a date is
          billed once and never before its day, and a withdrawn date stays on the record rather than being
          erased.
        </p>
      </header>
      <BillingPlans
        plans={plans}
        types={types}
        selected={selected}
        orderNumber={orderNumber}
        orderLineNumber={orderLineNumber}
        canMaintain={can(session, BILLING_PLAN_CAPABILITY)}
      />
    </div>
  );
}

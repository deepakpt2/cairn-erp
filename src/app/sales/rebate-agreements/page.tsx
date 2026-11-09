import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  REBATE_CAPABILITY,
  REBATE_ROUTE,
  REBATE_SETTLEMENT_CAPABILITY,
  listRebateAgreements,
  rebateConditionTypes,
  rebateRegister,
} from '@/modules/sales/rebate';
import RebateAgreements from './RebateAgreements';

export const dynamic = 'force-dynamic';

/**
 * Rebates — the money that comes back.
 *
 * Every other screen in Sales takes the money: an order at a price, an invoice for what went out, an
 * advance before the goods were built, a credit where the complaint was good. This one is the promise
 * that part of it comes back, and a promise is three acts with time between them.
 *
 * The **agreement** says who it was made to, over what period and priced by what rate, and it is
 * released before it can accrue — a provision nobody authorised is worse than no provision. The
 * **accrual** happens on the day the invoice is posted: the sale earned part of the promise, and the
 * books hear about it then rather than when the money is handed over. The **settlement** pays it out on
 * a credit memo, which releases the provision and credits the customer.
 *
 * What the customer pays on the invoice never changes: the rebate stands beside the price as a
 * statistical condition, shown and never charged, until the settlement gives it back.
 */
export default async function SalesRebateAgreementsPage({ searchParams }: {
  searchParams: Promise<{ agreement?: string; customer?: string }>;
}) {
  const session = await requireSession(REBATE_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const agreementNumber = (params.agreement ?? '').trim().toUpperCase();
  const customerNumber = (params.customer ?? '').trim().toUpperCase();
  const [agreements, types, register] = await Promise.all([
    listRebateAgreements(client, customerNumber ? { customerNumber } : {}),
    rebateConditionTypes(client),
    agreementNumber ? rebateRegister(client, agreementNumber) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{REBATE_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Rebate agreements</h1>
          <div className="flex gap-2">
            <Link href="/sales/billing" className="btn btn-default min-h-11 sm:min-h-8">Billing</Link>
            <Link href="/sales/credit-memo" className="btn btn-default min-h-11 sm:min-h-8">Credit memos</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A rebate agreement is a promise to give a customer part of what they spend back. It accrues only once
          it is released, only inside its dates, and only for the payer and sales area it names — the provision
          is posted with the invoice and released by the settlement, which credits the customer on a credit memo
          of its own.
        </p>
      </header>
      <RebateAgreements
        agreements={agreements}
        types={types}
        register={register}
        canMaintain={can(session, REBATE_CAPABILITY)}
        canSettle={can(session, REBATE_SETTLEMENT_CAPABILITY)}
        today={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}

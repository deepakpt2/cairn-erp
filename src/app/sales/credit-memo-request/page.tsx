import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { listBillings } from '@/modules/sales/billing';
import {
  CREDIT_MEMO_POST_CAPABILITY,
  CREDIT_MEMO_RELEASE_CAPABILITY,
  CREDIT_MEMO_REQUEST_CAPABILITY,
  CREDIT_MEMO_ROUTE,
  listCreditMemoRequests,
} from '@/modules/sales/credit-memo';
import { getSalesOrder } from '@/modules/sales/sales-order';
import CreditMemoRequest from './CreditMemoRequest';

export const dynamic = 'force-dynamic';

/**
 * The complaint desk: what the customer disputes, the release that agrees to it, and the credit.
 *
 * A credit memo is money leaving the company, and the gap this screen closes is not the document — the
 * G2 has stood since 9231 — it is the act between asking and giving. One screen because it is one
 * story, and because each act is bounded by the one before it: the request by what the invoice billed,
 * the release by the request standing held, the credit by what the released request asks for less what
 * has already been credited.
 *
 * The three acts carry three capabilities, and the separation between them is the control rather than
 * a formality: raising the complaint is not agreeing to it, and giving the money away is not the same
 * act as invoicing. Who released a block is written into the change history, so a company that wants
 * the complaint raised by sales and the release given by finance can grant the two codes apart.
 */
export default async function SalesCreditMemoRequestPage({ searchParams }: {
  searchParams: Promise<{ request?: string; customer?: string }>;
}) {
  const session = await requireSession(CREDIT_MEMO_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const requestNumber = (params.request ?? '').trim().toUpperCase();
  const customerNumber = (params.customer ?? '').trim().toUpperCase();
  const [requests, invoices, selected] = await Promise.all([
    listCreditMemoRequests(client, customerNumber ? { customerNumber } : {}),
    listBillings(client, {}),
    requestNumber ? getSalesOrder(client, requestNumber) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">
          {CREDIT_MEMO_REQUEST_CAPABILITY} · {CREDIT_MEMO_RELEASE_CAPABILITY} · {CREDIT_MEMO_POST_CAPABILITY}
        </span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Credit memo requests</h1>
          <div className="flex gap-2">
            <Link href="/sales/billing" className="btn btn-default min-h-11 sm:min-h-8">Billing</Link>
            <Link href="/sales/returns" className="btn btn-default min-h-11 sm:min-h-8">Returns</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A customer asks for money back, and the request is recorded held. Somebody with the authority to
          give it releases the block, and only then is the credit raised — bounded by what the request
          asked for, and priced from the line the goods were invoiced at rather than from today&apos;s price
          list.
        </p>
      </header>
      <CreditMemoRequest
        requests={requests}
        invoices={invoices}
        selected={selected}
        canRaiseRequest={can(session, CREDIT_MEMO_REQUEST_CAPABILITY)}
        canRelease={can(session, CREDIT_MEMO_RELEASE_CAPABILITY)}
        canCredit={can(session, CREDIT_MEMO_POST_CAPABILITY)}
      />
    </div>
  );
}

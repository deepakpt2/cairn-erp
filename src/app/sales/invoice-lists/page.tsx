import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  INVOICE_LIST_CREATE_CAPABILITY,
  INVOICE_LIST_RELEASE_CAPABILITY,
  INVOICE_LIST_ROUTE,
  invoiceListDueDocuments,
  listInvoiceLists,
} from '@/modules/sales/invoice-list';
import { InvoiceLists } from './InvoiceLists';

export const dynamic = 'force-dynamic';

const ROUTE = INVOICE_LIST_ROUTE;

/**
 * The invoice list — SAP's `VF21` to create and `VF24` to release, on one screen because the list and
 * what is waiting for one are one view.
 *
 * The screen prices nothing, posts nothing and numbers nothing: the documents were billed already, and
 * what happens here is that several of them become one document to the customer. The one rule worth
 * reading before pressing anything is that **a document waiting for a list has not been released to
 * accounting** — which is why the queue above and the lists below are the same money, counted once.
 */
export default async function SalesInvoiceListsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const [due, lists] = await Promise.all([
    invoiceListDueDocuments(client),
    listInvoiceLists(client),
  ]);
  const canCreate = can(session, INVOICE_LIST_CREATE_CAPABILITY);
  const canRelease = can(session, INVOICE_LIST_RELEASE_CAPABILITY);

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">
          {INVOICE_LIST_CREATE_CAPABILITY} · {INVOICE_LIST_RELEASE_CAPABILITY} · SD
        </span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Invoice lists</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          One invoice for the period, listing the documents raised inside it. This is not a second
          billing of the same goods — the invoices stand for what was delivered, and the list stands for
          what is owed. It is also not the same act as collective billing:{' '}
          <Link href="/sales/billing" className="link">the billing screen</Link> creates documents from
          what is due, and this one groups documents that exist.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          A document is listed only where <strong>both</strong> halves say so: an invoice-list type on
          its billing type, and a schedule on the <strong>payer</strong> who owes the money. Both are
          read on the day the document is billed and neither is revised afterwards, so a document that
          was listed does not stop being listed because a master changed underneath it.
        </p>
        {!canCreate && !canRelease && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Grouping requires {INVOICE_LIST_CREATE_CAPABILITY} and releasing requires{' '}
            {INVOICE_LIST_RELEASE_CAPABILITY}; broad wildcard role patterns do not grant either.
          </p>
        )}
        {canCreate && !canRelease && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            You may group lists but not release them. Releasing needs{' '}
            {INVOICE_LIST_RELEASE_CAPABILITY}, which is held separately on purpose: whoever assembles
            the month is not automatically who commits the company to a receivable.
          </p>
        )}
      </header>

      <InvoiceLists
        due={due}
        lists={lists}
        canCreate={canCreate}
        canRelease={canRelease}
      />

      <section aria-labelledby="invoice-list-how" className="border border-line bg-surface p-4">
        <h2 id="invoice-list-how" className="text-sm font-semibold">How a document comes to be listed</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Two pieces of configuration, and both are inert until they meet. Maintain an invoice-list type
          on the billing type at{' '}
          <Link href="/config/sales-document-types" className="link">sales document types</Link>, and a
          schedule on the payer at{' '}
          <Link href="/foundation/partners" className="link">business partners</Link>. A tenant that
          maintains neither bills exactly as it did before this screen existed, and every document that
          stands today still does.
        </p>
      </section>
    </main>
  );
}

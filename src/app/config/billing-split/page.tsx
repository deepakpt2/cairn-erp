import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  BILLING_SPLIT_ROUTE,
  SPLIT_DEFINE_CAPABILITY,
  listSplitCriteria,
} from '@/modules/sales/billing';
import { BillingSplit } from './BillingSplit';

export const dynamic = 'force-dynamic';

const ROUTE = BILLING_SPLIT_ROUTE;

export default async function BillingSplitPage() {
  const session = await requireSession(ROUTE);
  const criteria = await listSplitCriteria(session.user.client);
  const canMaintain = can(session, SPLIT_DEFINE_CAPABILITY);
  const maintained = criteria.filter((row) => row.isActive);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SPLIT_DEFINE_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Billing split criteria</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          How many invoices one month&apos;s deliveries become. A collective run groups the billing due list,
          and what it groups <em>by</em> is what stands here: where two deliveries differ in a maintained
          criterion they are billed as two documents, and where they differ in a field no criterion names they
          are billed as one, carrying the value the first delivery of the group had.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          Three criteria always split and are deliberately absent from this screen, because they are not a
          decision: a billing document posts one receivable, against <strong>one payer</strong>, in <strong>one
          currency</strong>, in <strong>one company code</strong>. Two payers on one document would be money
          owed by neither of them.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for {SPLIT_DEFINE_CAPABILITY};
            broad wildcard role patterns do not grant it.
          </p>
        )}
        {maintained.length === 0 && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            No criterion is maintained, so a run raises one invoice per payer, currency and company code —
            one document for everything that payer was sent this month. That is the honest default, and it is
            a month-end run in its own right.
          </p>
        )}
      </header>

      <BillingSplit criteria={criteria} canMaintain={canMaintain} />

      <section aria-labelledby="billing-split-run" className="border border-line bg-surface p-4">
        <h2 id="billing-split-run" className="text-sm font-semibold">What the run does with them</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          The run lives on the billing screen, beside the due list it reads. It shows the groups these
          criteria produce — payer, value, and how many deliveries each group carries — and bills them one
          document at a time. A refusal anywhere in a group fails the whole run rather than billing part of a
          month, and under the same submission key a retry bills only what is still due.
        </p>
        <p className="mt-2">
          <Link href="/sales/billing" className="link">Bill the due list at /sales/billing</Link>
        </p>
      </section>
    </main>
  );
}

import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  SALES_OUTPUT_ADMIN_CAPABILITY,
  SALES_OUTPUT_CAPABILITY,
  SALES_OUTPUT_ROUTE,
  listOutputConditionRecords,
  listSalesOutput,
  salesOutputTypeChoices,
  type SalesOutputCategory,
  type SalesOutputSelection,
} from '@/modules/sales/output';
import SalesOutput from './SalesOutput';

export const dynamic = 'force-dynamic';

/**
 * Output — the document the customer receives.
 *
 * Every other screen in Sales keeps a document. This one hands it over: the confirmation of what was
 * promised, the note that travels with the goods, the invoice that asks for the money. Three things
 * stand behind each of them, and they are the three things the audit said were missing:
 *
 * **Determination** is the condition technique applied to documents — an access sequence read most
 * specific first, so an invoice goes to the payer by e-mail because a record says so and not because a
 * code path happens to render one. **No record, no output** is the rule, which is what makes it a
 * decision rather than a decoration.
 *
 * **The message** is one issue of one output for one document, with the status it reached. It is issued
 * once; a second copy is a new message beside the first, with the reason it was raised.
 *
 * **The rendering is kept with the message**, so a copy asked for a year later is the document as it
 * went out and not a fresh reading of masters that have moved since.
 */
export default async function SalesOutputPage({ searchParams }: {
  searchParams: Promise<{
    documentCategory?: string; documentNumber?: string; outputType?: string;
    transmissionMedium?: string; status?: string; dispatchTime?: string;
  }>;
}) {
  const session = await requireSession(SALES_OUTPUT_ROUTE);
  const params = await searchParams;
  const client = session.user.client;

  const category = (params.documentCategory ?? '').trim().toUpperCase();
  const selection: SalesOutputSelection = {
    ...(category === 'SALES_ORDER' || category === 'DELIVERY' || category === 'BILLING'
      ? { documentCategory: category as SalesOutputCategory } : {}),
    ...(params.documentNumber ? { documentNumber: params.documentNumber.trim().toUpperCase() } : {}),
    ...(params.outputType ? { outputType: params.outputType.trim().toUpperCase() } : {}),
    ...(params.transmissionMedium ? { transmissionMedium: params.transmissionMedium.trim().toUpperCase() } : {}),
    ...(params.status ? { status: params.status.trim().toUpperCase() } : {}),
    ...(params.dispatchTime ? { dispatchTime: params.dispatchTime.trim().toUpperCase() } : {}),
  };

  const [queue, conditions, types] = await Promise.all([
    listSalesOutput({ client, selection }),
    listOutputConditionRecords(client),
    salesOutputTypeChoices(client),
  ]);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SALES_OUTPUT_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Output: what the customer receives</h1>
          <div className="flex gap-2">
            <Link href="/sales/billing" className="btn btn-default min-h-11 sm:min-h-8">Billing</Link>
            <Link href="/sales/delivery" className="btn btn-default min-h-11 sm:min-h-8">Deliveries</Link>
            <Link href="/sales/orders" className="btn btn-default min-h-11 sm:min-h-8">Orders</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          An order confirmation, a delivery note and an invoice: each is an output type, and which of them a
          document earns, by which medium, when and addressed to which of its partners is answered by a
          condition record read most specific first. No record, no output. What is sent is rendered from the
          document as it stands and kept with the message, so a copy read later is the one that went out.
        </p>
      </header>
      <SalesOutput
        rows={queue.rows}
        counts={{
          pending: queue.pending, processed: queue.processed,
          failed: queue.failed, truncated: queue.truncated,
        }}
        conditions={conditions}
        types={types}
        canProcess={can(session, SALES_OUTPUT_CAPABILITY)}
        canAdmin={can(session, SALES_OUTPUT_ADMIN_CAPABILITY)}
        today={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}

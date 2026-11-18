
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
import { letterheadViews } from '@/modules/output/document-layout';
import SalesOutput from './SalesOutput';
import { LinkButton, Page } from '@/ui/kit';

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

  const letterheads = await letterheadViews(client, queue.rows.map((row) => row.companyCode ?? ''));

  return (
    <Page
      title="Output: what the customer receives" code={SALES_OUTPUT_CAPABILITY} width="7xl"
      description="An order confirmation, a delivery note and an invoice: each is an output type, and which of them a document earns, by which medium, when and addressed to which of its partners is answered by a condition record read most specific first. No record, no output. What is sent is rendered from the document as it stands and kept with the message, so a copy read later is the one that went out."
      actions={
        <>
          <LinkButton href="/sales/billing">Billing</LinkButton>
          <LinkButton href="/sales/delivery">Deliveries</LinkButton>
          <LinkButton href="/sales/orders">Orders</LinkButton>
        </>
      }
    >
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
        letterheads={letterheads}
      />
    </Page>
  );
}

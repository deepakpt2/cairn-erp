import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { displayInternalOrder } from '@/modules/foundation/internal-order-display';
import {
  INTERNAL_ORDER_DISPLAY_CAPABILITY,
  InternalOrderError,
  type InternalOrderDocument,
} from '@/modules/foundation/internal-order';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** KO03. Display only. There is no save. */
export default async function InternalOrderDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession('/controlling/internal-order-display');
  if (!can(session, INTERNAL_ORDER_DISPLAY_CAPABILITY)) {
    return (
      <Page
      title="Display internal order" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the internal-order display capability (CO.ORDER.DISPLAY).</p>
      </Page>
    );
  }
  const requested = last((await searchParams).order);
  let message = '';
  let document: InternalOrderDocument | null = null;
  if (requested) {
    try {
      document = await displayInternalOrder({ client: session.user.client, orderNumber: requested });
    } catch (error) {
      message = error instanceof InternalOrderError ? error.message : 'The order could not be displayed.';
    }
  }

  return (
    <Page
      title="Display internal order" code="CO.ORDER.DISPLAY · KO03" width="3xl" back={null}
      description="KO03 shows the order. It does not save, post, budget, or settle. No status profile is configured."
    >
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order</span>
          <input className="input" name="order" defaultValue={requested} maxLength={20} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Display</button>
      </form>
      {message && <p className="text-sm text-signal-error" role="alert">{message}</p>}
      {document && (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-ink-soft">Order</dt><dd>{document.orderNumber}</dd></div>
          <div><dt className="text-ink-soft">Type</dt><dd>{document.orderType}</dd></div>
          <div><dt className="text-ink-soft">Description</dt><dd>{document.description}</dd></div>
          <div><dt className="text-ink-soft">Controlling area</dt><dd>{document.controllingArea}</dd></div>
          <div><dt className="text-ink-soft">Company code</dt><dd>{document.companyCode}</dd></div>
          <div><dt className="text-ink-soft">Currency</dt><dd>{document.currency}</dd></div>
          <div><dt className="text-ink-soft">Validity</dt><dd>{document.startDate} – {document.endDate}</dd></div>
          <div><dt className="text-ink-soft">Cost center</dt><dd>{document.costCenter ?? '—'}</dd></div>
          <div><dt className="text-ink-soft">Profit center</dt><dd>{document.profitCenter ?? '—'}</dd></div>
          <div><dt className="text-ink-soft">Statistical</dt><dd>{document.statistical ? 'Yes' : 'No'}</dd></div>
          <div><dt className="text-ink-soft">Posting lock</dt><dd>{document.isPostingLocked ? 'Yes' : 'No'}</dd></div>
          <div><dt className="text-ink-soft">Marked for deletion</dt><dd>{document.markedForDeletion ? 'Yes' : 'No'}</dd></div>
          <div><dt className="text-ink-soft">Journal lines</dt><dd>{document.journalCount}. Display did not post them.</dd></div>
        </dl>
      )}
      {document && (
        <p className="text-sm">
          <Link className="underline" href={`/controlling/internal-orders?order=${encodeURIComponent(document.orderNumber)}`}>KO02 change</Link>
        </p>
      )}
    </Page>
  );
}

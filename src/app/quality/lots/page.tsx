import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  LOT_CAPABILITY,
  LOT_ROUTE,
  getLot,
  listInspectableLines,
  listLots,
} from '@/modules/quality/lot';
import Lots from './Lots';

export const dynamic = 'force-dynamic';

/**
 * Inspection lots: the record that received goods are to be examined.
 *
 * The page opens a lot against one line of a posted material document and reads back what the receipt left
 * standing — movement, material, plant, storage location, batch, quantity, unit and stock segment all come
 * from that line rather than from a copy, which is why a lot cannot drift away from the goods it names.
 * `?document=` narrows both the candidate lines and the list to one material document; `?lot=` reads a single
 * lot with its source.
 *
 * What this screen deliberately does not do: it posts nothing, so opening a lot moves no stock and changes no
 * batch. Quarantine at receipt is a separate decision (D2, DI-022) — a receipt lands where its movement type
 * and the posting engine put it, and `/config/movement-types` already maintains the segment a receipt could
 * honour. The usage decision, results and sampling are not built either, and the screen says so rather than
 * implying that an inspection has been carried out.
 */
export default async function QualityLotsPage({ searchParams }: {
  searchParams: Promise<{ document?: string; lot?: string }>;
}) {
  const session = await requireSession(LOT_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const documentNumber = (params.document ?? '').trim().toUpperCase();
  const lotNumber = (params.lot ?? '').trim().toUpperCase();
  const [lots, candidates, selected] = await Promise.all([
    listLots(client, documentNumber ? { materialDocumentNumber: documentNumber } : {}),
    listInspectableLines(client, documentNumber ? { materialDocumentNumber: documentNumber } : {}),
    lotNumber ? getLot(client, lotNumber) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{LOT_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Inspection lots</h1>
          <div className="flex gap-2">
            <Link href="/inventory/goods-receipt" className="btn btn-default min-h-11 sm:min-h-8">Goods receipt</Link>
            <Link href="/inventory/material-documents" className="btn btn-default min-h-11 sm:min-h-8">Material documents</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A lot names the line a quantity arrived on and asks that it be examined. Opening one posts nothing:
          no stock movement, no valuation, no journal, no change to the batch. Whether the goods may move is
          still the stock segment and the batch&apos;s restricted-use indicator, enforced where they are
          consumed — a lot records the request for an inspection, it is not yet the decision.
        </p>
      </header>
      <Lots
        lots={lots}
        candidates={candidates}
        selected={selected}
        documentNumber={documentNumber}
        canCreate={can(session, LOT_CAPABILITY)}
      />
    </div>
  );
}

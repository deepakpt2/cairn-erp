import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { getBatchLevel } from '@/modules/inventory/batch-level';
import { ACTIVITY, BatchChangeError, BatchDisplayError, displayBatch } from '@/modules/inventory/batch-display';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/batches/display';

/** Display batch. MSC3N is a search alias only. This screen does not write. */
export default async function DisplayBatchPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const canDisplay = can(session, ACTIVITY);
  const level = await getBatchLevel(session.user.client);
  const plantRequired = level?.batchLevel === '0';
  const materialNumber = params.material?.trim() ?? '';
  const batchNumber = params.batch?.trim() ?? '';
  const plant = params.plant?.trim() ?? '';
  let opened = null;
  let openError: string | null = null;
  if (canDisplay && level && materialNumber && batchNumber) {
    try {
      opened = await displayBatch({
        client: session.user.client,
        materialNumber,
        plant: plantRequired ? plant : undefined,
        batchNumber,
      });
    } catch (error) {
      if (error instanceof BatchChangeError || error instanceof BatchDisplayError) openError = error.message;
      else throw error;
    }
  }
  const changeHref = opened
    ? `/inventory/batches/change?material=${encodeURIComponent(opened.materialNumber)}&batch=${encodeURIComponent(opened.batchNumber)}${opened.plant ? `&plant=${encodeURIComponent(opened.plant)}` : ''}`
    : '/inventory/batches/change';

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · MSC3N</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Display batch</h1>
          <Link href={changeHref} className="btn btn-default min-h-11 sm:min-h-8">Change batch</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Read a batch that already stands. The batch level is {level ? `${level.batchLevel} — ${level.name}` : 'not set'}.
          This screen does not change the batch, post stock, or post a journal. The date of manufacture is HSDAT, not HERDT.
          MSC1N and MSC2N are not this screen.
        </p>
      </header>
      {!canDisplay && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Display only is not granted. Ask an administrator for {ACTIVITY}.</p>
      )}
      {canDisplay && !level && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Set the batch level in OMCE before displaying a batch.</p>
      )}
      {canDisplay && level && (
        <form method="get" action={ROUTE} className="space-y-3 border border-line bg-white p-4">
          <label className="block text-sm">
            Material
            <input name="material" required maxLength={40} defaultValue={materialNumber} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          {plantRequired && (
            <label className="block text-sm">
              Plant
              <input name="plant" required maxLength={10} defaultValue={plant} className="mt-1 w-full border border-line px-2 py-1" />
            </label>
          )}
          <label className="block text-sm">
            Batch number
            <input name="batch" required maxLength={40} defaultValue={batchNumber} className="mt-1 w-full border border-line px-2 py-1" />
          </label>
          <button type="submit" className="btn btn-default min-h-11">Display batch</button>
        </form>
      )}
      {openError && <p role="alert" className="border border-line bg-white p-3 text-sm">{openError}</p>}
      {canDisplay && materialNumber && batchNumber && !opened && !openError && (
        <p role="status" className="border border-line bg-white p-3 text-sm">Batch {batchNumber} does not stand for material {materialNumber}.</p>
      )}
      {opened && (
        <section className="space-y-3 border border-line bg-white p-4 text-sm">
          <p>Material <span className="code">{opened.materialNumber}</span>{opened.plant ? <> · Plant <span className="code">{opened.plant}</span></> : null} · Batch <span className="code">{opened.batchNumber}</span> · Version <span className="code">{opened.version}</span></p>
          <dl className="grid gap-2 sm:grid-cols-2">
            <div><dt className="text-ink-soft">Restricted-use indicator</dt><dd>{opened.statusLabel}</dd></div>
            <div><dt className="text-ink-soft">Date of manufacture</dt><dd>{opened.manufactureDate ?? 'Not stored'}</dd></div>
            <div><dt className="text-ink-soft">Shelf-life expiration date</dt><dd>{opened.shelfLifeExpirationDate ?? 'Not stored'}</dd></div>
            <div><dt className="text-ink-soft">Vendor batch number</dt><dd>{opened.vendorBatch ?? 'Not stored'}</dd></div>
            <div><dt className="text-ink-soft">Country of origin</dt><dd>{opened.countryOfOrigin ?? 'Not stored'}</dd></div>
            <div><dt className="text-ink-soft">Deletion</dt><dd>Not stored. This screen does not show a deletion flag.</dd></div>
            <div><dt className="text-ink-soft">Classification</dt><dd>Not stored. Class type 023 is not active.</dd></div>
            <div><dt className="text-ink-soft">Created</dt><dd>{opened.createdBy ?? '—'} {opened.createdAt ?? ''}</dd></div>
          </dl>
          <p className="text-xs text-ink-soft">
            This screen does not show stock. The pick-up list of batches that already appear on a material document is MB5C. Inspection lots are not this screen.
          </p>
          <p>
            <Link href={`/inventory/stock-overview?material=${encodeURIComponent(opened.materialNumber)}`} className="underline">Material stock overview</Link>
            {' · '}
            <Link href={`/inventory/batch-pickup?material=${encodeURIComponent(opened.materialNumber)}&batch=${encodeURIComponent(opened.batchNumber)}`} className="underline">Batch pick-up list</Link>
          </p>
          {opened.history.length > 0 && (
            <div>
              <h2 className="font-medium">Change documents</h2>
              <ul className="mt-2 space-y-2">
                {opened.history.map((document, index) => (
                  <li key={`${document.changedAt}-${index}`} className="border border-line p-2">
                    <p>{document.changeType} · {document.transactionCode ?? '—'} · {document.changedBy}</p>
                    {document.reason && <p className="text-xs text-ink-soft">{document.reason}</p>}
                    {document.items.length > 0 && (
                      <ul className="mt-1 text-xs">
                        {document.items.map((item) => (
                          <li key={item.fieldName}>{item.fieldName}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

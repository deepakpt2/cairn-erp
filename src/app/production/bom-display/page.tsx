import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  BOM_DISPLAY_CAPABILITY,
  BOM_DISPLAY_ROUTE,
  BOM_ROUTE,
  MaterialBomError,
} from '@/modules/production/material-bom';
import { displayMaterialBom, listMaterialBomsForDisplay } from '@/modules/production/material-bom-display';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd>{value == null || value === '' ? '—' : value}</dd>
    </div>
  );
}

/** CS03. Display only. Opening this screen does not write and does not take a change lock. */
export default async function MaterialBomDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(BOM_DISPLAY_ROUTE);
  if (!can(session, BOM_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display material BOM</h1>
        <p className="mt-2 text-sm">You do not hold the BOM display capability (PROD.BOM.DISPLAY).</p>
      </main>
    );
  }
  const raw = await searchParams;
  const materialNumber = last(raw.material);
  const plant = last(raw.plant);
  const usage = last(raw.usage);
  const alternative = last(raw.alternative);
  const validOn = last(raw.validOn);
  let listed: Awaited<ReturnType<typeof listMaterialBomsForDisplay>> = [];
  let openError = '';
  if (materialNumber && plant && usage) {
    try {
      listed = await listMaterialBomsForDisplay(session.user.client, { materialNumber, plant, usage });
    } catch (error) {
      openError = error instanceof MaterialBomError ? error.message : 'The BOM could not be displayed.';
    }
  }
  const chosen = alternative || (listed.length === 1 ? listed[0].alternative : '');
  let document = null;
  if (chosen) {
    try {
      document = await displayMaterialBom(session.user.client, materialNumber, plant, usage, chosen, validOn || null);
    } catch (error) {
      openError = error instanceof MaterialBomError ? error.message : 'The BOM could not be displayed.';
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.BOM.DISPLAY · CS03</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Display material BOM</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          CS03 shows the stored BOM. It does not save, lock for change, explode, or rewrite a production order.
        </p>
      </header>
      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="block text-sm">Material
          <input className="input mt-1" name="material" defaultValue={materialNumber} maxLength={40} />
        </label>
        <label className="block text-sm">Plant
          <input className="input mt-1" name="plant" defaultValue={plant} maxLength={10} />
        </label>
        <label className="block text-sm">Usage
          <input className="input mt-1" name="usage" defaultValue={usage} maxLength={1} />
        </label>
        <label className="block text-sm">Alternative
          <input className="input mt-1" name="alternative" defaultValue={alternative} maxLength={2} />
        </label>
        <label className="block text-sm">Valid on
          <input className="input mt-1" type="date" name="validOn" defaultValue={validOn} />
        </label>
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Display</button>
      </form>
      {!alternative && listed.length > 1 && (
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Choose an alternative</h2>
          <p className="mt-1 text-sm text-ink-soft">More than one BOM matches. The first row was not opened.</p>
          <ul className="mt-2 text-sm">
            {listed.map((row) => (
              <li key={row.alternative}>
                <Link className="underline" href={`${BOM_DISPLAY_ROUTE}?material=${encodeURIComponent(row.materialNumber)}&plant=${encodeURIComponent(row.plant)}&usage=${encodeURIComponent(row.usage)}&alternative=${encodeURIComponent(row.alternative)}${validOn ? `&validOn=${validOn}` : ''}`}>
                  {row.alternative} · BOM {row.bomNumber}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {openError && <p className="text-sm text-red-700" role="alert">{openError}</p>}
      {materialNumber && plant && usage && !document && !openError && (alternative || listed.length === 0) && (
        <p className="text-sm text-red-700" role="alert">No BOM exists for {materialNumber} in plant {plant} and usage {usage}{alternative ? ` alternative ${alternative}` : ''}.</p>
      )}
      {document && (
        <>
          <p className="text-sm">
            <Link className="underline" href={`${BOM_ROUTE}?material=${encodeURIComponent(document.materialNumber)}&plant=${encodeURIComponent(document.plant)}&usage=${encodeURIComponent(document.usage)}&alternative=${encodeURIComponent(document.alternative)}`}>CS02 change</Link>
          </p>
          <section className="panel p-4" aria-readonly="true">
            <h2 className="text-sm font-semibold">Header</h2>
            <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Material" value={`${document.materialNumber} · ${document.materialDescription}`} />
              <Field label="Plant" value={`${document.plant} · ${document.plantName}`} />
              <Field label="Usage" value={`${document.usage} · ${document.usageDescription}`} />
              <Field label="Alternative" value={document.alternative} />
              <Field label="BOM" value={document.bomNumber} />
              <Field label="Status" value={document.status ? `${document.status} · ${document.statusDescription ?? ''}` : null} />
              <Field label="Base quantity" value={`${document.baseQuantity} ${document.baseUnit}`} />
              <Field label="Valid from" value={document.validFrom} />
              <Field label="Valid to" value={document.validTo} />
              <Field label="Header text" value={document.headerText} />
              <Field label="Deletion flag" value={document.deletionFlag === 'X' ? 'X' : ' '} />
              <Field label="Effective" value={document.effective ? 'Yes' : 'No'} />
            </dl>
          </section>
          <section className="panel p-4">
            <h2 className="text-sm font-semibold">Components</h2>
            {document.items.length === 0 && <p className="mt-2 text-sm text-ink-soft">No component is stored.</p>}
            <ul className="mt-2 space-y-2 text-sm">
              {document.items.map((item) => (
                <li key={item.itemNumber}>
                  {item.itemNumber} · {item.itemCategory}
                  {item.componentMaterial ? ` · ${item.componentMaterial} ${item.componentDescription ?? ''}` : ''}
                  {item.quantity ? ` · ${item.quantity} ${item.unit ?? ''}` : ''}
                  {item.deletionFlag === 'X' ? ' · deletion flag' : ''}
                  {validOn ? ` · ${item.effective ? 'effective' : 'not effective'}` : ''}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-ink-soft">No explosion was run. {document.unchangedProductionOrders} production orders for this material were not rewritten.</p>
          </section>
          {document.warnings.map((warning) => <p key={warning} className="text-sm text-ink-soft">{warning}</p>)}
        </>
      )}
    </main>
  );
}

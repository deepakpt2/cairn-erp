import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { plant as plantTable } from '@/modules/foundation/schema';
import { material as materialTable } from '@/modules/inventory/schema';
import {
  BOM_CHANGE_CAPABILITY,
  BOM_CREATE_CAPABILITY,
  BOM_DISPLAY_ROUTE,
  BOM_LOCK,
  BOM_ROUTE,
  listBomItemCategories,
  listBomStatuses,
  listBomUsages,
  listMaterialBoms,
  resolveMaterialBom,
  MaterialBomError,
} from '@/modules/production/material-bom';
import BomForm from './BomForm';
import { ItemCategoryForm, StatusForm, UsageForm } from './ConfigForms';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** CS01 and CS02. A material BOM is master data. This is not an explosion. */
export default async function MaterialBomsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(BOM_ROUTE);
  const canCreate = can(session, BOM_CREATE_CAPABILITY);
  const canChange = can(session, BOM_CHANGE_CAPABILITY);
  if (!canCreate && !canChange) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Material BOM</h1>
        <p className="mt-2 text-sm">You do not hold the BOM create or change capability.</p>
      </main>
    );
  }
  const raw = await searchParams;
  const materialNumber = last(raw.material);
  const plant = last(raw.plant);
  const usage = last(raw.usage);
  const alternative = last(raw.alternative);
  const validOn = last(raw.validOn);
  const creating = last(raw.create) === '1';
  let listed: Awaited<ReturnType<typeof listMaterialBoms>> = [];
  let openError = '';
  const [usages, statuses, categories, plants, materials] = await Promise.all([
    listBomUsages(session.user.client),
    listBomStatuses(session.user.client),
    listBomItemCategories(session.user.client),
    withTenant(session.user.client, (tx) => tx.select({ plant: plantTable.plant, name: plantTable.name }).from(plantTable).where(eq(plantTable.client, session.user.client))),
    withTenant(session.user.client, (tx) => tx.select({
      materialNumber: materialTable.materialNumber,
      description: materialTable.description,
      baseUnit: materialTable.baseUnit,
    }).from(materialTable).where(eq(materialTable.client, session.user.client))),
  ]);
  if (materialNumber && plant && usage) {
    try {
      listed = await listMaterialBoms(session.user.client, { materialNumber, plant, usage });
    } catch (error) {
      openError = error instanceof MaterialBomError ? error.message : 'The BOM could not be opened.';
    }
  }
  let document = null;
  if (!creating && materialNumber && plant && usage && (alternative || listed.length === 1)) {
    try {
      document = await resolveMaterialBom(session.user.client, materialNumber, plant, usage, alternative || listed[0]?.alternative, validOn || null);
    } catch (error) {
      openError = error instanceof MaterialBomError ? error.message : 'The BOM could not be opened.';
    }
  }
  const ambiguous = !creating && !alternative && listed.length > 1;
  const changeLock = document && canChange
    ? await openChangeForSession(session, {
      lockObject: BOM_LOCK,
      argument: `${document.plant}/${document.materialNumber}/${document.usage}/${document.alternative}`,
      transactionCode: 'CS02',
    })
    : null;
  const showCreate = creating && canCreate;
  const showChange = Boolean(document) && canChange && changeLock?.mode !== 'DISPLAY';

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.BOM.CREATE · CS01 / CS02</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Material BOM</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          CS01 creates a plant-specific material BOM. CS02 changes one. Usage, status, and item category are defined here.
          A change number is refused. Saving does not explode the BOM and does not rewrite a production order. CS03 displays and does not save.
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
        <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit">Open</button>
        {canCreate && <Link className="btn btn-default min-h-11 sm:min-h-8" href={`${BOM_ROUTE}?create=1`}>Create</Link>}
      </form>
      {openError && <p className="text-sm text-red-700" role="alert">{openError}</p>}
      {materialNumber && plant && usage && !creating && !document && !ambiguous && !openError && (
        <p className="text-sm text-red-700" role="alert">No BOM exists for {materialNumber} in plant {plant} and usage {usage}{alternative ? ` alternative ${alternative}` : ''}.</p>
      )}
      {ambiguous && (
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Choose an alternative</h2>
          <p className="mt-1 text-sm text-ink-soft">More than one BOM matches. The first row was not opened.</p>
          <ul className="mt-2 text-sm">
            {listed.map((row) => (
              <li key={row.alternative}>
                <Link className="underline" href={`${BOM_ROUTE}?material=${encodeURIComponent(row.materialNumber)}&plant=${encodeURIComponent(row.plant)}&usage=${encodeURIComponent(row.usage)}&alternative=${encodeURIComponent(row.alternative)}${validOn ? `&validOn=${validOn}` : ''}`}>
                  {row.alternative} · BOM {row.bomNumber} · {row.validFrom} to {row.validTo}{row.deletionFlag === 'X' ? ' · deletion flag' : ''}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {document && (
        <p className="text-sm">
          {document.materialNumber} · {document.plant} · {document.usage} · {document.alternative}
          {validOn ? ` · ${document.effective ? 'effective' : 'not effective'} on ${validOn}` : ''}
          {' · '}
          <Link className="underline" href={`${BOM_DISPLAY_ROUTE}?material=${encodeURIComponent(document.materialNumber)}&plant=${encodeURIComponent(document.plant)}&usage=${encodeURIComponent(document.usage)}&alternative=${encodeURIComponent(document.alternative)}`}>CS03 display</Link>
        </p>
      )}
      {changeLock?.mode === 'DISPLAY' && <p className="text-sm text-ink-soft">{displayOnlyMessage(changeLock)}</p>}
      {(showCreate || showChange) && (
        <BomForm
          document={showChange ? document : null}
          plants={plants}
          materials={materials}
          usages={usages.map((row) => ({ usage: row.usage, description: row.description }))}
          statuses={statuses.map((row) => ({ status: row.status, description: row.description }))}
          categories={categories.map((row) => ({ category: row.category, description: row.description }))}
          locked={false}
        />
      )}
      {canCreate && (
        <>
          <UsageForm />
          <StatusForm />
          <ItemCategoryForm />
        </>
      )}
    </main>
  );
}

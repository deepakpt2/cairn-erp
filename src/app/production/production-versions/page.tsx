import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { displayOnlyMessage, openChangeForSession } from '@/platform/lock/enqueue';
import { plant as plantTable } from '@/modules/foundation/schema';
import { material as materialTable } from '@/modules/inventory/schema';
import {
  PRODUCTION_VERSION_ACTIVITY,
  PRODUCTION_VERSION_CHANGE_CAPABILITY,
  PRODUCTION_VERSION_CHECK_CAPABILITY,
  PRODUCTION_VERSION_CREATE_CAPABILITY,
  PRODUCTION_VERSION_DELETE_CAPABILITY,
  PRODUCTION_VERSION_DISPLAY_ROUTE,
  PRODUCTION_VERSION_LOCK,
  PRODUCTION_VERSION_LOCK_CAPABILITY,
  PRODUCTION_VERSION_ROUTE,
  ProductionVersionError,
  getProductionVersion,
  listProductionVersionChoices,
  listProductionVersions,
} from '@/modules/production/production-version';
import VersionForm from './VersionForm';
import { checkVersionAction, deleteVersionAction, lockVersionAction, saveRuleAction } from './actions';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

const STATUS: Record<string, string> = { ' ': 'Unchecked', '1': 'Valid', '2': 'Warning', '3': 'Error' };

/** C223. A production version names a BOM and a routing. It does not maintain them. */
export default async function ProductionVersionsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PRODUCTION_VERSION_ROUTE);
  const canCreate = can(session, PRODUCTION_VERSION_CREATE_CAPABILITY);
  const canChange = can(session, PRODUCTION_VERSION_CHANGE_CAPABILITY);
  if (!canCreate && !canChange) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Production version</h1>
        <p className="mt-2 text-sm">You do not hold the production-version create or change capability.</p>
      </main>
    );
  }
  const raw = await searchParams;
  const plant = last(raw.plant);
  const materialNumber = last(raw.material);
  const productionVersion = last(raw.version);
  const creating = last(raw.create) === '1';
  const keyDate = last(raw.validOn);
  let openError = '';
  let listed: Awaited<ReturnType<typeof listProductionVersions>> = { rows: [], total: 0, limit: 25, offset: 0 };
  if (plant) {
    try {
      listed = await listProductionVersions(session.user.client, {
        plant,
        materialNumber,
        productionVersion,
        mrpController: last(raw.controller),
        keyDate,
        consistency: last(raw.consistency) as 'unchecked' | 'valid' | 'warning' | 'error' | 'stale' | '',
        includeLocked: last(raw.locked) === '1',
        includeExpired: last(raw.expired) === '1',
        offset: Number(last(raw.page) || 0) * 25,
      });
    } catch (error) {
      openError = error instanceof ProductionVersionError ? error.message : 'The production versions could not be listed.';
    }
  }
  let document = null;
  if (!creating && materialNumber && plant && productionVersion) {
    try {
      document = await getProductionVersion(session.user.client, materialNumber, plant, productionVersion);
    } catch (error) {
      openError = error instanceof ProductionVersionError ? error.message : 'The production version could not be opened.';
    }
  }
  const choices = materialNumber && plant
    ? await listProductionVersionChoices(session.user.client, materialNumber, plant)
    : { boms: [], routings: [], storageLocations: [] };
  const [plants, materials] = await Promise.all([
    withTenant(session.user.client, (tx) => tx.select({ plant: plantTable.plant, name: plantTable.name }).from(plantTable).where(eq(plantTable.client, session.user.client))),
    withTenant(session.user.client, (tx) => tx.select({
      materialNumber: materialTable.materialNumber,
      description: materialTable.description,
      baseUnit: materialTable.baseUnit,
    }).from(materialTable).where(eq(materialTable.client, session.user.client))),
  ]);
  // A change lock is only worth taking to someone who can write the row. The change save and the
  // check, lock-indicator and delete acts all stand under it, so a session holding any of those
  // takes the lock; a create-only session takes none, and so cannot shut an editor out of a standing
  // version it is not entitled to change. Creating stays lock-free.
  const mayWrite = canChange
    || can(session, PRODUCTION_VERSION_CHECK_CAPABILITY)
    || can(session, PRODUCTION_VERSION_LOCK_CAPABILITY)
    || can(session, PRODUCTION_VERSION_DELETE_CAPABILITY);
  // Only a lock this session was actually given grants change: another holder, or no lock at all,
  // reads and never writes.
  const lock = document && mayWrite
    ? await openChangeForSession(session, {
      lockObject: PRODUCTION_VERSION_LOCK,
      argument: `${document.plant}/${document.materialNumber}/${document.productionVersion}`,
      transactionCode: PRODUCTION_VERSION_ACTIVITY,
    })
    : null;
  const locked = Boolean(document) && lock?.mode !== 'CHANGE';
  const displayNotice = lock ? displayOnlyMessage(lock) : null;

  return (
    <main className="mx-auto max-w-6xl p-6">
      <p className="text-sm"><Link href="/config">Configuration</Link></p>
      <h1 className="mt-2 text-xl font-semibold">Production version</h1>
      <p className="mt-2 text-sm text-ink-soft">C223 names one BOM alternative and one standard routing for a material and plant. It does not maintain either master, does not explode a BOM, and does not rewrite a production order. A change number is refused. <Link href={PRODUCTION_VERSION_DISPLAY_ROUTE}>Display writes nothing.</Link></p>
      {openError && <p className="mt-3 text-sm text-danger">{openError}</p>}
      {last(raw.notice) && <p className="mt-3 text-sm">{last(raw.notice)}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="plant" defaultValue={plant} placeholder="Plant" required />
        <input className="input" name="material" defaultValue={materialNumber} placeholder="Material" />
        <input className="input" name="version" defaultValue={productionVersion} maxLength={4} placeholder="Version" />
        <input className="input" name="controller" defaultValue={last(raw.controller)} maxLength={3} placeholder="MRP controller" />
        <input className="input" name="validOn" type="date" defaultValue={keyDate} />
        <select className="input" name="consistency" defaultValue={last(raw.consistency)}>
          <option value="">Any check</option>
          <option value="unchecked">Unchecked</option>
          <option value="valid">Valid</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
          <option value="stale">Stale</option>
        </select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="locked" value="1" defaultChecked={last(raw.locked) === '1'} /> Include locked</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="expired" value="1" defaultChecked={last(raw.expired) === '1'} /> Include expired</label>
        <button className="btn" type="submit">Search</button>
        {canCreate && <Link className="btn" href={`${PRODUCTION_VERSION_ROUTE}?create=1&plant=${plant}&material=${materialNumber}`}>Create</Link>}
      </form>
      {plant && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left">
              <th>Material</th><th>Version</th><th>Valid</th><th>Lot</th><th>BOM</th><th>Routing</th><th>Check</th><th>Lock</th>
            </tr>
          </thead>
          <tbody>
            {listed.rows.map((row) => (
              <tr key={`${row.materialNumber}/${row.productionVersion}`}>
                <td><Link href={`${PRODUCTION_VERSION_ROUTE}?plant=${row.plant}&material=${row.materialNumber}&version=${row.productionVersion}`}>{row.materialNumber}</Link> {row.materialDescription}</td>
                <td>{row.productionVersion}</td>
                <td>{row.validFrom} – {row.validTo}</td>
                <td>{row.lotFrom}–{row.lotTo} {row.lotUnit}</td>
                <td>{row.bomUsage}/{row.bomAlternative}</td>
                <td>{row.taskListType} {row.routingGroup}/{row.groupCounter}</td>
                <td>{row.stale ? 'Stale' : STATUS[row.checkStatus]}</td>
                <td>{row.lockIndicator === '1' ? 'Locked' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {listed.total > listed.rows.length && <p className="mt-2 text-sm">{listed.total} versions. This page shows {listed.rows.length}.</p>}
      {displayNotice && <p className="mt-3 text-sm">{displayNotice}</p>}
      {(creating || document) && (
        <VersionForm document={document} locked={locked} canCopy={canCreate} plants={plants} materials={materials} choices={choices} />
      )}
      {document && (
        <section className="mt-4 space-y-2 text-sm">
          <p>Check {document.stale ? 'stale' : STATUS[document.checkStatus]}{document.checkedAt ? ` at ${document.checkedAt}` : ''} by {document.checkedBy ?? 'nobody'}.</p>
          <ul>
            {document.findings.map((finding) => (
              <li key={finding.code}>{finding.severity === 'E' ? 'Error' : 'Warning'} {finding.code}: {finding.message}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {can(session, PRODUCTION_VERSION_CHECK_CAPABILITY) && (
              <form action={checkVersionAction}>
                <input type="hidden" name="materialNumber" value={document.materialNumber} />
                <input type="hidden" name="plant" value={document.plant} />
                <input type="hidden" name="productionVersion" value={document.productionVersion} />
                <button className="btn" type="submit" disabled={locked}>Check consistency</button>
              </form>
            )}
            {can(session, PRODUCTION_VERSION_LOCK_CAPABILITY) && (
              <form action={lockVersionAction}>
                <input type="hidden" name="materialNumber" value={document.materialNumber} />
                <input type="hidden" name="plant" value={document.plant} />
                <input type="hidden" name="productionVersion" value={document.productionVersion} />
                <input type="hidden" name="version" value={document.version} />
                <input type="hidden" name="locked" value={document.lockIndicator === '1' ? '0' : '1'} />
                <button className="btn" type="submit" disabled={locked}>{document.lockIndicator === '1' ? 'Unlock' : 'Lock'}</button>
              </form>
            )}
            {can(session, PRODUCTION_VERSION_DELETE_CAPABILITY) && (
              <form action={deleteVersionAction}>
                <input type="hidden" name="materialNumber" value={document.materialNumber} />
                <input type="hidden" name="plant" value={document.plant} />
                <input type="hidden" name="productionVersion" value={document.productionVersion} />
                <input type="hidden" name="version" value={document.version} />
                <button className="btn" type="submit" disabled={locked}>Delete or deactivate</button>
              </form>
            )}
          </div>
        </section>
      )}
      {canChange && (
        <form action={saveRuleAction} className="mt-8 rounded border border-line p-3">
          <h2 className="text-sm font-semibold">Overlap rule</h2>
          <p className="mt-1 text-sm text-ink-soft">No rule is delivered. Until this is set, overlapping dates and lot sizes are allowed, and selection asks for a choice.</p>
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" name="refuseOverlap" value="X" /> Refuse an overlapping date and lot-size range</label>
          <button className="btn mt-2" type="submit">Save rule</button>
        </form>
      )}
    </main>
  );
}

import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PRODUCTION_VERSION_DISPLAY_CAPABILITY,
  PRODUCTION_VERSION_DISPLAY_ROUTE,
  PRODUCTION_VERSION_ROUTE,
  ProductionVersionError,
  getProductionVersion,
  listProductionVersions,
} from '@/modules/production/production-version';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** Display a production version. This page writes nothing and takes no change lock. */
export default async function ProductionVersionDisplayPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(PRODUCTION_VERSION_DISPLAY_ROUTE);
  if (!can(session, PRODUCTION_VERSION_DISPLAY_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Display production version</h1>
        <p className="mt-2 text-sm">You do not hold the production-version display capability.</p>
      </main>
    );
  }
  const raw = await searchParams;
  const plant = last(raw.plant);
  const materialNumber = last(raw.material);
  const productionVersion = last(raw.version);
  let openError = '';
  let listed: Awaited<ReturnType<typeof listProductionVersions>> = { rows: [], total: 0, limit: 25, offset: 0 };
  if (plant && !productionVersion) {
    try {
      listed = await listProductionVersions(session.user.client, { plant, materialNumber, includeLocked: true, includeExpired: true });
    } catch (error) {
      openError = error instanceof ProductionVersionError ? error.message : 'The production version could not be displayed.';
    }
  }
  let document = null;
  if (materialNumber && plant && productionVersion) {
    try {
      document = await getProductionVersion(session.user.client, materialNumber, plant, productionVersion);
    } catch (error) {
      openError = error instanceof ProductionVersionError ? error.message : 'The production version could not be displayed.';
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <p className="text-sm"><Link href={PRODUCTION_VERSION_ROUTE}>C223</Link></p>
      <h1 className="mt-2 text-xl font-semibold">Display production version</h1>
      <p className="mt-2 text-sm text-ink-soft">Display writes nothing. It does not take a change lock and does not change a timestamp or version.</p>
      {openError && <p className="mt-3 text-sm text-danger">{openError}</p>}
      <form className="mt-4 grid gap-2 sm:grid-cols-4" method="get">
        <input className="input" name="plant" defaultValue={plant} placeholder="Plant" />
        <input className="input" name="material" defaultValue={materialNumber} placeholder="Material" />
        <input className="input" name="version" defaultValue={productionVersion} placeholder="Version" />
        <button className="btn" type="submit">Display</button>
      </form>
      {listed.rows.length > 1 && (
        <ul className="mt-3 space-y-1 text-sm">
          {listed.rows.map((row) => (
            <li key={row.productionVersion}><Link href={`${PRODUCTION_VERSION_DISPLAY_ROUTE}?plant=${row.plant}&material=${row.materialNumber}&version=${row.productionVersion}`}>{row.materialNumber} {row.productionVersion}</Link></li>
          ))}
          <li>More than one version matches. The first was not opened.</li>
        </ul>
      )}
      {document && (
        <section className="mt-4 space-y-2 text-sm">
          <p>{document.materialNumber} {document.materialDescription} plant {document.plant} version {document.productionVersion} record version {document.version}</p>
          <p>Valid {document.validFrom} to {document.validTo}. Lot {document.lotFrom} to {document.lotTo} {document.lotUnit}.</p>
          <p>BOM {document.bomUsage}/{document.bomAlternative}, valid {document.bomValidFrom} to {document.bomValidTo}. <Link href={`/production/boms?material=${document.materialNumber}&plant=${document.plant}&usage=${document.bomUsage}&alternative=${document.bomAlternative}`}>Open the BOM.</Link></p>
          <p>Routing {document.taskListType} {document.routingGroup}/{document.groupCounter}, valid {document.routingValidFrom} to {document.routingValidTo}. <Link href={`/production/routings?type=${document.taskListType}&group=${document.routingGroup}&counter=${document.groupCounter}`}>Open the routing.</Link></p>
          <p>Lock {document.lockIndicator === '1' ? 'locked' : 'not locked'}. Check {document.stale ? 'stale' : document.checkStatus}. Deletion {document.deletionFlag === 'X' ? 'marked' : 'not marked'}.</p>
          <ul>{document.findings.map((finding) => <li key={finding.code}>{finding.severity} {finding.code}: {finding.message}</li>)}</ul>
        </section>
      )}
    </main>
  );
}

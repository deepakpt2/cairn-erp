import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  SERIAL_CAPABILITY, SERIAL_ROUTE, listSerialNumbers,
} from '@/modules/inventory/serial-number';
import SerialNumbers from './SerialNumbers';

export const dynamic = 'force-dynamic';

const ROUTE = SERIAL_ROUTE;

/**
 * Serial numbers — §5.5b.
 *
 * A batch is a kind of goods; a serial is one thing. Where batch determination answers "which boxes
 * come off the shelf", a serial answers "which one of these", and it keeps its identity afterwards:
 * which customer holds it, and which one came back.
 *
 * This canon has had no serial-number master until now, and three places said so by name. What
 * stands here is the master they were telling the truth about the absence of.
 *
 * Two things it is deliberately not, and the header says both. It is not the stock ledger: a
 * serialised material counted as three with three units standing can disagree, and nothing here
 * reconciles them. And it carries no serial number profile, because the material master already
 * asks whether a material is counted in serials.
 */
export default async function SerialNumbersPage() {
  const session = await requireSession(ROUTE);
  const serials = await listSerialNumbers(session.user.client);
  const canMaintain = can(session, SERIAL_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SERIAL_CAPABILITY} · MM</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Serial numbers</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          One row per serialised unit of a material: where it stands, where it went, and which
          customer holds it. A unit is captured when a delivery pick takes it, so a material that
          demands serials asks the picker which units came off the shelf and refuses a pick that
          names fewer — a serialised item is counted in whole units, and naming four for six leaves
          two unaccounted for.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          A unit that has gone out and come back is put back in stock with nothing written against
          it, because goods that came back are goods that never went.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Recording a unit requires an explicit exact-code role grant for{' '}
            {SERIAL_CAPABILITY}; broad wildcard role patterns do not grant it.
          </p>
        )}
      </header>

      <SerialNumbers serials={serials} canMaintain={canMaintain} />
    </main>
  );
}

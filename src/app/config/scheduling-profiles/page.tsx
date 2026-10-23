import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { plant as plantTable } from '@/modules/foundation/schema';
import { ACTIVITY, ALIAS, listSchedulingProfiles, ROUTE } from '@/modules/inventory/scheduling-profile';
import { withTenant } from '@/platform/db/client';
import { eq } from 'drizzle-orm';

import SchedulingProfileForm from './SchedulingProfileForm';

export const dynamic = 'force-dynamic';

/**
 * Production scheduling profile. OPKP is a search alias only.
 * The master is TCO43. T399X is not this screen.
 */
export default async function SchedulingProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ plant?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const selectedPlant = params.plant?.trim() ?? '';
  const canMaintain = can(session, ACTIVITY);
  const current = await listSchedulingProfiles(session.user.client, selectedPlant || undefined);
  const plants = await withTenant(session.user.client, (tx) => tx.select({
    plant: plantTable.plant,
    name: plantTable.name,
  }).from(plantTable).where(eq(plantTable.client, session.user.client)));

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Production scheduling profile</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OPKP maintains the profile for a plant. The key is stored as typed, at most six characters.
          Release at creation is the character X or blank. Batch creation in the order is blank, 1, or 2.
          Opening this screen does not select a plant and does not create a profile. It does not print,
          schedule, check availability or capacity, post a goods receipt, or classify a batch.
          CO01, OMCZ, and OMAD are not this screen. A closed posting period does not block it.
        </p>
      </header>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm">
          Display only. Ask an administrator for {ACTIVITY}.
        </p>
      )}

      <form method="get" className="flex items-end gap-2">
        <label className="text-sm">
          Plant
          <input name="plant" defaultValue={selectedPlant} className="field-input code mt-1" />
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8" type="submit">Show</button>
      </form>

      <SchedulingProfileForm
        profiles={current.profiles}
        assignments={current.assignments}
        plants={plants}
        canMaintain={canMaintain}
        selectedPlant={selectedPlant}
      />
    </div>
  );
}

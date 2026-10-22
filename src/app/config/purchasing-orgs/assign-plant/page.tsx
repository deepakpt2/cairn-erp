import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  listPurchasingOrgPlantAssignments,
} from '@/modules/purchasing/purchasing-org-plant-assignment';
import { plant, purchasingOrg } from '@/modules/foundation/schema';
import { withTenant } from '@/platform/db/client';
import { and, asc, eq } from 'drizzle-orm';
import AssignPlant from './AssignPlant';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/purchasing-orgs/assign-plant';

/**
 * Assign a purchasing organisation to a plant. OX17 is a search alias only.
 * The pair already stands. This screen maintains that row and posts nothing.
 */
export default async function AssignPurchasingOrgPlantPage() {
  const session = await requireSession(ROUTE);
  const canAssign = can(session, ACTIVITY);
  const client = session.user.client;
  const [assignments, organisations, plants] = await Promise.all([
    listPurchasingOrgPlantAssignments(client),
    withTenant(client, (tx) =>
      tx.select({
        purchasingOrg: purchasingOrg.purchasingOrg,
        name: purchasingOrg.name,
        companyCode: purchasingOrg.companyCode,
        isActive: purchasingOrg.isActive,
      }).from(purchasingOrg).where(eq(purchasingOrg.client, client)).orderBy(asc(purchasingOrg.purchasingOrg)),
    ),
    withTenant(client, (tx) =>
      tx.select({
        plant: plant.plant,
        name: plant.name,
        companyCode: plant.companyCode,
        isActive: plant.isActive,
      }).from(plant).where(and(eq(plant.client, client), eq(plant.isActive, true))).orderBy(asc(plant.plant)),
    ),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OX17</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('purchasingOrg.plantAssignmentTitle')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.workbench')}</Link>
            <Link href="/config/purchasing-orgs" className="btn btn-default min-h-11 sm:min-h-8">
              {t('purchasingOrg.backToDefinitions')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('purchasingOrg.plantAssignmentSubtitle')}</p>
      </header>

      {!canAssign && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <AssignPlant
        assignments={assignments}
        organisations={organisations.filter((row) => row.isActive)}
        plants={plants}
        canAssign={canAssign}
      />
    </div>
  );
}

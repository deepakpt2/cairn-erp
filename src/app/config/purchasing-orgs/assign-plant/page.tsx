
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
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('purchasingOrg.plantAssignmentTitle')} code={<>{ACTIVITY} · OX17</>} back={null}
      description={t('purchasingOrg.plantAssignmentSubtitle')}
      actions={
        <>
          <LinkButton href="/config">{t('nav.workbench')}</LinkButton>
          <LinkButton href="/config/purchasing-orgs">
                        {t('purchasingOrg.backToDefinitions')}
                      </LinkButton>
        </>
      }
    >

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
    </Page>
  );
}

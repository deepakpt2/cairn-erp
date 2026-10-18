import { can, requireSession } from '@/platform/auth/current';
import { listPurchasingGroupDefinitions } from '@/modules/foundation/purchasing-group-maintenance';
import { t } from '@/platform/i18n';
import { PurchasingGroupsGrid } from './PurchasingGroupsGrid';

export const dynamic = 'force-dynamic';

const PURCHASING_GROUP_DEFINE = 'CFG.PROC.PURGROUP.DEFINE';

/** Purchasing Groups overview; groups are not assigned to other company-structure units. */
export default async function PurchasingGroupsPage() {
  const session = await requireSession('/config/purchasing-groups');
  const records = await listPurchasingGroupDefinitions(session.user.client);
  const canMaintain = can(session, PURCHASING_GROUP_DEFINE);

  return (
    <main className="mx-auto max-w-[100rem] p-4 sm:p-6">
      <p className="sr-only">
        {t('purchasingGroup.accessibleContext')}
      </p>
      <PurchasingGroupsGrid records={records} canMaintain={canMaintain} />
    </main>
  );
}

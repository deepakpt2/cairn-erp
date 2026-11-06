import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listDeliveryCompletionPolicy,
} from '@/modules/purchasing/delivery-completion';
import { t } from '@/platform/i18n';
import DeliveryCompletion from './DeliveryCompletion';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/delivery-completion';

/**
 * Whether a goods receipt closes the purchase order item it posts against.
 *
 * The rule is a company-code default with a plant override, and with no row at all nothing
 * closes — an item closes when somebody closes it. This is the only screen that maintains
 * either table.
 */
export default async function DeliveryCompletionPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);
  const rows = await listDeliveryCompletionPolicy(session.user.client);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('deliveryCompletion.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('deliveryCompletion.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <DeliveryCompletion companies={rows.companies} plants={rows.plants} canMaintain={canMaintain} />
    </div>
  );
}

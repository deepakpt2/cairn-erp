
import { can, requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  listDeliveryCompletionPolicy,
} from '@/modules/purchasing/delivery-completion';
import { t } from '@/platform/i18n';
import DeliveryCompletion from './DeliveryCompletion';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('deliveryCompletion.title')} code={ACTIVITY} back={null}
      description={t('deliveryCompletion.subtitle')}
      actions={
        <>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <DeliveryCompletion companies={rows.companies} plants={rows.plants} canMaintain={canMaintain} />
    </Page>
  );
}

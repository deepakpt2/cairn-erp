import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { RETURN_CAPABILITY } from '@/modules/inventory/return-delivery';
import ReturnDeliveryShell from './ReturnDeliveryShell';
import { Page } from '@/ui/kit';

const RETURN_ROUTE = '/inventory/return-delivery';

export const dynamic = 'force-dynamic';

/**
 * SCR-145 / INV.RETURN.POST (MBRL) — return delivery to a vendor.
 *
 * Select a posted goods receipt, see what of it may still be returned, send some of it back. The
 * receipt stands; the received quantity falls. Shipping delivery is not offered because canon has
 * no logistics module — a switch that created half a delivery would be worse than none.
 */
export default async function ReturnDeliveryPage() {
  const session = await requireSession(RETURN_ROUTE);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={t('mbrl.title')} code="INV.RETURN.POST · MBRL" width="100rem" back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('mbrl.subtitle')}</p>
        </>
      }
    >

      <ReturnDeliveryShell canPost={can(session, RETURN_CAPABILITY)} today={today} />
    </Page>
  );
}

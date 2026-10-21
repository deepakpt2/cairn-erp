import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { RETURN_CAPABILITY } from '@/modules/inventory/return-delivery';
import ReturnDeliveryShell from './ReturnDeliveryShell';

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
    <div className="mx-auto max-w-[100rem] space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.RETURN.POST · MBRL</span>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{t('mbrl.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mbrl.subtitle')}</p>
      </header>

      <ReturnDeliveryShell canPost={can(session, RETURN_CAPABILITY)} today={today} />
    </div>
  );
}

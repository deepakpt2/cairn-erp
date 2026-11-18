import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { changeHistory } from '@/platform/change';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { plant as plantTable } from '@/modules/foundation/schema';
import {
  ACTIVITY,
  MRP_CONTROLLER_ROUTE as ROUTE,
  listMrpControllers,
  mrpControllerKey,
  parseMrpControllerKey,
} from '@/modules/inventory/mrp-controller-maintenance';
import MrpControllers from './MrpControllers';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Define MRP controllers (OMD0). A controller is defined per plant, is the planner a material's MRP is
 * routed to, and is named on the material's MRP view. The same code may stand in two plants.
 */
export default async function MrpControllersPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; history?: string; plant?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const [controllers, plants] = await Promise.all([
    listMrpControllers(client),
    withTenant(client, (tx) =>
      tx.select({ plant: plantTable.plant, name: plantTable.name, isActive: plantTable.isActive })
        .from(plantTable)
        .where(eq(plantTable.client, client))
        .orderBy(asc(plantTable.plant)),
    ),
  ]);

  const parsed = params.key ? parseMrpControllerKey(params.key) : null;
  const selected = parsed
    ? controllers.find((c) => c.plant === parsed.plant && c.controller === parsed.controller.toUpperCase())
    : undefined;
  const history = selected && params.history === '1'
    ? await withTenant(client, (tx) =>
        changeHistory(tx, client, 'mrp_controller', mrpControllerKey(selected.plant, selected.controller)))
    : [];

  return (
    <Page
      title={t('mrpController.title')} code={<>{ACTIVITY} · OMD0</>} back={null}
      description={t('mrpController.subtitle')}
      actions={
        <>
          <LinkButton href="/config">{t('nav.workbench')}</LinkButton>
        </>
      }
    >

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">{t('auth.readOnly', { authority: ACTIVITY })}</p>
      )}

      {selected && params.history === '1' && (
        <section className="panel overflow-x-auto">
          <div className="panel-header">
            <h2 className="panel-title">
              {t('mrpController.history')} · <span className="code">{selected.plant}/{selected.controller}</span>
            </h2>
            <Link className="text-sm text-accent underline" href={ROUTE}>{t('mrpController.backToList')}</Link>
          </div>
          {history.map((entry) => (
            <article key={entry.id} className="border-b border-line p-3 text-sm">
              <p className="font-medium">{entry.changedAt.toISOString()} · {entry.changedBy} · {entry.changeType}</p>
              {entry.reason && <p className="text-ink-soft">{entry.reason}</p>}
              <ul className="mt-1 text-2xs text-ink-soft">
                {entry.items.map((item) => (
                  <li key={item.id}>
                    {item.fieldLabel}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}
                    {item.isSecurityRelevant === 'true' ? ` · ${t('nr.controlChange')}` : ''}
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {!history.length && <p className="p-3 text-sm text-ink-soft">{t('mrpController.noChanges')}</p>}
        </section>
      )}

      <MrpControllers
        controllers={controllers}
        plants={plants.filter((p) => p.isActive).map(({ plant, name }) => ({ plant, name }))}
        canMaintain={canMaintain}
        defaultPlant={params.plant?.trim() ?? ''}
      />
    </Page>
  );
}

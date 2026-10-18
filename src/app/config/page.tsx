import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { listTenants, configReadiness } from '@/platform/tenancy';
import { requireSession } from '@/platform/auth/current';
import { WorkbenchTree } from './WorkbenchTree';

export const dynamic = 'force-dynamic';

interface ActivityRow {
  code: string;
  area: string;
  title: string;
  activity_kind: string;
  prerequisites: string;
  enables: string | null;
  route_path: string | null;
  status: string | null;
  sequence: number;
}

/**
 * Configuration workbench — CAIRN.md §7.1.
 *
 * The tree that makes an implementation plan portable (R-06). Every step is a
 * Define or an Assign, prerequisites are visible, and blocked steps say what they
 * are waiting for rather than simply refusing.
 */
export default async function WorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; created?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession('/config');
  const selected = session.user.client;
  const readiness = await configReadiness(selected);

  // Scoped through withTenant: config_activity_status carries a tenant policy, so an
  // unscoped read would default-deny and silently show every step as not started.
  const rows = (await withTenant(selected, (tx) =>
    tx.execute(sql`
      select a.code, a.area, a.title, a.activity_kind, a.prerequisites, a.enables,
             a.route_path, a.sequence, s.status
      from config_activity a
      left join config_activity_status s
        on s.activity_code = a.code and s.client = ${selected}
      order by a.sequence
    `),
  )) as unknown as ActivityRow[];

  const completed = new Set(
    rows.filter((r) => r.status === 'COMPLETED').map((r) => r.code),
  );

  /**
   * Routes that actually exist. Shown as links only when a screen is built, so
   * the workbench never offers a step that leads to a 404 — an unimplemented step
   * says so plainly instead of pretending.
   */
  const BUILT_ROUTES = new Set([
    '/clients',
    '/clients/new',
    '/config',
    '/config/company-codes',
    '/config/chart-of-accounts',
    '/config/chart-of-accounts/copy',
    '/config/fiscal-year-variants',
    '/config/fiscal-year-variants/assign-company-codes',
    '/config/controlling-area',
    '/config/controlling-area/assign-company-code',
    '/config/gl-accounts',
    '/config/gl-accounts/new',
    '/config/gl-accounts/edit',
    '/config/gl-accounts/view',
    '/config/payment-terms',
    '/config/payment-methods',
    '/config/posting-periods',
    '/config/exchange-rates',
    '/config/tax-codes',
    '/config/banks',
    '/config/house-banks',
    '/config/document-types',
    '/config/tolerance-groups',
    '/config/account-determination',
    '/config/cost-centers',
    '/config/cost-center-hierarchy',
    '/config/activity-types',
    '/config/activity-rates',
    '/config/profit-centers',
    '/config/profit-center-hierarchy',
    '/config/material-types',
    '/config/material-groups',
    '/config/material-number-ranges',
    '/config/industry-sectors',
    '/config/material-period-control',
    '/config/posting-period-variants',
    '/config/posting-period-variants/assign-company-codes',
    '/config/plants',
    '/config/storage-locations',
    '/config/sales-orgs',
    '/config/sales-orgs/assign-division',
    '/config/purchasing-orgs',
    '/config/purchasing-orgs/assign-company',
    '/config/purchasing-groups',
    '/config/number-ranges',
    '/config/number-range-objects',
    '/registry',
    '/finance/journal',
    '/finance/journal/new',
  ]);

  const percent =
    readiness.totalActivities === 0
      ? 0
      : Math.round((readiness.completedActivities / readiness.totalActivities) * 100);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-4 border-b border-line pb-4">
        <span className="code text-ink-faint">CFG.WORKBENCH</span>
        <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{t('workbench.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('workbench.subtitle')}</p>


        {params.created === '1' && (
          <p className="mt-3 border border-signal-ok/30 bg-signal-ok-soft px-3 py-2 text-sm text-signal-ok">
            Tenant created. Its roles and workbench checklist are ready. Maintain accounting number ranges before the first posting.
          </p>
        )}
      </header>

      <section className="panel mb-4 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-2xs uppercase tracking-wide text-ink-faint">
              {t('workbench.progress')}
            </p>
            <p className="mt-0.5 text-lg font-semibold tabular">
              {readiness.completedActivities} / {readiness.totalActivities}
              <span className="ms-2 text-sm font-normal text-ink-soft">{percent}%</span>
            </p>
          </div>
          {readiness.nextActivityTitle && (
            <div className="text-end">
              <p className="text-2xs uppercase tracking-wide text-ink-faint">
                {t('workbench.next')}
              </p>
              <p className="mt-0.5 text-sm font-medium">{readiness.nextActivityTitle}</p>
              <p className="code text-ink-faint">{readiness.nextActivity}</p>
            </div>
          )}
        </div>
        <div className="mt-3 h-1.5 w-full bg-sunken">
          <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
      </section>

      <WorkbenchTree rows={rows} completed={[...completed]} builtRoutes={[...BUILT_ROUTES]} />
    </div>
  );
}

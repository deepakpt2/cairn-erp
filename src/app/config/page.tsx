import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { listTenants, configReadiness } from '@/platform/tenancy';
import { requireSession } from '@/platform/auth/current';

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
    '/config/gl-accounts',
    '/config/payment-terms',
    '/config/posting-periods',
    '/config/plants',
    '/config/number-ranges',
    '/registry',
    '/finance/journal',
    '/finance/journal/new',
  ]);

  // Group into areas, preserving the define/assign sequence.
  const areas = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    if (!areas.has(row.area)) areas.set(row.area, []);
    areas.get(row.area)!.push(row);
  }

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

      <div className="space-y-4">
        {[...areas.entries()].map(([area, items]) => (
          <section key={area} className="panel overflow-hidden">
            <div className="panel-header">
              <h2 className="panel-title">{area.replace(/_/g, ' ').toLowerCase()}</h2>
              <span className="text-2xs text-ink-faint">
                {items.filter((i) => completed.has(i.code)).length} / {items.length}
              </span>
            </div>
            <table className="grid-table">
              <thead>
                <tr>
                  <th className="w-16">Step</th>
                  <th className="w-20">Kind</th>
                  <th>Activity</th>
                  <th className="w-72">{t('workbench.enables')}</th>
                  <th className="w-28">{t('workbench.prerequisites')}</th>
                  <th className="w-24" />
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const prereqs = item.prerequisites
                    .split(',')
                    .map((p) => p.trim())
                    .filter(Boolean);
                  const blocked =
                    !completed.has(item.code) && prereqs.some((p) => !completed.has(p));
                  const missing = prereqs.filter((p) => !completed.has(p));

                  return (
                    <tr key={item.code}>
                      <td className="tabular text-ink-faint">{item.sequence}</td>
                      <td>
                        <span
                          className={`chip ${
                            item.activity_kind === 'DEFINE' ? 'chip-info' : 'chip-neutral'
                          }`}
                        >
                          {item.activity_kind === 'DEFINE'
                            ? t('workbench.kind.define')
                            : t('workbench.kind.assign')}
                        </span>
                      </td>
                      <td>
                        <div className="font-medium">{item.title}</div>
                        <div className="code text-ink-faint">{item.code}</div>
                      </td>
                      <td className="text-ink-soft">{item.enables ?? '—'}</td>
                      <td className="text-2xs text-ink-faint">
                        {missing.length === 0 ? '—' : missing.join(', ')}
                      </td>
                      <td className="text-end">
                        {item.route_path && BUILT_ROUTES.has(item.route_path) ? (
                          <Link href={item.route_path} className="text-accent hover:underline">
                            Open
                          </Link>
                        ) : (
                          <span className="text-2xs text-ink-faint">Screen pending</span>
                        )}
                      </td>
                      <td className="text-end">
                        {completed.has(item.code) ? (
                          <span className="chip chip-ok">{t('workbench.status.completed')}</span>
                        ) : blocked ? (
                          <span
                            className="chip chip-warn"
                            title={`Waiting for: ${missing.join(', ')}`}
                          >
                            {t('workbench.status.blocked')}
                          </span>
                        ) : (
                          <span className="chip chip-neutral">
                            {t('workbench.status.notStarted')}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}

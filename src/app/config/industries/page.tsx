import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/industries';
const ACTIVITY = 'CFG.ORG.INDUSTRY.DEFINE';

/**
 * Maintain industries (SCR-077 / OB44 as a search alias only; inert
 * since stage 1).
 *
 * The industry master the business partner classifies under, with
 * descriptions by language. The service lands in a later stage; until
 * it stands, the screen renders its shape and maintains nothing.
 */
export default async function IndustriesPage() {
  const session = await requireSession(ROUTE);
  const canMaintain = can(session, ACTIVITY);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · OB44</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('industry.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('industry.subtitle')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      <section aria-labelledby="ind-grid" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ind-grid" className="text-sm font-semibold">Industries</h2>
        <p role="status" className="mt-2 text-sm text-ink-soft">
          The industry service is not yet connected; this screen stands inert until the service lands.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-ink-faint">
              <th className="py-1 pr-3 font-medium">Industry</th>
              <th className="py-1 pr-3 font-medium">Description</th>
              <th className="py-1 pr-3 font-medium">Language</th>
              <th className="py-1 pr-3 font-medium">Partners</th>
              <th className="py-1 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line/60 text-ink-faint">
              <td className="py-1 pr-3">—</td>
              <td className="py-1 pr-3">—</td>
              <td className="py-1 pr-3">—</td>
              <td className="py-1 pr-3">—</td>
              <td className="py-1">—</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section aria-labelledby="ind-create" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ind-create" className="text-sm font-semibold">New industry</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-4">
          <label className="text-xs text-ink-soft">
            Industry (max 4)
            <input name="industry" disabled className="input mt-1 w-full" placeholder="MEC1" />
          </label>
          <label className="text-xs text-ink-soft">
            Description (max 20)
            <input name="description" disabled className="input mt-1 w-full" placeholder="Mechanical Eng." />
          </label>
          <label className="text-xs text-ink-soft">
            Language
            <input name="language" disabled className="input mt-1 w-full" placeholder="en" />
          </label>
          <label className="text-xs text-ink-soft">
            Reason
            <input name="reason" disabled className="input mt-1 w-full" />
          </label>
        </div>
        <button type="button" disabled className="btn btn-primary mt-3 min-h-11 sm:min-h-8">
          Create industry
        </button>
      </section>
    </div>
  );
}

import Link from 'next/link';

import { t } from '@/platform/i18n';
import type { AttentionGroup, AttentionRow } from '@/platform/attention/types';

/**
 * Whole days something has been waiting. Zero today, negative for a date that
 * has not arrived yet — a delivery promised tomorrow is not late.
 */
function daysWaiting(waitingSince: string, today: string): number {
  if (!waitingSince) return 0;
  const then = Date.parse(`${waitingSince}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return 0;
  return Math.round((now - then) / 86_400_000);
}

function ageLabel(days: number): string {
  if (days < 0) return t('attention.dueIn', { n: Math.abs(days) });
  if (days === 0) return t('attention.today');
  if (days === 1) return t('attention.day', { n: 1 });
  return t('attention.days', { n: days });
}

/**
 * What waits on you — the panel above the Launchpad tiles.
 *
 * It is a server component and it holds no state, because there is nothing to
 * hold: the rows are a query, recomputed on every visit. There is no dismiss,
 * no snooze and no per-user hiding, by design. The only way to clear a row is
 * to do the work it points at, so the panel can never disagree with the
 * document behind it.
 *
 * It renders nothing at all when nothing is waiting. An empty attention panel
 * is not an empty state to be decorated; it is the absence of a section.
 */
export function AttentionPanel({ groups, today }: { groups: AttentionGroup[]; today: string }) {
  if (groups.length === 0) return null;

  const total = groups.reduce((sum, group) => sum + group.total, 0);

  return (
    <section className="panel mb-6 p-4" aria-labelledby="attention-heading">
      <div className="panel-header -m-4 mb-3 border-b">
        <h2 id="attention-heading" className="panel-title">{t('attention.title')}</h2>
        <span className="chip">
          {t(total === 1 ? 'attention.count' : 'attention.countMany', { n: total })}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <section key={group.source} className="min-w-0">
            <h3 className="flex items-baseline gap-2 border-b border-line pb-1 text-sm font-semibold">
              <span>{t(group.label)}</span>
              <span className="text-2xs text-ink-faint">{group.total}</span>
            </h3>

            <ul className="mt-1.5">
              {group.rows.map((row) => (
                <AttentionItem key={`${row.href}/${row.title}`} row={row} today={today} />
              ))}
            </ul>

            {group.more > 0 ? (
              <p className="mt-1.5 text-2xs uppercase tracking-wide text-ink-faint">
                {t('attention.more', { n: group.more })}
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </section>
  );
}

function AttentionItem({ row, today }: { row: AttentionRow; today: string }) {
  const days = daysWaiting(row.waitingSince, today);

  return (
    <li>
      <Link
        href={row.href}
        className="flex min-h-11 items-baseline gap-2 border-b border-line/60 py-1 hover:bg-surface"
      >
        <span className="min-w-0 flex-1">
          <span className="code block truncate text-sm">{row.title}</span>
          <span className="block truncate text-2xs text-ink-soft">{row.detail}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-2xs tabular-nums text-ink-faint">{ageLabel(days)}</span>
          {row.severity === 'BLOCKED' ? (
            <span className="chip chip-warn mt-0.5">{t('attention.blocked')}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

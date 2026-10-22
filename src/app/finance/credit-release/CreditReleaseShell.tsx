'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import type { CreditDeterminationView, CreditReleaseFilter, ReleaseOutcome } from '@/modules/finance/credit';
import {
  bulkReleaseAction, reblockAction, recheckAction, rejectAction, releaseAction,
  type ReleaseState,
} from './actions';

const INITIAL: ReleaseState = { outcomes: [] };

function DocumentLock({
  code,
  onMode,
}: {
  code: string;
  onMode: (code: string, mode: 'CHANGE' | 'DISPLAY' | 'WAITING') => void;
}) {
  const lock = useChangeLock('SALES_DOCUMENT', code, 'FIN.CREDIT.RELEASE', true);
  const mode = lock?.mode === 'CHANGE' ? 'CHANGE' : lock?.mode === 'DISPLAY' ? 'DISPLAY' : 'WAITING';
  useEffect(() => {
    onMode(code, mode);
    return () => onMode(code, 'WAITING');
  }, [code, mode, onMode]);
  return <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />;
}

function DocumentRow({
  salesDocument,
  status,
  version,
  release,
  releasing,
  reject,
  rejecting,
  reblock,
  reblocking,
}: {
  salesDocument: string;
  status: string;
  version: number;
  release: (payload: FormData) => void;
  releasing: boolean;
  reject: (payload: FormData) => void;
  rejecting: boolean;
  reblock: (payload: FormData) => void;
  reblocking: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lock = useChangeLock('SALES_DOCUMENT', salesDocument, 'FIN.CREDIT.RELEASE', open);
  const held = lock?.mode === 'CHANGE';
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-2xs text-accent">{t('release.actions')}</summary>
      <div className="mt-1 flex flex-col gap-1">
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
        <span className="flex gap-1">
          <form action={recheckAction}>
            <input type="hidden" name="salesDocument" value={salesDocument} />
            <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs" disabled={!held}>{t('release.recheck')}</button>
          </form>
          {status === 'BLOCKED' && (
            <form action={release}>
              <input type="hidden" name="salesDocument" value={salesDocument} />
              <input type="hidden" name="version" value={version} />
              <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs" disabled={!held || releasing}>{t('release.release')}</button>
            </form>
          )}
          {status === 'RELEASED' && (
            <form action={reblock} className="flex gap-1">
              <input type="hidden" name="salesDocument" value={salesDocument} />
              <input name="reason" className="field-input min-h-8 w-28 px-2 text-2xs" placeholder={t('release.reasonRequired')} />
              <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs" disabled={!held || reblocking}>{t('release.reblock')}</button>
            </form>
          )}
        </span>
        {status === 'BLOCKED' && (
          <form action={reject} className="flex gap-1">
            <input type="hidden" name="salesDocument" value={salesDocument} />
            <input name="reason" required className="field-input min-h-8 w-32 px-2 text-2xs" placeholder={t('release.reasonRequired')} />
            <button type="submit" className="btn btn-default min-h-8 px-2 text-2xs" disabled={!held || rejecting}>{t('release.reject')}</button>
          </form>
        )}
      </div>
    </details>
  );
}

/**
 * Release credit-blocked documents (SCR-105 / VKM3): the queue
 * of current credit determinations. Release re-evaluates against
 * today's credit standing; a still-failing document needs the
 * separate override privilege with justification. Bulk release
 * reports per-document results. Nothing here creates deliveries,
 * invoices or accounting entries.
 */
export default function CreditReleaseShell({ canUse, canOverride, determinations, filter }: {
  canUse: boolean;
  canOverride: boolean;
  determinations: CreditDeterminationView[];
  filter: CreditReleaseFilter;
}) {
  const [releaseState, release, releasing] = useActionState(releaseAction, INITIAL);
  const [bulkState, bulkRelease, bulkReleasing] = useActionState(bulkReleaseAction, INITIAL);
  const [rejectState, reject, rejecting] = useActionState(rejectAction, INITIAL);
  const [reblockState, reblock, reblocking] = useActionState(reblockAction, INITIAL);
  const outcomes: ReleaseOutcome[] = [
    ...releaseState.outcomes, ...bulkState.outcomes, ...rejectState.outcomes, ...reblockState.outcomes,
  ];
  const [selected, setSelected] = useState<string[]>([]);
  const [lockModes, setLockModes] = useState<Record<string, 'CHANGE' | 'DISPLAY' | 'WAITING'>>({});
  const reportLock = useCallback((code: string, mode: 'CHANGE' | 'DISPLAY' | 'WAITING') => {
    setLockModes((current) => (current[code] === mode ? current : { ...current, [code]: mode }));
  }, []);
  const locksHeld = selected.every((code) => lockModes[code] === 'CHANGE');

  if (!canUse) {
    return (
      <div className="panel p-4 text-sm text-ink-soft">
        {t('auth.missingAuthority', { authority: 'FIN.CREDIT.RELEASE' })}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {outcomes.length > 0 && (
        <div className="border border-line bg-sunken p-3" aria-label={t('release.results')}>
          <ul className="space-y-1 text-sm">
            {outcomes.map((o, i) => (
              <li key={`${o.salesDocument}-${i}`} className={o.ok ? 'text-signal-ok' : 'text-signal-error'}>
                <span className="code font-semibold">{o.salesDocument}</span> — {o.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(bulkState.message) && <p className="text-sm text-signal-warn">{bulkState.message}</p>}

      <form method="get" className="panel space-y-3 p-4" aria-label={t('release.filtersTitle')}>
        <div className="flex flex-wrap gap-3">
          <Field label={t('release.areaFrom')}>
            <input name="areaFrom" maxLength={4} defaultValue={filter.areaFrom ?? ''} className="field-input code w-28" />
          </Field>
          <Field label={t('release.salesOrg')}>
            <input name="salesOrg" maxLength={4} defaultValue={filter.salesOrg ?? ''} className="field-input code w-28" />
          </Field>
          <Field label={t('release.customerFrom')}>
            <input name="customerFrom" defaultValue={filter.customerFrom ?? ''} className="field-input code w-36" />
          </Field>
          <Field label={t('release.documentFrom')}>
            <input name="documentFrom" defaultValue={filter.documentFrom ?? ''} className="field-input code w-36" />
          </Field>
          <Field label={t('release.dateFrom')}>
            <input name="dateFrom" type="date" defaultValue={filter.dateFrom ?? ''} className="field-input w-40" />
          </Field>
          <Field label={t('release.dateTo')}>
            <input name="dateTo" type="date" defaultValue={filter.dateTo ?? ''} className="field-input w-40" />
          </Field>
          <Field label={t('release.flags')}>
            <span className="flex gap-3 pt-2 text-sm text-ink-soft">
              <label className="flex items-center gap-1">
                <input type="checkbox" name="blockedOnly" value="true" defaultChecked={filter.blockedOnly !== false} /> {t('release.blockedOnly')}
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" name="includeReleased" value="true" defaultChecked={filter.includeReleased} /> {t('release.includeReleased')}
              </label>
            </span>
          </Field>
        </div>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">{t('release.display')}</button>
      </form>

      <div className="panel space-y-3 p-4">
      <form id="bulk-release" action={bulkRelease} aria-label={t('release.bulkTitle')}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('release.justification')}>
            <input name="justification" maxLength={240} className="field-input w-72" placeholder={t('release.justificationHint')} />
          </Field>
          <Field label={t('release.approvalRef')}>
            <input name="approvalRef" maxLength={40} className="field-input code w-44" />
          </Field>
          {selected.map((code) => <DocumentLock key={code} code={code} onMode={reportLock} />)}
          <button type="submit" className="btn btn-primary min-h-8" disabled={bulkReleasing || (selected.length > 0 && !locksHeld)}>
            {bulkReleasing ? t('release.working') : t('release.bulkRelease')}
          </button>
          {!canOverride && <span className="text-2xs text-ink-faint">{t('release.noOverride')}</span>}
        </div>
      </form>

        <div className="overflow-x-auto">
          <table className="grid-table min-w-[76rem]">
            <thead>
              <tr>
                <th>{t('release.select')}</th>
                <th>{t('release.document')}</th><th>{t('release.date')}</th>
                <th>{t('release.customer')}</th><th>{t('release.area')}</th>
                <th className="text-end">{t('release.orderValue')}</th>
                <th className="text-end">{t('release.exposureLimit')}</th>
                <th className="text-end">{t('release.utilization')}</th>
                <th>{t('release.status')}</th><th>{t('release.reason')}</th>
                <th>{t('release.releasedBy')}</th><th>{t('release.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {determinations.map((d) => (
                <tr key={d.determinationId}>
                  <td>
                    {d.status === 'BLOCKED' && (
                      <input
                        type="checkbox"
                        form="bulk-release"
                        name={`doc_${d.salesDocument}`}
                        aria-label={t('release.select')}
                        checked={selected.includes(d.salesDocument)}
                        onChange={(event) => {
                          const code = d.salesDocument;
                          setSelected((current) => event.target.checked
                            ? [...current, code]
                            : current.filter((item) => item !== code));
                        }}
                      />
                    )}
                  </td>
                  <td className="code">{d.salesDocument}</td>
                  <td>{d.documentDate}</td>
                  <td>
                    <Link href={`/finance/credit?customer=${encodeURIComponent(d.customer)}&area=${encodeURIComponent(d.creditControlArea)}`} className="text-accent hover:underline">
                      {d.customerName} ({d.customer})
                    </Link>
                  </td>
                  <td className="code">{d.creditControlArea}</td>
                  <td className="tabular text-end">{d.orderValue.toFixed(2)} {d.orderCurrency}</td>
                  <td className="tabular text-end">{d.currentExposure.toFixed(2)} / {d.currentLimit === null ? '—' : d.currentLimit.toFixed(2)}</td>
                  <td className="tabular text-end">{d.utilizationPercent === null ? '—' : `${d.utilizationPercent.toFixed(1)}%`}</td>
                  <td>{d.status}{d.override ? ` (${t('release.overrideMark')})` : ''}</td>
                  <td className="code">{d.reason}</td>
                  <td className="code">{d.releasedBy ?? '—'}</td>
                  <td>
                    <DocumentRow
                      salesDocument={d.salesDocument}
                      status={d.status}
                      version={d.version}
                      release={release}
                      releasing={releasing}
                      reject={reject}
                      rejecting={rejecting}
                      reblock={reblock}
                      reblocking={reblocking}
                    />
                  </td>
                </tr>
              ))}
              {determinations.length === 0 && (
                <tr><td colSpan={12} className="text-sm text-ink-soft">{t('release.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import {
  cancelPeriodPackAction,
  logWorkspaceViewAction,
  pollPeriodPackAction,
  requestPeriodPackAction,
  searchHistoryAction,
  type AuditSearchState,
  type PeriodPackState,
} from './actions';
import type { PeriodPackView } from '@/modules/audit/period-evidence';

const MODULES = ['FIN', 'INV', 'PROD', 'PROC', 'SALES', 'CO', 'PEOPLE'] as const;

/**
 * Logs the view once, after render, through a server action — a server component
 * cannot safely write while it renders. Renders nothing.
 */
export function LogWorkspaceView({ detail }: { detail: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void logWorkspaceViewAction(detail);
  }, [detail]);
  return null;
}

const empty: AuditSearchState = { ok: false };

/** SM20 / SCU3: the change-document trail of one object, within the grant. Every search is logged. */
export function ChangeHistorySearch({ modules }: { modules: readonly string[] }) {
  const [state, action, pending] = useActionState(searchHistoryAction, empty);
  const choices = modules.length > 0 ? modules : MODULES;
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Change history — master data as it stood (SM20 / SCU3)</h2>
      <p className="text-sm text-ink-soft">
        Field-level before and after, with who, when and the transaction used. The search is logged against your grant.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <label>
          <span className="field-label">Object class</span>
          <input name="objectClass" className="field-input code" required maxLength={64} placeholder="gl_account" defaultValue={state.terms?.objectClass ?? ''} />
        </label>
        <label>
          <span className="field-label">Object key</span>
          <input name="objectKey" className="field-input code" required maxLength={120} defaultValue={state.terms?.objectKey ?? ''} />
        </label>
        <label>
          <span className="field-label">Module</span>
          <select name="module" className="field-input" required defaultValue={state.terms?.module || choices[0]}>
            {choices.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">Company code (optional)</span>
          <input name="companyCode" className="field-input code" maxLength={4} defaultValue={state.terms?.companyCode ?? ''} />
        </label>
      </div>
      <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Search</button>
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      {state.ok && state.rows && state.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead>
              <tr><th>When</th><th>Who</th><th>Change</th><th>Transaction</th><th>Field</th><th>Before</th><th>After</th></tr>
            </thead>
            <tbody>
              {state.rows.flatMap((doc, d) =>
                (doc.items.length ? doc.items : [{ field: '—', oldValue: null, newValue: null }]).map((item, i) => (
                  <tr key={`${d}-${i}`}>
                    <td className="text-xs">{i === 0 ? doc.changedAt : ''}</td>
                    <td className="code">{i === 0 ? doc.changedBy : ''}</td>
                    <td>{i === 0 ? doc.changeType : ''}</td>
                    <td className="code">{i === 0 ? doc.transactionCode ?? '—' : ''}</td>
                    <td className="code">{item.field}</td>
                    <td>{item.oldValue ?? '—'}</td>
                    <td>{item.newValue ?? '—'}</td>
                  </tr>
                )))}
            </tbody>
          </table>
        </div>
      )}
    </form>
  );
}

const packEmpty: PeriodPackState = { ok: false };
const ACTIVE = new Set(['QUEUED', 'RUNNING']);

/**
 * Period-close evidence pack: one form, an on-demand background request, a status that refreshes through a
 * server-authorised action, and a download link only when the pack is ready. Nothing blocks the page.
 */
export function PeriodPackPanel({ companies, canDownload, initialPackId }: { companies: readonly string[]; canDownload: boolean; initialPackId: string | null }) {
  const [state, action, pending] = useActionState(requestPeriodPackAction, packEmpty);
  const [pack, setPack] = useState<PeriodPackView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState('');
  const lastSeen = useRef<PeriodPackView | null>(null);

  // A fresh request key per submission; it only changes after a pack was created, so a double click replays.
  useEffect(() => { setRequestKey(`pack-${crypto.randomUUID()}`); }, []);
  useEffect(() => {
    if (state.ok && state.pack && state.pack !== lastSeen.current) {
      lastSeen.current = state.pack;
      setPack(state.pack);
      setRequestKey(`pack-${crypto.randomUUID()}`);
      try { window.history.replaceState(null, '', `?pack=${state.pack.packId}`); } catch { /* the URL is a convenience only */ }
    }
  }, [state]);

  const packId = pack?.packId ?? initialPackId;
  const status = pack?.status ?? null;
  useEffect(() => {
    if (!packId) return;
    let stopped = false;
    const poll = async () => {
      const next = await pollPeriodPackAction(packId);
      if (stopped) return;
      if (next.ok && next.pack) { setPack(next.pack); setNote(null); }
      else setNote(`${next.message ?? 'The status could not be read.'}${next.remedy ? ` ${next.remedy}` : ''}`);
    };
    void poll();
    if (status !== null && !ACTIVE.has(status)) return () => { stopped = true; };
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [packId, status]);

  const sel = state.selection;
  return (
    <section className="panel space-y-3 p-4" aria-label="Period-close evidence">
      <h2 className="panel-title">Period-close evidence</h2>
      <p className="text-sm text-ink-soft">
        A read-only pack for one company code, fiscal year and stored posting period: posting-period rules as they stand now, recorded rule changes,
        closing tasks and journal postings, with hashes. It reports what the system recorded. Whether and when the period was closed, and the authority
        behind any posting, are UNKNOWN / not recorded. Requesting and downloading are logged against your grant.
      </p>
      <form action={action} className="grid gap-3 sm:grid-cols-4">
        <input type="hidden" name="requestKey" value={requestKey} />
        <label>
          <span className="field-label">Company code</span>
          {companies.length > 0 ? (
            <select name="companyCode" className="field-input code" required defaultValue={sel?.companyCode || companies[0]}>
              {companies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input name="companyCode" className="field-input code" required maxLength={10} defaultValue={sel?.companyCode ?? ''} />
          )}
        </label>
        <label>
          <span className="field-label">Fiscal year</span>
          <input name="fiscalYear" className="field-input code" required inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="2026" defaultValue={sel?.fiscalYear ?? ''} />
        </label>
        <label>
          <span className="field-label">Posting period</span>
          <input name="postingPeriod" className="field-input code" required inputMode="numeric" pattern="\d{1,2}" maxLength={2} placeholder="12" defaultValue={sel?.postingPeriod ?? ''} />
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending || !requestKey}>Request pack</button>
        </div>
      </form>
      {!state.ok && state.message && (
        <p role="alert" className="text-sm text-signal-error">{state.message}{state.remedy ? ` ${state.remedy}` : ''}</p>
      )}
      {note && <p role="status" className="text-sm text-signal-error">{note}</p>}
      {pack && (
        <div role="status" aria-live="polite" className="space-y-1 text-sm">
          <p>
            Pack <span className="code">{pack.packId}</span> — <span className="chip">{pack.status}</span>{' '}
            {pack.companyCode} · {pack.fiscalYear} · period {pack.postingPeriod}
          </p>
          {pack.progressLabel && <p className="text-ink-soft">{pack.progressLabel}</p>}
          {pack.errorCode && <p className="text-signal-error">Ended with {pack.errorCode}. No downloadable pack exists.</p>}
          {pack.snapshotAt && <p className="text-xs text-ink-soft">Snapshot {pack.snapshotAt}; expires {pack.expiresAt ?? '—'}; manifest sha256 of the manifest file is in the download.</p>}
          {pack.downloadable && pack.downloadUrl && (
            canDownload
              ? <a className="underline" href={pack.downloadUrl} download>Download ZIP ({pack.byteLength ?? 0} bytes)</a>
              : <span className="text-ink-soft">Downloading needs AUDIT.EVIDENCE.EXPORT.</span>
          )}
          {ACTIVE.has(pack.status) && (
            <button type="button" className="btn btn-default ml-2 min-h-11 sm:min-h-8" onClick={() => { void cancelPeriodPackAction(pack.packId).then((r) => { if (r.ok && r.pack) setPack(r.pack); }); }}>
              Cancel
            </button>
          )}
          <p className="text-xs text-ink-soft">{pack.limitations}</p>
        </div>
      )}
    </section>
  );
}

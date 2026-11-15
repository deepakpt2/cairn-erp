'use client';

import { useActionState, useEffect, useRef } from 'react';

import { logWorkspaceViewAction, searchHistoryAction, type AuditSearchState } from './actions';

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

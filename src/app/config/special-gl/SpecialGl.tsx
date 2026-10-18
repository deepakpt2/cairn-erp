'use client';

import { useActionState } from 'react';

import type { SpecialGlRow } from '@/modules/foundation/special-gl';
import { deleteAction, maintainAction, type SpecialGlActionState } from './actions';

const INITIAL: SpecialGlActionState = { ok: false, message: '' };

function Message({ state }: { state: SpecialGlActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export function SpecialGl({ rows, canMaintain }: { rows: SpecialGlRow[]; canMaintain: boolean }) {
  const [maintainState, maintain, maintaining] = useActionState(maintainAction, INITIAL);
  const [deleteState, remove, deleting] = useActionState(deleteAction, INITIAL);

  return (
    <>
      <section aria-labelledby="sgl-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="sgl-list" className="text-sm font-semibold">Configured indicators</h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No special G/L indicator stands configured.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2">Company scope</th><th className="px-2 py-2">Account type</th>
                  <th className="px-2 py-2">Indicator</th><th className="px-2 py-2">Alternative account</th>
                  <th className="px-2 py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.companyCode}|${row.accountType}|${row.indicator}`} className="border-t border-line">
                    <td className="px-2 py-2">{row.companyCode || 'All companies'}</td>
                    <td className="px-2 py-2">{row.accountType === 'AP' ? 'Vendor (AP)' : 'Customer (AR)'}</td>
                    <td className="px-2 py-2">{row.indicator}</td>
                    <td className="px-2 py-2">{row.alternativeReconciliationAccount}</td>
                    <td className="px-2 py-2">{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canMaintain && (
        <section aria-labelledby="sgl-maintain" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="sgl-maintain" className="text-sm font-semibold">Maintain an indicator</h2>
          <form action={maintain}>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code (blank = all)</span>
                <input name="companyCode" className="input w-full" placeholder="1000" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Account type</span>
                <select name="accountType" className="input w-full" defaultValue="AP">
                  <option value="AP">Vendor (AP)</option>
                  <option value="AR">Customer (AR)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Indicator</span>
                <input name="indicator" className="input w-full" placeholder="A" maxLength={1} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Alternative reconciliation account</span>
                <input name="alternativeAccount" className="input w-full" placeholder="201000" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Description</span>
                <input name="description" className="input w-full" placeholder="Down payments" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
                <input name="reason" className="input w-full" placeholder="Why this changes" required />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={maintaining}>
                Save indicator
              </button>
            </div>
          </form>
          <Message state={maintainState} />

          <form action={remove} className="mt-4 border-t border-line pt-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code (blank = all)</span>
                <input name="companyCode" className="input w-full" placeholder="1000" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Account type</span>
                <select name="accountType" className="input w-full" defaultValue="AP">
                  <option value="AP">Vendor (AP)</option>
                  <option value="AR">Customer (AR)</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Indicator to delete</span>
                <input name="indicator" className="input w-full" placeholder="A" maxLength={1} required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
                <input name="reason" className="input w-full" placeholder="Why this goes" required />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={deleting}>
                Delete indicator
              </button>
            </div>
          </form>
          <Message state={deleteState} />
        </section>
      )}
    </>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { CheckingControlRow } from '@/modules/production/checking-control';
import { saveCheckingControlAction, type CheckingControlActionState } from './actions';

const INITIAL: CheckingControlActionState = { ok: false };
const LOCK_OBJECT = 'PRODUCTION_CHECKING_CONTROL';

function functionLabel(value: string): string {
  if (value === '1') return '1 creation';
  if (value === '2') return '2 release';
  return value;
}

function indicatorLabel(value: string): string {
  return value === 'X' ? 'X' : 'Blank';
}

function indicatorValue(value: string): string {
  return value === 'X' ? 'X' : 'BLANK';
}

export default function CheckingControlForm({
  controls,
  canMaintain,
}: {
  controls: CheckingControlRow[];
  canMaintain: boolean;
}) {
  const [editing, setEditing] = useState<CheckingControlRow | null>(null);
  const [state, action, pending] = useActionState(saveCheckingControlAction, INITIAL);
  const lock = useChangeLock(
    LOCK_OBJECT,
    editing ? `${editing.plant}/${editing.orderType}/${editing.businessFunction}` : null,
    'OPJK',
    canMaintain && Boolean(editing),
  );

  return (
    <div className="space-y-4">
      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Plant, order type, and business function</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Opening this list does not create a record. A combination that is not listed is not configured.
          It does not mean check, and it does not mean no check.
        </p>
        {controls.length === 0 ? (
          <p className="mt-2 text-sm">No checking control stands.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Plant</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Function</th>
                <th className="px-2 py-2">No check</th>
                <th className="px-2 py-2">Rule</th>
                <th className="px-2 py-2">Check on save</th>
                {canMaintain && <th className="px-2 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {controls.map((row) => (
                <tr key={`${row.plant}/${row.orderType}/${row.businessFunction}`} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{row.plant}</td>
                  <td className="px-2 py-2 code">{row.orderType}</td>
                  <td className="px-2 py-2">{functionLabel(row.businessFunction)}</td>
                  <td className="px-2 py-2 code">{indicatorLabel(row.noCheck)}</td>
                  <td className="px-2 py-2 code">{row.checkingRule ?? '—'}</td>
                  <td className="px-2 py-2 code">{indicatorLabel(row.checkOnSave)}</td>
                  {canMaintain && (
                    <td className="px-2 py-2">
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setEditing(row)}>Change</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {canMaintain && (
        <form
          key={editing ? `${editing.plant}/${editing.orderType}/${editing.businessFunction}` : 'new'}
          action={action}
          className="space-y-3 border border-line bg-white p-4"
        >
          <h2 className="text-sm font-semibold">{editing ? 'Change checking control' : 'Create checking control'}</h2>
          {editing && <LockNotice message={lock?.message} />}
          {state.message && (
            <p role="status" className={state.ok ? 'text-sm' : 'text-sm text-red-700'}>
              {state.message}{state.remedy ? ` ${state.remedy}` : ''}
            </p>
          )}
          <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
          <input type="hidden" name="version" value={editing?.version ?? 0} />
          <label className="block text-sm">
            Plant
            <input name="plant" defaultValue={editing?.plant ?? ''} maxLength={10} className="field-input code mt-1 w-full" readOnly={Boolean(editing)} required />
          </label>
          <label className="block text-sm">
            Order type
            <input name="orderType" defaultValue={editing?.orderType ?? ''} maxLength={4} className="field-input code mt-1 w-full" readOnly={Boolean(editing)} required />
          </label>
          <label className="block text-sm">
            Business function
            <select
              name="businessFunction"
              defaultValue={editing?.businessFunction ?? ''}
              className="field-input mt-1 w-full"
              required
              disabled={Boolean(editing)}
            >
              <option value="">Choose</option>
              <option value="1">1 — Check availability during order creation</option>
              <option value="2">2 — Check availability during order release</option>
            </select>
          </label>
          {editing && <input type="hidden" name="businessFunction" value={editing.businessFunction} />}
          <label className="block text-sm">
            No material availability check
            <select name="noCheck" defaultValue={editing ? indicatorValue(editing.noCheck) : ''} className="field-input mt-1 w-full" required>
              <option value="">Choose</option>
              <option value="X">X — No material availability check</option>
              <option value="BLANK">Blank — No-check indicator is not set</option>
            </select>
          </label>
          <label className="block text-sm">
            Checking rule
            <input name="checkingRule" defaultValue={editing?.checkingRule ?? ''} maxLength={2} className="field-input code mt-1 w-full" />
          </label>
          <label className="block text-sm">
            Check material availability when saving the order
            <select name="checkOnSave" defaultValue={editing ? indicatorValue(editing.checkOnSave) : ''} className="field-input mt-1 w-full" required>
              <option value="">Choose</option>
              <option value="X">X — Check material availability when saving the order</option>
              <option value="BLANK">Blank — Check-on-save indicator is not set</option>
            </select>
          </label>
          <p className="text-sm text-ink-soft">
            Choose each indicator. A missing record is not either choice. Blank is not a default rule.
            Saving does not run a check and does not release an order.
          </p>
          <label className="block text-sm">
            Reason
            <input name="reason" className="field-input mt-1 w-full" required />
          </label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>Save checking control</button>
        </form>
      )}
    </div>
  );
}

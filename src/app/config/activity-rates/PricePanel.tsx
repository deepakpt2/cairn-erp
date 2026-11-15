'use client';

import { useActionState } from 'react';

import type { CalculableActivity } from '@/modules/foundation/activity-price';
import { activityPriceAction, type PriceRunState } from './price-actions';

const STATUS_CHIP: Record<string, string> = { CALCULATED: 'chip chip-ok', SKIPPED: 'chip', REFUSED: 'chip chip-warn' };
const STATUS_WORD: Record<string, string> = { CALCULATED: 'calculated', SKIPPED: 'skipped', REFUSED: 'refused' };

/**
 * Activity price calculation (KSPI) beside the planning matrix that refuses entered prices for
 * automatic indicators. Shows first what a run over the selection would do; Preview renders the
 * prices without writing; Calculate writes them and renders what stood written.
 */
export function PricePanel({
  selection,
  periods,
  currency,
  planned,
  defaultRange,
  requestKey,
}: {
  selection: { controllingArea: string; fiscalYear: number; planVersion: string };
  periods: number[];
  currency: string;
  planned: CalculableActivity[];
  /** The periods the listing judged (those in which activity is planned). */
  defaultRange: { periodFrom: number; periodTo: number } | null;
  requestKey: string;
}) {
  const [state, action, pending] = useActionState<PriceRunState, FormData>(activityPriceAction, { ok: false });
  const view = state.view;
  return (
    <section className="panel space-y-3 p-4" aria-label="Activity price calculation">
      <h2 className="panel-title">Activity price calculation (KSPI)</h2>
      <p className="text-sm text-ink-soft">
        For activity types on price indicator 1: the cost centre&apos;s planned primary cost over its planned activity quantity,
        times the price unit, as the fixed price (the variable price is set to zero — no cost element is marked fixed or variable).
        Manual types (3) are never touched. Capacity-based types (2) cannot be calculated: the work centre carries no cost centre.
        Prices hold two decimals; what rounding leaves over is shown as the residual.
      </p>

      <div className="overflow-x-auto">
        {defaultRange && (
          <p className="mb-1 text-xs text-ink-soft">What a run over periods {defaultRange.periodFrom}–{defaultRange.periodTo} (where activity is planned) would do:</p>
        )}
        <table className="grid-table text-xs" aria-label="What a run over the year would do">
          <thead><tr><th>Cost centre</th><th>Activity type</th><th>Indicator</th><th>Planned quantity</th><th>Planned cost ({currency})</th><th>Run would</th><th>Why</th></tr></thead>
          <tbody>
            {planned.length === 0 ? (
              <tr><td colSpan={7} className="text-ink-soft">No activity is planned for version {selection.planVersion} in {selection.fiscalYear}.</td></tr>
            ) : planned.map((p) => (
              <tr key={`${p.costCenter}/${p.activityType}`}>
                <td className="code">{p.costCenter}</td>
                <td className="code">{p.activityType}</td>
                <td>{p.priceIndicator}</td>
                <td className="code">{p.plannedQuantity}</td>
                <td className="code">{p.plannedCost}</td>
                <td><span className={STATUS_CHIP[p.status]}>{STATUS_WORD[p.status]}</span></td>
                <td className="text-ink-soft">{p.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form action={action} className="space-y-3">
        <input type="hidden" name="controllingArea" value={selection.controllingArea} />
        <input type="hidden" name="fiscalYear" value={selection.fiscalYear} />
        <input type="hidden" name="planVersion" value={selection.planVersion} />
        <input type="hidden" name="requestKey" value={requestKey} />
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="field-label">Period from</span>
            <select name="periodFrom" defaultValue={String(defaultRange?.periodFrom ?? periods[0] ?? 1)} className="field-input">
              {periods.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Period to</span>
            <select name="periodTo" defaultValue={String(defaultRange?.periodTo ?? periods.at(-1) ?? 12)} className="field-input">
              {periods.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Basis</span>
            <select name="basis" defaultValue="ANNUAL" className="field-input">
              <option value="ANNUAL">Annual — one price for the range</option>
              <option value="PERIOD">Period — a price per period</option>
            </select>
          </label>
          <label className="min-w-64 flex-1">
            <span className="field-label">Reason (required to calculate)</span>
            <input name="reason" maxLength={500} className="field-input w-full" />
          </label>
        </div>
        <div className="flex gap-2">
          <button type="submit" name="action" value="preview" className="btn btn-default min-h-11 sm:min-h-8" disabled={pending}>Preview</button>
          <button type="submit" name="action" value="calculate" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Calculate</button>
        </div>
      </form>

      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}

      {view && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">
            {state.mode === 'calculate' && view.written ? 'Written' : 'Preview'} · {view.controllingArea} · version {view.planVersion} · {view.fiscalYear} · periods {view.periodFrom}–{view.periodTo} · {view.basis.toLowerCase()} basis · {view.iterations} iteration
          </h3>
          {view.refusals.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-signal-error">{view.refusals.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
          <div className="overflow-x-auto">
            <table className="grid-table text-xs" aria-label="Calculated prices">
              <thead><tr><th>Cost centre</th><th>Activity type</th><th>Status</th><th>Quantity</th><th>Cost ({currency})</th><th>Old price(s)</th><th>New price(s)</th><th>Residual ({currency})</th></tr></thead>
              <tbody>
                {view.pairs.map((p) => {
                  const olds = [...new Set(p.oldPrices.map((o) => `${o.fixedPrice}${Number(o.variablePrice) ? ` + ${o.variablePrice}` : ''}`))];
                  const news = [...new Set(p.newPrices.map((n) => `${n.price} / ${n.priceUnit}`))];
                  return (
                    <tr key={`${p.costCenter}/${p.activityType}`}>
                      <td className="code">{p.costCenter}</td>
                      <td className="code">{p.activityType}</td>
                      <td><span className={STATUS_CHIP[p.status]}>{STATUS_WORD[p.status]}</span></td>
                      <td className="code">{p.quantity}</td>
                      <td className="code">{p.cost}</td>
                      <td className="code">{olds.join(', ')}</td>
                      <td className="code">{p.status === 'CALCULATED' ? (news.length === 1 ? news[0] : p.newPrices.map((n) => `P${n.period} ${n.price}`).join(', ')) : (p.reason ?? '')}</td>
                      <td className="code">{p.status === 'CALCULATED' ? p.residual : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-soft">
            Total rounding residual {view.totalResidual} {view.currency}: planned cost the two-decimal prices do not absorb. It is rounding, not a variance.
          </p>
        </div>
      )}
    </section>
  );
}

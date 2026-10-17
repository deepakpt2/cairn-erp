'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import type {
  ActivityRateRow,
  PlanningContext,
} from '../../../modules/foundation/activity-rate-definition';
import type { CostCenterArea } from '../../../modules/foundation/cost-center-definition';
import {
  deleteActivityRateAction,
  saveActivityRatesAction,
  type ActivityRateActionState,
} from './actions';

export interface RateSelection {
  area: string;
  version: string;
  year: string;
  center: string;
  type: string;
}

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: ActivityRateActionState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className="border border-line bg-white p-3 text-sm text-ink"
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

function DeleteDialog({
  selection,
  period,
}: {
  selection: RateSelection;
  period: number;
}) {
  const [state, formAction, pending] = useActionState<ActivityRateActionState, FormData>(
    deleteActivityRateAction,
    { ok: true },
  );
  const label = `${selection.center} / ${selection.type} · period ${period}`;
  return (
    <details className="min-w-16">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        Delete
      </summary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${label}`}
        className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
      >
        <div className="mx-auto max-w-2xl">
          <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
            <div>
              <span className="code text-xs text-ink-faint">KP26 · {label}</span>
              <p className="font-semibold">Delete {label}</p>
            </div>
            <button
              type="button"
              className="btn btn-default min-h-11 sm:min-h-9"
              onClick={(event) => {
                const details = event.currentTarget.closest('details');
                if (details) details.open = false;
              }}
            >
              Close
            </button>
          </div>
          <section className="panel overflow-hidden p-4">
            <form className="space-y-3" action={formAction}>
              <input type="hidden" name="controllingArea" value={selection.area} />
              <input type="hidden" name="planVersion" value={selection.version} />
              <input type="hidden" name="fiscalYear" value={selection.year} />
              <input type="hidden" name="period" value={period} />
              <input type="hidden" name="costCenter" value={selection.center} />
              <input type="hidden" name="activityType" value={selection.type} />
              <p className="text-sm text-ink-soft">
                Deleting removes this period&apos;s planned row. Nothing consumes rates yet, so no
                usage count stands against deletion today; allocations will give it one when they
                land.
              </p>
              <div>
                <label htmlFor={`rate-delete-reason-${period}`} className="field-label">
                  Reason<RequiredMark />
                </label>
                <textarea
                  id={`rate-delete-reason-${period}`}
                  name="reason"
                  className="field-input"
                  rows={2}
                  maxLength={500}
                  required
                />
              </div>
              <Message state={state} />
              <button type="submit" className="btn-primary" disabled={pending}>
                Delete activity rate
              </button>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

export default function ActivityRates({
  areas,
  selection,
  centers,
  types,
  context,
  rates,
  canMaintain,
}: {
  areas: CostCenterArea[];
  selection: RateSelection;
  centers: string[];
  types: string[];
  context: PlanningContext | null;
  rates: ActivityRateRow[];
  canMaintain: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActivityRateActionState, FormData>(
    saveActivityRatesAction,
    { ok: true },
  );
  const [reason, setReason] = useState('');
  const push = (next: Partial<RateSelection>) => {
    const merged = { ...selection, ...next };
    const query = new URLSearchParams(
      Object.entries(merged).filter(([, value]) => value !== ''),
    );
    router.push(`/config/activity-rates?${query.toString()}`);
  };
  const byPeriod = new Map(rates.map((row) => [row.period, row]));
  const ready =
    context !== null && selection.center !== '' && selection.type !== '' && selection.version !== '';

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Controlling area</span>
          <select
            value={selection.area}
            onChange={(event) => push({ area: event.target.value, center: '', type: '' })}
            className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink"
          >
            <option value="">Choose a controlling area</option>
            {areas.map((entry) => (
              <option key={entry.controllingArea} value={entry.controllingArea}>
                {entry.controllingArea} — {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Planning version (up to 3)</span>
          <input
            value={selection.version}
            maxLength={3}
            onChange={(event) => push({ version: event.target.value.toUpperCase() })}
            className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Fiscal year</span>
          <input
            value={selection.year}
            inputMode="numeric"
            maxLength={4}
            onChange={(event) => push({ year: event.target.value })}
            className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Cost centre</span>
          <select
            value={selection.center}
            onChange={(event) => push({ center: event.target.value })}
            className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink"
          >
            <option value="">Choose a cost centre</option>
            {centers.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Activity type</span>
          <select
            value={selection.type}
            onChange={(event) => push({ type: event.target.value })}
            className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink"
          >
            <option value="">Choose an activity type</option>
            {types.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        {context && (
          <p className="self-end text-sm text-ink-soft">
            Currency {context.currency} · Fiscal year variant {context.fiscalYearVariant}
          </p>
        )}
      </div>

      <form id="act-rate-form" action={formAction} className="hidden">
        <input type="hidden" name="controllingArea" value={selection.area} />
        <input type="hidden" name="planVersion" value={selection.version} />
        <input type="hidden" name="fiscalYear" value={selection.year} />
        <input type="hidden" name="costCenter" value={selection.center} />
        <input type="hidden" name="activityType" value={selection.type} />
        <input
          type="hidden"
          name="periods"
          value={context ? context.periods.map((period) => period.period).join(',') : ''}
        />
        <input type="hidden" name="reason" value={reason} />
      </form>

      <section className="panel overflow-hidden" aria-labelledby="act-rate-grid-title">
        <div className="panel-header">
          <h2 id="act-rate-grid-title" className="panel-title">Planned activity and prices by period</h2>
        </div>
        {!context ? (
          <p className="p-4 text-sm text-ink-soft">Choose a controlling area to see its planning periods.</p>
        ) : selection.center === '' || selection.type === '' ? (
          <p className="p-4 text-sm text-ink-soft">
            Choose a cost centre and an activity type to plan against.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[900px]">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Window</th>
                  <th>Planned activity</th>
                  <th>Fixed price</th>
                  <th>Variable price</th>
                  <th>Per (units)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {context.periods.map((period) => {
                  const rate = byPeriod.get(period.period);
                  return (
                    <tr key={period.period}>
                      <td className="code">
                        {period.period}
                        {period.periodType === 'SPECIAL' ? ' (special)' : ''}
                      </td>
                      <td>
                        {period.start} → {period.end}
                      </td>
                      <td>
                        <input
                          form="act-rate-form"
                          name={`p${period.period}Quantity`}
                          disabled={!canMaintain}
                          inputMode="decimal"
                          placeholder="0.000"
                          defaultValue={rate?.plannedQuantity ?? ''}
                          className="w-28 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Planned activity period ${period.period}`}
                        />
                      </td>
                      <td>
                        <input
                          form="act-rate-form"
                          name={`p${period.period}FixedPrice`}
                          disabled={!canMaintain}
                          inputMode="decimal"
                          placeholder="0.00"
                          defaultValue={rate?.fixedPrice ?? ''}
                          className="w-24 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Fixed price period ${period.period}`}
                        />
                      </td>
                      <td>
                        <input
                          form="act-rate-form"
                          name={`p${period.period}VariablePrice`}
                          disabled={!canMaintain}
                          inputMode="decimal"
                          placeholder="0.00"
                          defaultValue={rate?.variablePrice ?? ''}
                          className="w-24 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Variable price period ${period.period}`}
                        />
                      </td>
                      <td>
                        <input
                          form="act-rate-form"
                          name={`p${period.period}PriceUnit`}
                          disabled={!canMaintain}
                          inputMode="numeric"
                          defaultValue={rate?.priceUnit ?? 1}
                          className="w-16 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Price unit period ${period.period}`}
                        />
                      </td>
                      <td>
                        {canMaintain && rate ? (
                          <DeleteDialog selection={selection} period={period.period} />
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {canMaintain && ready && (
          <div className="space-y-3 p-4">
            <div className="max-w-xl">
              <label htmlFor="act-rate-reason" className="field-label">
                Reason<RequiredMark />
              </label>
              <textarea
                id="act-rate-reason"
                className="field-input"
                rows={2}
                maxLength={500}
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <Message state={state} />
            <button type="submit" form="act-rate-form" className="btn-primary" disabled={pending}>
              Save plan
            </button>
            <p className="text-xs text-ink-soft">
              Prices are in the controlling area&apos;s currency, per the price unit shown. Whether
              price components may be entered follows the activity type&apos;s price indicator:
              manual indicators keep them, automatic indicators refuse them until a calculation
              exists to own the price. Every period cell in view is saved with the act.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

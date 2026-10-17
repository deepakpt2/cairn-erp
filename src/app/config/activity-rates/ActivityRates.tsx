'use client';

import { useRouter } from 'next/navigation';

import type {
  ActivityRateRow,
  PlanningContext,
} from '../../../modules/foundation/activity-rate-definition';
import type { CostCenterArea } from '../../../modules/foundation/cost-center-definition';

const INERT_NOTE =
  'Stage 1 of 5: this screen is inert — the activity rate table and the matrix write arrive in the following stages.';

export interface RateSelection {
  area: string;
  version: string;
  year: string;
  center: string;
  type: string;
}

export default function ActivityRates({
  areas,
  selection,
  centers,
  types,
  context,
  rates,
}: {
  areas: CostCenterArea[];
  selection: RateSelection;
  centers: string[];
  types: string[];
  context: PlanningContext | null;
  rates: ActivityRateRow[];
}) {
  const router = useRouter();
  const push = (next: Partial<RateSelection>) => {
    const merged = { ...selection, ...next };
    const query = new URLSearchParams(
      Object.entries(merged).filter(([, value]) => value !== ''),
    );
    router.push(`/config/activity-rates?${query.toString()}`);
  };
  const byPeriod = new Map(rates.map((row) => [row.period, row]));

  return (
    <div className="space-y-4">
      <p role="note" className="border border-line bg-paper px-4 py-3 text-sm text-ink">
        {INERT_NOTE}
      </p>
      <p className="max-w-3xl text-sm text-ink-soft">
        Activity prices are planned per cost centre, activity type, planning version, fiscal year
        and fiscal period: a planned quantity in the type&apos;s unit, with a fixed and a variable
        price component per price unit in the controlling area&apos;s currency. Validity is judged
        per period against both masters; nothing calculates or allocates against these rows yet.
      </p>

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
                          disabled
                          inputMode="decimal"
                          placeholder="0.000"
                          defaultValue={rate?.plannedQuantity ?? ''}
                          className="w-28 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Planned activity period ${period.period}`}
                        />
                      </td>
                      <td>
                        <input
                          disabled
                          inputMode="decimal"
                          placeholder="0.00"
                          defaultValue={rate?.fixedPrice ?? ''}
                          className="w-24 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Fixed price period ${period.period}`}
                        />
                      </td>
                      <td>
                        <input
                          disabled
                          inputMode="decimal"
                          placeholder="0.00"
                          defaultValue={rate?.variablePrice ?? ''}
                          className="w-24 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Variable price period ${period.period}`}
                        />
                      </td>
                      <td>
                        <input
                          disabled
                          inputMode="numeric"
                          defaultValue={rate?.priceUnit ?? 1}
                          className="w-16 rounded-none border border-line bg-paper px-2 py-1 text-sm text-ink"
                          aria-label={`Price unit period ${period.period}`}
                        />
                      </td>
                      <td>
                        <button type="button" disabled className="text-sm text-ink-soft">
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="space-y-2 p-4">
          <button
            type="button"
            disabled
            className="rounded-none border border-line bg-paper px-4 py-2 text-sm font-medium text-ink"
          >
            Save plan
          </button>
          <p className="text-xs text-ink-soft">
            A reason is required on every write (later stages). Prices are in the controlling
            area&apos;s currency; whether price components may be entered follows the activity
            type&apos;s price indicator.
          </p>
        </div>
      </section>
    </div>
  );
}

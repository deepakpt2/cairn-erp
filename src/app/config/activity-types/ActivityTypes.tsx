'use client';

import { useRouter } from 'next/navigation';

import type { CostCenterArea, CostCenterCategory } from '../../../modules/foundation/cost-center-definition';
import type {
  ActivityCategoryOption,
  ActivityTypeRow,
  ActivityUnitChoice,
} from '../../../modules/foundation/activity-type-definition';

function labelOf(options: ActivityCategoryOption[], code: string): string {
  return options.find((entry) => entry.code === code)?.label ?? code;
}

const INERT_NOTE =
  'Stage 1 of 5: this screen is inert — the activity type table and the write arrive in the following stages.';

export default function ActivityTypes({
  areas,
  selectedArea,
  rows,
  units,
  categories,
  priceIndicators,
  ccCategories,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  rows: ActivityTypeRow[];
  units: ActivityUnitChoice[];
  categories: ActivityCategoryOption[];
  priceIndicators: ActivityCategoryOption[];
  ccCategories: CostCenterCategory[];
}) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <p role="note" className="border border-line bg-paper px-4 py-3 text-sm text-ink">
        {INERT_NOTE}
      </p>
      <p className="max-w-3xl text-sm text-ink-soft">
        Activity types are the measurable output cost centres perform, defined period by period
        inside a controlling area: the unit they are measured in, how they allocate, and how their
        price is found. Rates per cost centre and period follow as their own activity; nothing
        prices or allocates against these rows yet.
      </p>
      <label className="block max-w-sm">
        <span className="mb-1 block text-sm font-medium text-ink">Controlling area</span>
        <select
          value={selectedArea}
          onChange={(event) =>
            router.push(`/config/activity-types?area=${encodeURIComponent(event.target.value)}`)
          }
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

      <fieldset disabled className="max-w-3xl rounded-none border border-line bg-paper p-4">
        <legend className="px-2 text-sm font-semibold text-ink">Define an activity type period</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Activity type (up to 6)</span>
            <input maxLength={6} placeholder="LAB01" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Name</span>
            <input maxLength={40} placeholder="Direct Labor Hours" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Valid from</span>
            <input type="date" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Valid to</span>
            <input type="date" defaultValue="9999-12-31" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Activity unit</span>
            <select className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink">
              <option value="">Choose a unit of measure</option>
              {units.map((unit) => (
                <option key={unit.code} value={unit.code}>
                  {unit.code} — {unit.name} ({unit.dimension})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Activity category</span>
            <select className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink">
              {categories.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code} — {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Price indicator</span>
            <select className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink">
              {priceIndicators.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code} — {entry.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="block">
            <legend className="mb-1 text-sm font-medium text-ink">Valid for cost centre categories</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {ccCategories.map((entry) => (
                <label key={entry.category} className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" value={entry.category} />
                  {entry.category}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-ink-soft">None chosen = valid for every category.</p>
          </fieldset>
        </div>
        <button
          type="button"
          disabled
          className="mt-4 rounded-none border border-line bg-paper px-4 py-2 text-sm font-medium text-ink"
        >
          Save activity type period
        </button>
        <p className="mt-3 text-sm text-ink-soft">
          The key is (controlling area, activity type, valid from); periods of one type may not
          overlap. A reason is required on every write (later stages).
        </p>
      </fieldset>

      <section className="panel overflow-hidden" aria-labelledby="act-type-grid-title">
        <div className="panel-header">
          <h2 id="act-type-grid-title" className="panel-title">Activity types</h2>
        </div>
        {selectedArea === '' ? (
          <p className="p-4 text-sm text-ink-soft">Choose a controlling area to see its activity types.</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No activity types are defined for this controlling area yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[900px]">
              <thead>
                <tr>
                  <th>Activity type</th>
                  <th>Valid</th>
                  <th>Name</th>
                  <th>Unit</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Posting</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.activityType}:${row.validFrom}`}>
                    <td className="code">{row.activityType}</td>
                    <td>
                      {row.validFrom} → {row.validTo}
                    </td>
                    <td>{row.name}</td>
                    <td className="code">{row.activityUnit}</td>
                    <td>
                      {row.category} — {labelOf(categories, row.category)}
                    </td>
                    <td>
                      {row.priceIndicator} — {labelOf(priceIndicators, row.priceIndicator)}
                    </td>
                    <td>{row.isPostingLocked ? 'Locked' : 'Open'}</td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled className="text-sm text-ink-soft">Change</button>
                        <button type="button" disabled className="text-sm text-ink-soft">
                          {row.isPostingLocked ? 'Unlock' : 'Lock'}
                        </button>
                        <button type="button" disabled className="text-sm text-ink-soft">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

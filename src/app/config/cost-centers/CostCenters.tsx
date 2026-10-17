'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import type {
  CostCenterArea,
  CostCenterCategory,
  CostCenterRow,
} from '../../../modules/foundation/cost-center-definition';

const INERT_NOTE =
  'Stage 1 of 5: this screen is inert — the cost centre table and the write arrive in the following stages.';

export default function CostCenters({
  areas,
  selectedArea,
  rows,
  companyCodes,
  categories,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  rows: CostCenterRow[];
  companyCodes: string[];
  categories: CostCenterCategory[];
}) {
  const router = useRouter();
  const [lockTarget, setLockTarget] = useState<CostCenterRow | null>(null);
  const area = areas.find((entry) => entry.controllingArea === selectedArea);
  return (
    <div className="space-y-6">
      <p role="note" className="rounded-none border border-line bg-paper px-4 py-3 text-sm text-ink">
        {INERT_NOTE}
      </p>
      <p className="max-w-3xl text-sm text-ink-soft">
        Cost centres are defined period by period inside a controlling area: each period carries its
        company code, a responsible person and a category. A period can be deleted only while no
        journal document dated inside it carries the centre — afterwards the posting lock is the
        standing alternative. Hierarchy placement arrives with the hierarchy screen; postings carry
        centre codes as text today and do not validate them against these rows yet.
      </p>
      <label className="block max-w-sm">
        <span className="mb-1 block text-sm font-medium text-ink">Controlling area</span>
        <select
          value={selectedArea}
          onChange={(event) =>
            router.push(`/config/cost-centers?area=${encodeURIComponent(event.target.value)}`)
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
      {area ? (
        <p className="text-sm text-ink-soft">
          Currency for cost centres in this area: <strong>{area.currency.trim()}</strong> (from the
          controlling area).
        </p>
      ) : null}

      <fieldset disabled className="max-w-3xl rounded-none border border-line bg-paper p-4">
        <legend className="px-2 text-sm font-semibold text-ink">Create a cost centre period</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Cost centre</span>
            <input required maxLength={10} className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Name</span>
            <input required maxLength={40} className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Valid from</span>
            <input type="date" required className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Valid to</span>
            <input type="date" required className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Person responsible (optional)</span>
            <input maxLength={20} className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Category</span>
            <select className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink">
              {categories.map((entry) => (
                <option key={entry.category} value={entry.category}>
                  {entry.category}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Company code</span>
            <select className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink">
              <option value="">Choose a company code assigned to this area</option>
              {companyCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          disabled
          className="mt-4 rounded-none border border-line bg-paper px-4 py-2 text-sm font-medium text-ink"
        >
          Save cost centre period
        </button>
        <p className="mt-3 text-sm text-ink-soft">
          The key is (controlling area, cost centre, valid from); periods of one centre may not
          overlap. A reason is required on every write (later stages).
        </p>
      </fieldset>

      {selectedArea === '' ? (
        <p className="text-sm text-ink-soft">Choose a controlling area to see its cost centres.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-soft">No cost centres are defined for this controlling area yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-none border border-line bg-paper">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th className="px-4 py-3 font-medium">Cost centre</th>
                <th className="px-4 py-3 font-medium">Valid</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Company code</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Posting</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={`${row.costCenter}:${row.validFrom}`}>
                  <td className="code px-4 py-3 text-ink">{row.costCenter}</td>
                  <td className="px-4 py-3 text-ink">
                    {row.validFrom} → {row.validTo}
                  </td>
                  <td className="px-4 py-3 text-ink">{row.name}</td>
                  <td className="code px-4 py-3 text-ink">{row.companyCode}</td>
                  <td className="px-4 py-3 text-ink">{row.category}</td>
                  <td className="px-4 py-3 text-ink">{row.isPostingLocked ? 'Locked' : 'Open'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled className="rounded-none border border-line bg-paper px-3 py-1.5 text-sm text-ink">
                        Change
                      </button>
                      <button
                        type="button"
                        onClick={() => setLockTarget(row)}
                        className="rounded-none border border-line bg-paper px-3 py-1.5 text-sm text-ink"
                      >
                        {row.isPostingLocked ? 'Unlock' : 'Lock'}
                      </button>
                      <button type="button" disabled className="rounded-none border border-line bg-paper px-3 py-1.5 text-sm text-ink">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lockTarget ? (
        <div className="max-w-3xl rounded-none border border-line bg-paper p-4">
          <h3 className="text-base font-semibold text-ink">
            {lockTarget.isPostingLocked ? 'Unlock' : 'Lock'} cost centre {lockTarget.costCenter}
          </h3>
          <p className="mt-2 text-sm text-ink-soft">
            Locking stops new postings to this centre; the centre keeps its history and stays listed.
            Deletion is refused while journal documents dated inside the period carry the centre.
          </p>
          <label className="mt-3 block">
            <span className="mb-1 block text-sm font-medium text-ink">Reason</span>
            <textarea required rows={3} className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <div className="mt-3 flex gap-2">
            <button type="button" disabled className="rounded-none border border-line bg-paper px-4 py-2 text-sm font-medium text-ink">
              Confirm (later stages)
            </button>
            <button
              type="button"
              onClick={() => setLockTarget(null)}
              className="rounded-none border border-line bg-paper px-4 py-2 text-sm text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

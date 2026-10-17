'use client';

import { useRouter } from 'next/navigation';

import type { CostCenterArea } from '../../../modules/foundation/cost-center-definition';
import type {
  ProfitCenterRow,
  ResponsibleUserChoice,
} from '../../../modules/foundation/profit-center-definition';

const INERT_NOTE =
  'Stage 1 of 5: this screen is inert — the profit centre table and the write arrive in the following stages.';

export default function ProfitCenters({
  areas,
  selectedArea,
  rows,
  users,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  rows: ProfitCenterRow[];
  users: ResponsibleUserChoice[];
}) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <p role="note" className="border border-line bg-paper px-4 py-3 text-sm text-ink">
        {INERT_NOTE}
      </p>
      <p className="max-w-3xl text-sm text-ink-soft">
        Profit centres are the units profitability is reported on, defined period by period inside
        a controlling area. Hierarchy placement arrives with the profit centre hierarchy activity,
        as it did for cost centres; the segment is entered freely until a segment master stands.
      </p>
      <label className="block max-w-sm">
        <span className="mb-1 block text-sm font-medium text-ink">Controlling area</span>
        <select
          value={selectedArea}
          onChange={(event) =>
            router.push(`/config/profit-centers?area=${encodeURIComponent(event.target.value)}`)
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
        <legend className="px-2 text-sm font-semibold text-ink">Define a profit centre period</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Profit centre (up to 10)</span>
            <input maxLength={10} placeholder="PC100" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Name (up to 20)</span>
            <input maxLength={20} placeholder="Services Profit Ctr" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Valid from</span>
            <input type="date" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Valid to</span>
            <input type="date" defaultValue="9999-12-31" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-ink">Long text (up to 40, optional)</span>
            <input maxLength={40} placeholder="Services & Consulting Profit Center" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Person responsible (optional)</span>
            <input maxLength={20} placeholder="Jane Doe" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Responsible user (optional)</span>
            <select className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink">
              <option value="">No responsible user</option>
              {users.map((user) => (
                <option key={user.username} value={user.username}>
                  {user.username} — {user.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Segment (up to 10, optional)</span>
            <input maxLength={10} placeholder="SEG_CORP" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
          </label>
        </div>
        <button
          type="button"
          disabled
          className="mt-4 rounded-none border border-line bg-paper px-4 py-2 text-sm font-medium text-ink"
        >
          Save profit centre period
        </button>
        <p className="mt-3 text-sm text-ink-soft">
          The key is (controlling area, profit centre, valid from); periods of one centre may not
          overlap. A reason is required on every write (later stages).
        </p>
      </fieldset>

      <section className="panel overflow-hidden" aria-labelledby="pc-grid-title">
        <div className="panel-header">
          <h2 id="pc-grid-title" className="panel-title">Profit centres</h2>
        </div>
        {selectedArea === '' ? (
          <p className="p-4 text-sm text-ink-soft">Choose a controlling area to see its profit centres.</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No profit centres are defined for this controlling area yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[900px]">
              <thead>
                <tr>
                  <th>Profit centre</th>
                  <th>Valid</th>
                  <th>Name</th>
                  <th>Person responsible</th>
                  <th>User</th>
                  <th>Segment</th>
                  <th>Posting</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.profitCenter}:${row.validFrom}`}>
                    <td className="code">{row.profitCenter}</td>
                    <td>
                      {row.validFrom} → {row.validTo}
                    </td>
                    <td>{row.name}</td>
                    <td>{row.personResponsible || '—'}</td>
                    <td className="code">{row.responsibleUser ?? '—'}</td>
                    <td className="code">{row.segment ?? '—'}</td>
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

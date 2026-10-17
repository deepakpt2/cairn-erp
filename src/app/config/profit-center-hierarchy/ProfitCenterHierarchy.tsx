'use client';

import { useRouter } from 'next/navigation';

import type { CostCenterArea } from '../../../modules/foundation/cost-center-definition';
import type { HierarchyView } from '../../../modules/foundation/profit-center-hierarchy';

const INERT_NOTE =
  'Stage 1 of 5: this screen is inert — the hierarchy tables and the write arrive in the following stages.';

export default function ProfitCenterHierarchy({
  areas,
  selectedArea,
  view,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  view: HierarchyView;
}) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <p role="note" className="border border-line bg-paper px-4 py-3 text-sm text-ink">
        {INERT_NOTE}
      </p>
      <p className="max-w-3xl text-sm text-ink-soft">
        The standard hierarchy is one tree per controlling area into which profit centre periods
        are placed — each period on exactly one node — beside alternative groups whose leaves are
        single centres, ranges, and exclusions resolved against the master. Nothing rolls up over
        this tree yet.
      </p>
      <label className="block max-w-sm">
        <span className="mb-1 block text-sm font-medium text-ink">Controlling area</span>
        <select
          value={selectedArea}
          onChange={(event) =>
            router.push(
              `/config/profit-center-hierarchy?area=${encodeURIComponent(event.target.value)}`,
            )
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
        <legend className="px-2 text-sm font-semibold text-ink">Define the standard hierarchy</legend>
        <label className="block max-w-md">
          <span className="mb-1 block text-sm font-medium text-ink">Hierarchy title</span>
          <input maxLength={40} placeholder="Standard hierarchy" className="w-full rounded-none border border-line bg-paper px-3 py-2 text-base text-ink" />
        </label>
        <button
          type="button"
          disabled
          className="mt-4 rounded-none border border-line bg-paper px-4 py-2 text-sm font-medium text-ink"
        >
          Define hierarchy
        </button>
      </fieldset>

      <section className="panel overflow-hidden" aria-labelledby="pch-tree-title">
        <div className="panel-header">
          <h2 id="pch-tree-title" className="panel-title">
            {view.hierarchyTitle
              ? `Standard hierarchy — ${view.hierarchyTitle}`
              : 'Standard hierarchy'}
          </h2>
        </div>
        {selectedArea === '' ? (
          <p className="p-4 text-sm text-ink-soft">Choose a controlling area to see its hierarchy.</p>
        ) : view.nodes.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">
            No hierarchy is defined for this controlling area yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[700px]">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Title</th>
                  <th>Periods placed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.nodes.map((node) => (
                  <tr key={node.node}>
                    <td className="code" style={{ paddingInlineStart: `${node.depth * 24 + 8}px` }}>
                      {node.node}
                    </td>
                    <td>{node.title}</td>
                    <td className="tabular">{node.assignedPeriods}</td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled className="text-sm text-ink-soft">Change</button>
                        <button type="button" disabled className="text-sm text-ink-soft">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view.unplacedPeriods.length > 0 && (
          <p className="p-4 text-sm text-ink-soft">
            Unplaced periods:{' '}
            {view.unplacedPeriods
              .map((period) => `${period.profitCenter} from ${period.validFrom}`)
              .join('; ')}
          </p>
        )}
      </section>

      <section className="panel overflow-hidden" aria-labelledby="pch-groups-title">
        <div className="panel-header">
          <h2 id="pch-groups-title" className="panel-title">Alternative groups</h2>
        </div>
        {view.groups.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No alternative groups are defined yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {view.groups.map((group) => (
              <li key={group.groupName} className="p-4">
                <p className="font-medium">
                  <span className="code">{group.groupName}</span> — {group.title}
                </p>
                <p className="mt-1 text-sm text-ink-soft">
                  Members: {group.members.length > 0 ? group.members.join(', ') : 'none'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

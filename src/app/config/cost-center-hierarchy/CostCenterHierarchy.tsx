'use client';

import { useRouter } from 'next/navigation';

import type { CostCenterArea } from '../../../modules/foundation/cost-center-definition';
import type { HierarchyView } from '../../../modules/foundation/cost-center-hierarchy';

const INERT_NOTE =
  'Stage 1 of 5: this screen is inert — the hierarchy tables and the write arrive in the following stages.';

const inputClass = 'field-input';

export default function CostCenterHierarchy({
  areas,
  selectedArea,
  view,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  view: HierarchyView;
}) {
  const router = useRouter();
  const allPeriods = [
    ...view.unplacedPeriods.map((period) => ({ ...period, node: '' })),
    ...view.placements,
  ].sort((a, b) => a.costCenter.localeCompare(b.costCenter) || a.validFrom.localeCompare(b.validFrom));
  return (
    <div className="space-y-4">
      <p role="note" className="border border-line bg-paper px-4 py-3 text-sm text-ink">
        {INERT_NOTE}
      </p>
      <p className="max-w-3xl text-sm text-ink-soft">
        Two structures stand here. The standard hierarchy is the controlling area&apos;s one tree:
        cost centre periods are placed into its nodes, one node per period. Alternative groups are
        sets beside the tree — a centre may sit in any number of them, and their leaves may name
        single centres, ranges, or exclusions. Rollups and reports do not read either structure yet.
      </p>
      <label className="block max-w-sm">
        <span className="mb-1 block text-sm font-medium text-ink">Controlling area</span>
        <select
          value={selectedArea}
          onChange={(event) =>
            router.push(
              `/config/cost-center-hierarchy?area=${encodeURIComponent(event.target.value)}`,
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

      <section className="panel overflow-hidden" aria-labelledby="hierarchy-tree-title">
        <div className="panel-header">
          <h2 id="hierarchy-tree-title" className="panel-title">
            Standard hierarchy{view.hierarchyTitle ? ` — ${view.hierarchyTitle}` : ''}
          </h2>
        </div>
        {selectedArea === '' ? (
          <p className="p-4 text-sm text-ink-soft">Choose a controlling area to see its hierarchy.</p>
        ) : view.nodes.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">
            No hierarchy is defined for this controlling area yet. The first node defined becomes
            its root.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[760px]">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Title</th>
                  <th>Parent</th>
                  <th>Order</th>
                  <th>Placed periods</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.nodes.map((node) => (
                  <tr key={node.node}>
                    <td className="code" style={{ paddingInlineStart: `${1 + node.depth * 1.5}rem` }}>
                      {node.node}
                    </td>
                    <td>{node.title}</td>
                    <td className="code">{node.parentNode ?? '— (root)'}</td>
                    <td>{node.displayOrder}</td>
                    <td>{node.assignedPeriods}</td>
                    <td>
                      <button type="button" disabled className="text-sm text-ink-soft">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <fieldset disabled className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="hier-node" className="field-label">Node (up to 24)</label>
              <input id="hier-node" className={inputClass} maxLength={24} placeholder="PRODUCTION" />
            </div>
            <div>
              <label htmlFor="hier-node-title" className="field-label">Title</label>
              <input id="hier-node-title" className={inputClass} maxLength={40} />
            </div>
            <div>
              <label htmlFor="hier-node-parent" className="field-label">Parent node</label>
              <select id="hier-node-parent" className={inputClass} defaultValue="">
                <option value="">(root — first node only)</option>
                {view.nodes.map((node) => (
                  <option key={node.node} value={node.node}>
                    {node.node}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="hier-node-order" className="field-label">Display order</label>
              <input id="hier-node-order" type="number" className={inputClass} defaultValue={0} />
            </div>
          </div>
          <p className="text-xs text-ink-soft">
            A reason is required on every write (later stages). Nodes cannot form cycles and the
            tree is guarded at ten levels.
          </p>
          <button type="button" disabled className="btn-primary">
            Define node
          </button>
        </fieldset>
      </section>

      <section className="panel overflow-hidden" aria-labelledby="hierarchy-place-title">
        <div className="panel-header">
          <h2 id="hierarchy-place-title" className="panel-title">Period placement</h2>
        </div>
        {view.unplacedPeriods.length > 0 ? (
          <p className="p-4 pb-0 text-sm text-ink-soft">
            Unplaced periods: {view.unplacedPeriods
              .map((period) => `${period.costCenter} from ${period.validFrom}`)
              .join(', ')}
          </p>
        ) : (
          <p className="p-4 pb-0 text-sm text-ink-soft">Every period standing is placed.</p>
        )}
        <fieldset disabled className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="place-period" className="field-label">Cost centre period</label>
              <select id="place-period" className={inputClass} defaultValue="">
                <option value="">Choose a period</option>
                {allPeriods.map((period) => (
                  <option
                    key={`${period.costCenter}:${period.validFrom}`}
                    value={`${period.costCenter}:${period.validFrom}`}
                  >
                    {period.costCenter} from {period.validFrom}
                    {period.node ? ` (in ${period.node})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="place-node" className="field-label">Node</label>
              <select id="place-node" className={inputClass} defaultValue="">
                <option value="">Choose a node</option>
                {view.nodes.map((node) => (
                  <option key={node.node} value={node.node}>
                    {node.node}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="button" disabled className="btn-primary">
            Place period
          </button>
        </fieldset>
        {view.placements.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[640px]">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Cost centre</th>
                  <th>Valid from</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.placements.map((placement) => (
                  <tr key={`${placement.node}:${placement.costCenter}:${placement.validFrom}`}>
                    <td className="code">{placement.node}</td>
                    <td className="code">{placement.costCenter}</td>
                    <td>{placement.validFrom}</td>
                    <td>
                      <button type="button" disabled className="text-sm text-ink-soft">
                        Unassign
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="panel overflow-hidden" aria-labelledby="hierarchy-groups-title">
        <div className="panel-header">
          <h2 id="hierarchy-groups-title" className="panel-title">Alternative groups</h2>
        </div>
        {view.groups.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No alternative groups are defined for this area yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[760px]">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Title</th>
                  <th>Leaves</th>
                  <th>Resolved members</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {view.groups.map((group) => (
                  <tr key={group.groupName}>
                    <td className="code">{group.groupName}</td>
                    <td>{group.title}</td>
                    <td className="code">
                      {group.leaves
                        .map((leaf) =>
                          leaf.valOption === 'BT'
                            ? `${leaf.valSign} ${leaf.valFrom}..${leaf.valTo}`
                            : `${leaf.valSign} ${leaf.valFrom}`,
                        )
                        .join(', ') || '—'}
                    </td>
                    <td className="code">{group.members.join(', ') || '—'}</td>
                    <td>
                      <button type="button" disabled className="text-sm text-ink-soft">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <fieldset disabled className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="group-name" className="field-label">Group (up to 24)</label>
              <input id="group-name" className={inputClass} maxLength={24} placeholder="NORTHPLANTS" />
            </div>
            <div>
              <label htmlFor="group-title" className="field-label">Title</label>
              <input id="group-title" className={inputClass} maxLength={40} />
            </div>
            <div>
              <label htmlFor="leaf-sign" className="field-label">Leaf sign</label>
              <select id="leaf-sign" className={inputClass} defaultValue="I">
                <option value="I">Include (I)</option>
                <option value="E">Exclude (E)</option>
              </select>
            </div>
            <div>
              <label htmlFor="leaf-option" className="field-label">Leaf option</label>
              <select id="leaf-option" className={inputClass} defaultValue="EQ">
                <option value="EQ">Single centre (EQ)</option>
                <option value="BT">Range (BT)</option>
              </select>
            </div>
            <div>
              <label htmlFor="leaf-from" className="field-label">From centre</label>
              <input id="leaf-from" className={inputClass} maxLength={10} />
            </div>
            <div>
              <label htmlFor="leaf-to" className="field-label">To centre (ranges)</label>
              <input id="leaf-to" className={inputClass} maxLength={10} />
            </div>
          </div>
          <button type="button" disabled className="btn-primary">
            Define group / add leaf
          </button>
        </fieldset>
      </section>
    </div>
  );
}

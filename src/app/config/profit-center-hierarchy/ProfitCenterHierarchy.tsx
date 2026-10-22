'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { CostCenterArea } from '../../../modules/foundation/cost-center-definition';
import type {
  GroupRow,
  HierarchyNodeRow,
  HierarchyView,
} from '../../../modules/foundation/profit-center-hierarchy';
import {
  addLeafAction,
  deleteGroupAction,
  deleteHierarchyNodeAction,
  placePeriodAction,
  removeLeafAction,
  saveGroupAction,
  saveHierarchyHeaderAction,
  saveHierarchyNodeAction,
  unplacePeriodAction,
  type HierarchyActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: HierarchyActionState }) {
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

function ReasonField({ id }: { id: string }) {
  const [reason, setReason] = useState('');
  return (
    <div>
      <label htmlFor={id} className="field-label">
        Reason<RequiredMark />
      </label>
      <textarea
        id={id}
        name="reason"
        className="field-input"
        rows={2}
        maxLength={500}
        required
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </div>
  );
}

function DialogShell({
  summary,
  title,
  code,
  children,
  onOpen,
}: {
  summary: string;
  title: string;
  code: string;
  children: React.ReactNode;
  onOpen?: (open: boolean) => void;
}) {
  return (
    <details className="min-w-16" onToggle={(event) => onOpen?.(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {summary}
      </summary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
      >
        <div className="mx-auto max-w-2xl">
          <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
            <div>
              <span className="code text-xs text-ink-faint">KCH1/KCH5N · {code}</span>
              <p className="font-semibold">{title}</p>
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
          <section className="panel overflow-hidden p-4">{children}</section>
        </div>
      </div>
    </details>
  );
}

function useAction(action: typeof saveHierarchyNodeAction) {
  return useActionState<HierarchyActionState, FormData>(action, { ok: true });
}

/* ── Hierarchy header ─────────────────────────────────────────────── */

function DefineHierarchyPanel({ selectedArea }: { selectedArea: string }) {
  const [state, formAction, pending] = useAction(saveHierarchyHeaderAction as never);
  return (
    <section className="panel overflow-hidden" aria-labelledby="hier-define-title">
      <div className="panel-header">
        <h2 id="hier-define-title" className="panel-title">Define the standard hierarchy</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <div>
          <label htmlFor="hier-title" className="field-label">
            Hierarchy title<RequiredMark />
          </label>
          <input id="hier-title" name="title" required maxLength={40} className="field-input" />
        </div>
        <ReasonField id="hier-define-reason" />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Define hierarchy
        </button>
      </form>
    </section>
  );
}

/* ── Nodes ────────────────────────────────────────────────────────── */

function NodeFields({
  idPrefix,
  row,
  nodes,
}: {
  idPrefix: string;
  row: HierarchyNodeRow | null;
  nodes: HierarchyNodeRow[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`${idPrefix}-title`} className="field-label">
          Title<RequiredMark />
        </label>
        <input
          id={`${idPrefix}-title`}
          name="title"
          required
          maxLength={40}
          className="field-input"
          defaultValue={row?.title ?? ''}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-parent`} className="field-label">Parent node</label>
        <select
          id={`${idPrefix}-parent`}
          name="parentNode"
          className="field-input"
          defaultValue={row?.parentNode ?? ''}
        >
          <option value="">(root)</option>
          {nodes
            .filter((node) => node.node !== row?.node)
            .map((node) => (
              <option key={node.node} value={node.node}>
                {node.node}
              </option>
            ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-order`} className="field-label">Display order</label>
        <input
          id={`${idPrefix}-order`}
          name="displayOrder"
          type="number"
          className="field-input"
          defaultValue={row?.displayOrder ?? 0}
        />
      </div>
    </div>
  );
}

function CreateNodePanel({
  selectedArea,
  nodes,
}: {
  selectedArea: string;
  nodes: HierarchyNodeRow[];
}) {
  const [state, formAction, pending] = useAction(saveHierarchyNodeAction as never);
  return (
    <section className="panel overflow-hidden" aria-labelledby="hier-node-create-title">
      <div className="panel-header">
        <h2 id="hier-node-create-title" className="panel-title">New node</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <div>
          <label htmlFor="hier-node-key" className="field-label">
            Node<RequiredMark />
          </label>
          <input
            id="hier-node-key"
            name="node"
            required
            maxLength={24}
            className="field-input code"
            placeholder="PRODUCTION"
          />
          <p className="mt-1 text-xs text-ink-soft">
            The first node defined, with no parent, becomes the root; there is exactly one root.
          </p>
        </div>
        <NodeFields idPrefix="hier-node" row={null} nodes={nodes} />
        <ReasonField id="hier-node-reason" />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Define node
        </button>
      </form>
    </section>
  );
}

function ChangeNodeDialog({
  row,
  nodes,
  selectedArea,
  onOpen,
  held,
  notice,
}: {
  row: HierarchyNodeRow;
  nodes: HierarchyNodeRow[];
  selectedArea: string;
  onOpen: (open: boolean) => void;
  held: boolean;
  notice: string | null;
}) {
  const [state, formAction, pending] = useAction(saveHierarchyNodeAction as never);
  const label = `Node ${row.node}`;
  return (
    <DialogShell summary="Change" title={`Change ${label}`} code={row.node} onOpen={onOpen}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="mode" value="CHANGE" />
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <input type="hidden" name="node" value={row.node} />
        <NodeFields idPrefix={`hier-node-${row.node}`} row={row} nodes={nodes} />
        <ReasonField id={`hier-node-change-reason-${row.node}`} />
        <Message state={state} />
        <LockNotice message={notice} />
        <button type="submit" className="btn-primary" disabled={pending || !held}>
          Save changes
        </button>
      </form>
    </DialogShell>
  );
}

function DeleteNodeDialog({
  row,
  childCount,
  selectedArea,
  onOpen,
  held,
  notice,
}: {
  row: HierarchyNodeRow;
  childCount: number;
  selectedArea: string;
  onOpen: (open: boolean) => void;
  held: boolean;
  notice: string | null;
}) {
  const [state, formAction, pending] = useAction(deleteHierarchyNodeAction as never);
  const label = `Node ${row.node}`;
  const blocked = childCount > 0 || row.assignedPeriods > 0;
  return (
    <DialogShell summary="Delete" title={`Delete ${label}`} code={row.node} onOpen={onOpen}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <input type="hidden" name="node" value={row.node} />
        <p className="text-sm text-ink-soft">
          A node is deleted only while no child node and no placed period stands under it.
        </p>
        {blocked ? (
          <p role="status" className="text-sm text-ink-soft">
            {childCount} child node{childCount === 1 ? '' : 's'} and {row.assignedPeriods} placed
            period{row.assignedPeriods === 1 ? '' : 's'} stand under this node — deletion is refused.
          </p>
        ) : null}
        <ReasonField id={`hier-node-delete-reason-${row.node}`} />
        <Message state={state} />
        <LockNotice message={notice} />
        <button type="submit" className="btn-primary" disabled={pending || blocked || !held}>
          Delete node
        </button>
      </form>
    </DialogShell>
  );
}

/* ── Placement ────────────────────────────────────────────────────── */

function PlacementPanel({
  selectedArea,
  view,
}: {
  selectedArea: string;
  view: HierarchyView;
}) {
  const [state, formAction, pending] = useAction(placePeriodAction as never);
  const [periodKey, setPeriodKey] = useState('');
  const [engaged, setEngaged] = useState(false);
  const [profitCenter = '', validFrom = ''] = periodKey.split(':');
  const placementLock = useChangeLock(
    'PROFIT_CENTER_PLACEMENT',
    periodKey ? `${selectedArea}/${profitCenter}/${validFrom}` : '',
    'CFG.COST.PROFITCENTERHIER.DEFINE',
    engaged && periodKey !== '',
  );
  const placementHeld = !engaged || periodKey === '' || placementLock?.mode === 'CHANGE';
  const allPeriods = [
    ...view.unplacedPeriods.map((period) => ({ ...period, node: '' })),
    ...view.placements,
  ].sort((a, b) => a.profitCenter.localeCompare(b.profitCenter) || a.validFrom.localeCompare(b.validFrom));
  return (
    <section className="panel overflow-hidden" aria-labelledby="hierarchy-place-title">
      <div className="panel-header">
        <h2 id="hierarchy-place-title" className="panel-title">Period placement</h2>
      </div>
      {view.unplacedPeriods.length > 0 ? (
        <p className="p-4 pb-0 text-sm text-ink-soft">
          Unplaced periods: {view.unplacedPeriods
            .map((period) => `${period.profitCenter} from ${period.validFrom}`)
            .join(', ')}
        </p>
      ) : (
        <p className="p-4 pb-0 text-sm text-ink-soft">Every period standing is placed.</p>
      )}
      <form className="space-y-3 p-4" action={formAction} onFocus={() => setEngaged(true)} onSubmit={(event) => { if (periodKey !== '' && placementLock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="place-period" className="field-label">
              Profit centre period<RequiredMark />
            </label>
            <select id="place-period" name="period" required className="field-input" value={periodKey} onChange={(event) => setPeriodKey(event.target.value)}>
              <option value="">Choose a period</option>
              {allPeriods.map((period) => (
                <option
                  key={`${period.profitCenter}:${period.validFrom}`}
                  value={`${period.profitCenter}:${period.validFrom}`}
                >
                  {period.profitCenter} from {period.validFrom}
                  {period.node ? ` (in ${period.node})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="place-node" className="field-label">
              Node<RequiredMark />
            </label>
            <select id="place-node" name="node" required className="field-input" defaultValue="">
              <option value="">Choose a node</option>
              {view.nodes.map((node) => (
                <option key={node.node} value={node.node}>
                  {node.node}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ReasonField id="place-reason" />
        <Message state={state} />
        <LockNotice message={placementLock?.mode === 'DISPLAY' ? placementLock.message : null} />
        <button type="submit" className="btn-primary" disabled={pending || !placementHeld}>
          Place period
        </button>
      </form>
      {view.placements.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[40rem]">
            <thead>
              <tr>
                <th>Node</th>
                <th>Profit centre</th>
                <th>Valid from</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {view.placements.map((placement) => (
                <tr key={`${placement.node}:${placement.profitCenter}:${placement.validFrom}`}>
                  <td className="code">{placement.node}</td>
                  <td className="code">{placement.profitCenter}</td>
                  <td>{placement.validFrom}</td>
                  <td>
                    <UnassignDialog placement={placement} selectedArea={selectedArea} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function UnassignDialog({
  placement,
  selectedArea,
}: {
  placement: { node: string; profitCenter: string; validFrom: string };
  selectedArea: string;
}) {
  const [state, formAction, pending] = useAction(unplacePeriodAction as never);
  const [open, setOpen] = useState(false);
  const label = `${placement.profitCenter} from ${placement.validFrom}`;
  const lock = useChangeLock(
    'PROFIT_CENTER_PLACEMENT',
    `${selectedArea}/${placement.profitCenter}/${placement.validFrom}`,
    'CFG.COST.PROFITCENTERHIER.DEFINE',
    open,
  );
  return (
    <DialogShell summary="Unassign" title={`Unassign ${label}`} code={label} onOpen={setOpen}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <input type="hidden" name="node" value={placement.node} />
        <input type="hidden" name="profitCenter" value={placement.profitCenter} />
        <input type="hidden" name="validFrom" value={placement.validFrom} />
        <p className="text-sm text-ink-soft">
          Unassigning removes the placement only; the profit centre period itself stands.
        </p>
        <ReasonField id={`unplace-reason-${placement.profitCenter}-${placement.validFrom}`} />
        <Message state={state} />
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
        <button type="submit" className="btn-primary" disabled={pending || lock?.mode !== 'CHANGE'}>
          Unassign period
        </button>
      </form>
    </DialogShell>
  );
}

/* ── Alternative groups ───────────────────────────────────────────── */

function CreateGroupPanel({ selectedArea }: { selectedArea: string }) {
  const [state, formAction, pending] = useAction(saveGroupAction as never);
  return (
    <section className="panel overflow-hidden" aria-labelledby="hier-group-create-title">
      <div className="panel-header">
        <h2 id="hier-group-create-title" className="panel-title">New alternative group</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="group-name" className="field-label">
              Group<RequiredMark />
            </label>
            <input id="group-name" name="groupName" required maxLength={24} className="field-input code" placeholder="NORTHPLANTS" />
          </div>
          <div>
            <label htmlFor="group-title" className="field-label">
              Title<RequiredMark />
            </label>
            <input id="group-title" name="title" required maxLength={40} className="field-input" />
          </div>
        </div>
        <ReasonField id="group-create-reason" />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Define group
        </button>
      </form>
    </section>
  );
}

function GroupCard({ group, selectedArea }: { group: GroupRow; selectedArea: string }) {
  const [leafState, leafAction, leafPending] = useAction(addLeafAction as never);
  const [deleteState, deleteAction, deletePending] = useAction(deleteGroupAction as never);
  const [engaged, setEngaged] = useState(false);
  const groupLock = useChangeLock(
    'PROFIT_CENTER_GROUP',
    `${selectedArea}/${group.groupName}`,
    'CFG.COST.PROFITCENTERHIER.DEFINE',
    engaged,
  );
  const groupHeld = !engaged || groupLock?.mode === 'CHANGE';
  return (
    <section className="panel overflow-hidden" aria-labelledby={`group-${group.groupName}`}>
      <div className="panel-header flex flex-wrap items-center justify-between gap-3">
        <h3 id={`group-${group.groupName}`} className="panel-title">
          {group.groupName} — {group.title}
        </h3>
        <span className="code text-xs text-ink-soft">
          Members: {group.members.join(', ') || '—'}
        </span>
      </div>
      {group.leaves.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[40rem]">
            <thead>
              <tr>
                <th>Sign</th>
                <th>Option</th>
                <th>From</th>
                <th>To</th>
                <th>Order</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {group.leaves.map((leaf) => (
                <tr key={`${leaf.valSign}${leaf.valOption}:${leaf.valFrom}..${leaf.valTo}`}>
                  <td className="code">{leaf.valSign === 'I' ? 'Include' : 'Exclude'}</td>
                  <td className="code">{leaf.valOption === 'BT' ? 'Range' : 'Single'}</td>
                  <td className="code">{leaf.valFrom}</td>
                  <td className="code">{leaf.valTo || '—'}</td>
                  <td>{leaf.displayOrder}</td>
                  <td>
                    <RemoveLeafDialog group={group} leaf={leaf} selectedArea={selectedArea} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="p-4 text-sm text-ink-soft">No leaves stand in this group yet.</p>
      )}
      <form className="space-y-3 border-t border-line p-4" action={leafAction} onFocus={() => setEngaged(true)} onSubmit={(event) => { if (groupLock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <input type="hidden" name="groupName" value={group.groupName} />
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor={`leaf-${group.groupName}-sign`} className="field-label">Sign</label>
            <select id={`leaf-${group.groupName}-sign`} name="valSign" className="field-input" defaultValue="I">
              <option value="I">Include (I)</option>
              <option value="E">Exclude (E)</option>
            </select>
          </div>
          <div>
            <label htmlFor={`leaf-${group.groupName}-option`} className="field-label">Option</label>
            <select id={`leaf-${group.groupName}-option`} name="valOption" className="field-input" defaultValue="EQ">
              <option value="EQ">Single centre (EQ)</option>
              <option value="BT">Range (BT)</option>
            </select>
          </div>
          <div>
            <label htmlFor={`leaf-${group.groupName}-order`} className="field-label">Display order</label>
            <input id={`leaf-${group.groupName}-order`} name="displayOrder" type="number" className="field-input" defaultValue={0} />
          </div>
          <div>
            <label htmlFor={`leaf-${group.groupName}-from`} className="field-label">
              From centre<RequiredMark />
            </label>
            <input id={`leaf-${group.groupName}-from`} name="valFrom" required maxLength={10} className="field-input code" />
          </div>
          <div>
            <label htmlFor={`leaf-${group.groupName}-to`} className="field-label">To centre (ranges)</label>
            <input id={`leaf-${group.groupName}-to`} name="valTo" maxLength={10} className="field-input code" />
          </div>
        </div>
        <ReasonField id={`leaf-${group.groupName}-reason`} />
        <Message state={leafState} />
        <LockNotice message={groupLock?.mode === 'DISPLAY' ? groupLock.message : null} />
        <button type="submit" className="btn-primary" disabled={leafPending || !groupHeld}>
          Add leaf
        </button>
      </form>
      <form className="space-y-3 border-t border-line p-4" action={deleteAction} onFocus={() => setEngaged(true)} onSubmit={(event) => { if (groupLock?.mode !== 'CHANGE') { event.preventDefault(); setEngaged(true); } }}>
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <input type="hidden" name="groupName" value={group.groupName} />
        <p className="text-sm text-ink-soft">
          Deleting the group removes its leaves with it; the profit centres stand.
        </p>
        <ReasonField id={`group-delete-reason-${group.groupName}`} />
        <Message state={deleteState} />
        <LockNotice message={groupLock?.mode === 'DISPLAY' ? groupLock.message : null} />
        <button type="submit" className="btn-primary" disabled={deletePending || !groupHeld}>
          Delete group
        </button>
      </form>
    </section>
  );
}

function RemoveLeafDialog({
  group,
  leaf,
  selectedArea,
}: {
  group: GroupRow;
  leaf: GroupRow['leaves'][number];
  selectedArea: string;
}) {
  const [state, formAction, pending] = useAction(removeLeafAction as never);
  const [open, setOpen] = useState(false);
  const label = `${leaf.valSign === 'I' ? 'Include' : 'Exclude'} ${leaf.valFrom}${leaf.valTo ? `..${leaf.valTo}` : ''}`;
  const lock = useChangeLock(
    'PROFIT_CENTER_GROUP_LEAF',
    `${selectedArea}/${group.groupName}/${leaf.valSign}/${leaf.valOption}/${leaf.valFrom}/${leaf.valTo}`,
    'CFG.COST.PROFITCENTERHIER.DEFINE',
    open,
  );
  return (
    <DialogShell summary="Remove" title={`Remove leaf ${label}`} code={group.groupName} onOpen={setOpen}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <input type="hidden" name="groupName" value={group.groupName} />
        <input type="hidden" name="valSign" value={leaf.valSign} />
        <input type="hidden" name="valOption" value={leaf.valOption} />
        <input type="hidden" name="valFrom" value={leaf.valFrom} />
        <input type="hidden" name="valTo" value={leaf.valTo} />
        <input type="hidden" name="displayOrder" value={leaf.displayOrder} />
        <p className="text-sm text-ink-soft">
          Removing the leaf removes this line of the group only; the profit centres it named stand.
        </p>
        <ReasonField id={`leaf-remove-reason-${group.groupName}-${leaf.valFrom}`} />
        <Message state={state} />
        <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
        <button type="submit" className="btn-primary" disabled={pending || lock?.mode !== 'CHANGE'}>
          Remove leaf
        </button>
      </form>
    </DialogShell>
  );
}

function NodeActions({
  row,
  nodes,
  selectedArea,
  childCount,
}: {
  row: HierarchyNodeRow;
  nodes: HierarchyNodeRow[];
  selectedArea: string;
  childCount: number;
}) {
  const [changeOpen, setChangeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const lock = useChangeLock(
    'PROFIT_CENTER_NODE',
    `${selectedArea}/${row.node}`,
    'CFG.COST.PROFITCENTERHIER.DEFINE',
    changeOpen || deleteOpen,
  );
  const held = lock?.mode === 'CHANGE';
  const notice = lock?.mode === 'DISPLAY' ? lock.message : null;
  return (
    <div className="flex flex-wrap gap-1">
      <ChangeNodeDialog row={row} nodes={nodes} selectedArea={selectedArea} onOpen={setChangeOpen} held={held} notice={notice} />
      <DeleteNodeDialog row={row} childCount={childCount} selectedArea={selectedArea} onOpen={setDeleteOpen} held={held} notice={notice} />
    </div>
  );
}

/* ── The screen ───────────────────────────────────────────────────── */

export default function ProfitCenterHierarchy({
  areas,
  selectedArea,
  view,
  canMaintain,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  view: HierarchyView;
  canMaintain: boolean;
}) {
  const router = useRouter();
  const childCount = (node: string) => view.nodes.filter((entry) => entry.parentNode === node).length;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-ink-soft">
        Two structures stand here. The standard hierarchy is the controlling area&apos;s one tree:
        profit centre periods are placed into its nodes, one node per period. Alternative groups are
        sets beside the tree — a centre may sit in any number of them, and their leaves may name
        single centres, ranges, or exclusions. Rollups and reports do not read either structure yet.
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

      {selectedArea !== '' && view.hierarchyTitle === null && canMaintain && (
        <DefineHierarchyPanel selectedArea={selectedArea} />
      )}

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
            {view.hierarchyTitle
              ? 'No nodes are defined yet. The first node defined, with no parent, becomes the root.'
              : 'No hierarchy is defined for this controlling area yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[47.5rem]">
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
                      {canMaintain ? (
                        <NodeActions
                          row={node}
                          nodes={view.nodes}
                          selectedArea={selectedArea}
                          childCount={childCount(node.node)}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canMaintain && selectedArea !== '' && view.hierarchyTitle !== null && (
        <CreateNodePanel selectedArea={selectedArea} nodes={view.nodes} />
      )}
      {selectedArea !== '' && view.hierarchyTitle !== null && (
        canMaintain ? (
          <PlacementPanel selectedArea={selectedArea} view={view} />
        ) : view.placements.length > 0 ? (
          <section className="panel overflow-hidden" aria-labelledby="hierarchy-place-title">
            <div className="panel-header">
              <h2 id="hierarchy-place-title" className="panel-title">Period placement</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="grid-table min-w-[40rem]">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Profit centre</th>
                    <th>Valid from</th>
                  </tr>
                </thead>
                <tbody>
                  {view.placements.map((placement) => (
                    <tr key={`${placement.node}:${placement.profitCenter}:${placement.validFrom}`}>
                      <td className="code">{placement.node}</td>
                      <td className="code">{placement.profitCenter}</td>
                      <td>{placement.validFrom}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null
      )}

      <section className="panel overflow-hidden" aria-labelledby="hierarchy-groups-title">
        <div className="panel-header">
          <h2 id="hierarchy-groups-title" className="panel-title">Alternative groups</h2>
        </div>
        {view.groups.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No alternative groups are defined for this area yet.</p>
        ) : null}
      </section>
      {canMaintain && selectedArea !== '' && <CreateGroupPanel selectedArea={selectedArea} />}
      {view.groups.map((group) => (
        <GroupCard key={group.groupName} group={group} selectedArea={selectedArea} />
      ))}
    </div>
  );
}

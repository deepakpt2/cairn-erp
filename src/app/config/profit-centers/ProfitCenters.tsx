'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { CostCenterArea } from '../../../modules/foundation/cost-center-definition';
import type {
  ProfitCenterRow,
  ResponsibleUserChoice,
} from '../../../modules/foundation/profit-center-definition';
import {
  deleteProfitCenterAction,
  lockProfitCenterAction,
  saveProfitCenterAction,
  type ProfitCenterActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: ProfitCenterActionState }) {
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
}: {
  summary: string;
  title: string;
  code: string;
  children: React.ReactNode;
}) {
  return (
    <details className="min-w-16">
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
              <span className="code text-xs text-ink-faint">KE51 · {code}</span>
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

function CentreFields({
  idPrefix,
  row,
  users,
}: {
  idPrefix: string;
  row: ProfitCenterRow | null;
  users: ResponsibleUserChoice[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`${idPrefix}-validTo`} className="field-label">
          Valid To<RequiredMark />
        </label>
        <input
          id={`${idPrefix}-validTo`}
          name="validTo"
          type="date"
          required
          className="field-input"
          defaultValue={row?.validTo ?? '9999-12-31'}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-name`} className="field-label">
          Name<RequiredMark />
        </label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          required
          maxLength={20}
          className="field-input"
          defaultValue={row?.name ?? ''}
        />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={`${idPrefix}-longText`} className="field-label">
          Long Text
        </label>
        <input
          id={`${idPrefix}-longText`}
          name="longText"
          maxLength={40}
          className="field-input"
          defaultValue={row?.longText ?? ''}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-person`} className="field-label">
          Person Responsible
        </label>
        <input
          id={`${idPrefix}-person`}
          name="personResponsible"
          maxLength={20}
          className="field-input"
          defaultValue={row?.personResponsible ?? ''}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-user`} className="field-label">
          Responsible User
        </label>
        <select
          id={`${idPrefix}-user`}
          name="responsibleUser"
          className="field-input"
          defaultValue={row?.responsibleUser ?? ''}
        >
          <option value="">No responsible user</option>
          {users.map((user) => (
            <option key={user.username} value={user.username}>
              {user.username} — {user.fullName}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-segment`} className="field-label">
          Segment
        </label>
        <input
          id={`${idPrefix}-segment`}
          name="segment"
          maxLength={10}
          className="field-input code"
          defaultValue={row?.segment ?? ''}
        />
        <p className="mt-1 text-xs text-ink-soft">
          Entered freely until a segment master stands to judge it.
        </p>
      </div>
    </div>
  );
}

function CreatePanel({
  selectedArea,
  users,
}: {
  selectedArea: string;
  users: ResponsibleUserChoice[];
}) {
  const [state, formAction, pending] = useActionState<ProfitCenterActionState, FormData>(
    saveProfitCenterAction,
    { ok: true },
  );
  return (
    <section className="panel overflow-hidden" aria-labelledby="pc-create-title">
      <div className="panel-header">
        <h2 id="pc-create-title" className="panel-title">New profit centre period</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="pc-code" className="field-label">
              Profit Centre<RequiredMark />
            </label>
            <input
              id="pc-code"
              name="profitCenter"
              required
              maxLength={10}
              className="field-input code"
              placeholder="PC100"
            />
          </div>
          <div>
            <label htmlFor="pc-validFrom" className="field-label">
              Valid From<RequiredMark />
            </label>
            <input id="pc-validFrom" name="validFrom" type="date" required className="field-input" />
          </div>
        </div>
        <CentreFields idPrefix="pc" row={null} users={users} />
        <p className="text-xs text-ink-soft">
          The key is (controlling area, profit centre, valid from); periods of one centre may not
          overlap. Hierarchy placement arrives with the profit centre hierarchy activity, as it did
          for cost centres.
        </p>
        <ReasonField id="pc-reason" />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Create profit centre period
        </button>
      </form>
    </section>
  );
}

function ChangeDialog({ row, users }: { row: ProfitCenterRow; users: ResponsibleUserChoice[] }) {
  const [state, formAction, pending] = useActionState<ProfitCenterActionState, FormData>(
    saveProfitCenterAction,
    { ok: true },
  );
  const suffix = `${row.profitCenter}-${row.validFrom}`;
  const label = `${row.profitCenter} · from ${row.validFrom}`;
  return (
    <DialogShell summary="Change" title={`Change ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="mode" value="CHANGE" />
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="profitCenter" value={row.profitCenter} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <CentreFields idPrefix={`pc-${suffix}`} row={row} users={users} />
        <ReasonField id={`pc-change-reason-${suffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Save changes
        </button>
      </form>
    </DialogShell>
  );
}

function LockDialog({ row }: { row: ProfitCenterRow }) {
  const [state, formAction, pending] = useActionState<ProfitCenterActionState, FormData>(
    lockProfitCenterAction,
    { ok: true },
  );
  const suffix = `${row.profitCenter}-${row.validFrom}`;
  const label = `${row.profitCenter} · from ${row.validFrom}`;
  const verb = row.isPostingLocked ? 'Unlock' : 'Lock';
  return (
    <DialogShell summary={verb} title={`${verb} ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="profitCenter" value={row.profitCenter} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <input type="hidden" name="locked" value={row.isPostingLocked ? 'false' : 'true'} />
        <p className="text-sm text-ink-soft">
          {row.isPostingLocked
            ? 'Unlocking offers this centre to new postings again.'
            : 'Locking stops new postings carrying this centre; the centre keeps its history and stays listed.'}
        </p>
        <ReasonField id={`pc-lock-reason-${suffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          {verb} profit centre
        </button>
      </form>
    </DialogShell>
  );
}

function DeleteDialog({ row }: { row: ProfitCenterRow }) {
  const [state, formAction, pending] = useActionState<ProfitCenterActionState, FormData>(
    deleteProfitCenterAction,
    { ok: true },
  );
  const suffix = `${row.profitCenter}-${row.validFrom}`;
  const label = `${row.profitCenter} · from ${row.validFrom}`;
  return (
    <DialogShell summary="Delete" title={`Delete ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="profitCenter" value={row.profitCenter} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <p className="text-sm text-ink-soft">
          Deleting removes this validity period. It is refused while journal documents dated inside
          the period carry the centre; the posting lock is the alternative that keeps the centre
          standing.
        </p>
        <ReasonField id={`pc-delete-reason-${suffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Delete profit centre period
        </button>
      </form>
    </DialogShell>
  );
}

export default function ProfitCenters({
  areas,
  selectedArea,
  rows,
  users,
  canMaintain,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  rows: ProfitCenterRow[];
  users: ResponsibleUserChoice[];
  canMaintain: boolean;
}) {
  const router = useRouter();
  return (
    <div className="space-y-4">
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

      {canMaintain && selectedArea !== '' && (
        <CreatePanel selectedArea={selectedArea} users={users} />
      )}

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
                  <th>Hierarchy node</th>
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
                    <td className="code">{row.hierarchyNode ?? 'Not placed'}</td>
                    <td>{row.isPostingLocked ? 'Locked' : 'Open'}</td>
                    <td>
                      {canMaintain ? (
                        <div className="flex flex-wrap gap-1">
                          <ChangeDialog row={row} users={users} />
                          <LockDialog row={row} />
                          <DeleteDialog row={row} />
                        </div>
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
    </div>
  );
}

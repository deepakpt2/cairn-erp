'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import type {
  CostCenterArea,
  CostCenterCategory,
  CostCenterRow,
} from '../../../modules/foundation/cost-center-definition';
import {
  deleteCostCenterAction,
  lockCostCenterAction,
  saveCostCenterAction,
  type CostCenterActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: CostCenterActionState }) {
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

function PeriodFields({
  idPrefix,
  row,
  companyCodes,
  categories,
}: {
  idPrefix: string;
  row: CostCenterRow | null;
  companyCodes: string[];
  categories: CostCenterCategory[];
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
          maxLength={40}
          className="field-input"
          defaultValue={row?.name ?? ''}
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
        <label htmlFor={`${idPrefix}-category`} className="field-label">
          Category<RequiredMark />
        </label>
        <select
          id={`${idPrefix}-category`}
          name="category"
          className="field-input"
          defaultValue={row?.category ?? 'PRODUCTION'}
        >
          {categories.map((entry) => (
            <option key={entry.category} value={entry.category}>
              {entry.category}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-company`} className="field-label">
          Company Code<RequiredMark />
        </label>
        <select
          id={`${idPrefix}-company`}
          name="companyCode"
          required
          className="field-input"
          defaultValue={row?.companyCode ?? ''}
        >
          <option value="">Choose a company code assigned to this area</option>
          {companyCodes.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
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
              <span className="code text-xs text-ink-faint">KS01 · {code}</span>
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

function CreatePanel({
  selectedArea,
  companyCodes,
  categories,
}: {
  selectedArea: string;
  companyCodes: string[];
  categories: CostCenterCategory[];
}) {
  const [state, formAction, pending] = useActionState<CostCenterActionState, FormData>(
    saveCostCenterAction,
    { ok: true },
  );
  return (
    <section className="panel overflow-hidden" aria-labelledby="cost-center-create-title">
      <div className="panel-header">
        <h2 id="cost-center-create-title" className="panel-title">New cost centre period</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="cost-center-code" className="field-label">
              Cost Centre<RequiredMark />
            </label>
            <input
              id="cost-center-code"
              name="costCenter"
              required
              maxLength={10}
              className="field-input code"
              placeholder="CC1000"
            />
          </div>
          <div>
            <label htmlFor="cost-center-validFrom" className="field-label">
              Valid From<RequiredMark />
            </label>
            <input
              id="cost-center-validFrom"
              name="validFrom"
              type="date"
              required
              className="field-input"
            />
          </div>
        </div>
        <PeriodFields idPrefix="cost-center" row={null} companyCodes={companyCodes} categories={categories} />
        <p className="text-xs text-ink-soft">
          The key is (controlling area, cost centre, valid from); periods of one centre may not
          overlap. The company code must stand assigned to this controlling area.
        </p>
        <ReasonField id="cost-center-reason" />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Create cost centre period
        </button>
      </form>
    </section>
  );
}

function ChangeDialog({
  row,
  companyCodes,
  categories,
}: {
  row: CostCenterRow;
  companyCodes: string[];
  categories: CostCenterCategory[];
}) {
  const [state, formAction, pending] = useActionState<CostCenterActionState, FormData>(
    saveCostCenterAction,
    { ok: true },
  );
  const keySuffix = `${row.costCenter}-${row.validFrom}`;
  const label = `${row.costCenter} · from ${row.validFrom}`;
  return (
    <DialogShell summary="Change" title={`Change ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="mode" value="CHANGE" />
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="costCenter" value={row.costCenter} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <PeriodFields idPrefix={`cost-center-${keySuffix}`} row={row} companyCodes={companyCodes} categories={categories} />
        <ReasonField id={`cost-center-change-reason-${keySuffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Save changes
        </button>
      </form>
    </DialogShell>
  );
}

function LockDialog({ row }: { row: CostCenterRow }) {
  const [state, formAction, pending] = useActionState<CostCenterActionState, FormData>(
    lockCostCenterAction,
    { ok: true },
  );
  const keySuffix = `${row.costCenter}-${row.validFrom}`;
  const label = `${row.costCenter} · from ${row.validFrom}`;
  const verb = row.isPostingLocked ? 'Unlock' : 'Lock';
  return (
    <DialogShell summary={verb} title={`${verb} ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="costCenter" value={row.costCenter} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <input type="hidden" name="locked" value={row.isPostingLocked ? 'false' : 'true'} />
        <p className="text-sm text-ink-soft">
          {row.isPostingLocked
            ? 'Unlocking offers this centre to new postings again.'
            : 'Locking stops new postings to this centre; the centre keeps its history and stays listed. Locking changes nothing that already stands.'}
        </p>
        <ReasonField id={`cost-center-lock-reason-${keySuffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          {verb} cost centre
        </button>
      </form>
    </DialogShell>
  );
}

function DeleteDialog({ row }: { row: CostCenterRow }) {
  const [state, formAction, pending] = useActionState<CostCenterActionState, FormData>(
    deleteCostCenterAction,
    { ok: true },
  );
  const keySuffix = `${row.costCenter}-${row.validFrom}`;
  const label = `${row.costCenter} · from ${row.validFrom}`;
  const blocked = row.journalDocuments > 0;
  return (
    <DialogShell summary="Delete" title={`Delete ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="costCenter" value={row.costCenter} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <p className="text-sm text-ink-soft">
          Deleting removes this validity period. It is refused while journal documents dated inside
          the period carry the centre; afterwards the posting lock is the alternative.
        </p>
        {blocked ? (
          <p role="status" className="text-sm text-ink-soft">
            {row.journalDocuments} journal document{row.journalDocuments === 1 ? '' : 's'} dated
            inside this period carry this centre — deletion is refused. Lock the centre for posting
            instead.
          </p>
        ) : null}
        <ReasonField id={`cost-center-delete-reason-${keySuffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending || blocked}>
          Delete cost centre period
        </button>
      </form>
    </DialogShell>
  );
}

export default function CostCenters({
  areas,
  selectedArea,
  rows,
  companyCodes,
  categories,
  canMaintain,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  rows: CostCenterRow[];
  companyCodes: string[];
  categories: CostCenterCategory[];
  canMaintain: boolean;
}) {
  const router = useRouter();
  const area = areas.find((entry) => entry.controllingArea === selectedArea);
  return (
    <div className="space-y-4">
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

      {canMaintain && selectedArea !== '' && (
        <CreatePanel selectedArea={selectedArea} companyCodes={companyCodes} categories={categories} />
      )}

      <section className="panel overflow-hidden" aria-labelledby="cost-center-grid-title">
        <div className="panel-header">
          <h2 id="cost-center-grid-title" className="panel-title">Cost centres</h2>
        </div>
        {selectedArea === '' ? (
          <p className="p-4 text-sm text-ink-soft">Choose a controlling area to see its cost centres.</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">No cost centres are defined for this controlling area yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-table min-w-[900px]">
              <thead>
                <tr>
                  <th>Cost centre</th>
                  <th>Valid</th>
                  <th>Name</th>
                  <th>Company code</th>
                  <th>Category</th>
                  <th>Posting</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.costCenter}:${row.validFrom}`}>
                    <td className="code">{row.costCenter}</td>
                    <td>
                      {row.validFrom} → {row.validTo}
                    </td>
                    <td>{row.name}</td>
                    <td className="code">{row.companyCode}</td>
                    <td>{row.category}</td>
                    <td>{row.isPostingLocked ? 'Locked' : 'Open'}</td>
                    <td>
                      {canMaintain ? (
                        <div className="flex flex-wrap gap-1">
                          <ChangeDialog row={row} companyCodes={companyCodes} categories={categories} />
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

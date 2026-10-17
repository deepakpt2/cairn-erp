'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import type { CostCenterArea, CostCenterCategory } from '../../../modules/foundation/cost-center-definition';
import type {
  ActivityCategoryOption,
  ActivityTypeRow,
  ActivityUnitChoice,
} from '../../../modules/foundation/activity-type-definition';
import {
  deleteActivityTypeAction,
  lockActivityTypeAction,
  saveActivityTypeAction,
  type ActivityTypeActionState,
} from './actions';

function labelOf(options: ActivityCategoryOption[], code: string): string {
  return options.find((entry) => entry.code === code)?.label ?? code;
}

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: ActivityTypeActionState }) {
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
              <span className="code text-xs text-ink-faint">KL01 · {code}</span>
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

function TypeFields({
  idPrefix,
  row,
  units,
  categories,
  priceIndicators,
  ccCategories,
}: {
  idPrefix: string;
  row: ActivityTypeRow | null;
  units: ActivityUnitChoice[];
  categories: ActivityCategoryOption[];
  priceIndicators: ActivityCategoryOption[];
  ccCategories: CostCenterCategory[];
}) {
  const chosen = row?.validCcCategories ? row.validCcCategories.split(',') : [];
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
        <label htmlFor={`${idPrefix}-unit`} className="field-label">
          Activity Unit<RequiredMark />
        </label>
        <select
          id={`${idPrefix}-unit`}
          name="activityUnit"
          required
          className="field-input"
          defaultValue={row?.activityUnit ?? ''}
        >
          <option value="">Choose a unit of measure</option>
          {units.map((unit) => (
            <option key={unit.code} value={unit.code}>
              {unit.code} — {unit.name} ({unit.dimension})
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-category`} className="field-label">
          Activity Category<RequiredMark />
        </label>
        <select
          id={`${idPrefix}-category`}
          name="category"
          className="field-input"
          defaultValue={row?.category ?? '1'}
        >
          {categories.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.code} — {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-price`} className="field-label">
          Price Indicator<RequiredMark />
        </label>
        <select
          id={`${idPrefix}-price`}
          name="priceIndicator"
          className="field-input"
          defaultValue={row?.priceIndicator ?? '1'}
        >
          {priceIndicators.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.code} — {entry.label}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="field-label">Valid for cost centre categories</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
          {ccCategories.map((entry) => (
            <label key={entry.category} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="validCcCategories"
                value={entry.category}
                defaultChecked={chosen.includes(entry.category)}
              />
              {entry.category}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-ink-soft">None chosen = valid for every category.</p>
      </fieldset>
    </div>
  );
}

function CreatePanel({
  selectedArea,
  units,
  categories,
  priceIndicators,
  ccCategories,
}: {
  selectedArea: string;
  units: ActivityUnitChoice[];
  categories: ActivityCategoryOption[];
  priceIndicators: ActivityCategoryOption[];
  ccCategories: CostCenterCategory[];
}) {
  const [state, formAction, pending] = useActionState<ActivityTypeActionState, FormData>(
    saveActivityTypeAction,
    { ok: true },
  );
  return (
    <section className="panel overflow-hidden" aria-labelledby="act-type-create-title">
      <div className="panel-header">
        <h2 id="act-type-create-title" className="panel-title">New activity type period</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <input type="hidden" name="controllingArea" value={selectedArea} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="act-type-code" className="field-label">
              Activity Type<RequiredMark />
            </label>
            <input
              id="act-type-code"
              name="activityType"
              required
              maxLength={6}
              className="field-input code"
              placeholder="LAB01"
            />
          </div>
          <div>
            <label htmlFor="act-type-validFrom" className="field-label">
              Valid From<RequiredMark />
            </label>
            <input id="act-type-validFrom" name="validFrom" type="date" required className="field-input" />
          </div>
        </div>
        <TypeFields
          idPrefix="act-type"
          row={null}
          units={units}
          categories={categories}
          priceIndicators={priceIndicators}
          ccCategories={ccCategories}
        />
        <p className="text-xs text-ink-soft">
          The key is (controlling area, activity type, valid from); periods of one type may not
          overlap. Nothing prices or allocates against these types yet — deletion is therefore
          unconditional today, and rates will give it a usage count when they land.
        </p>
        <ReasonField id="act-type-reason" />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Create activity type period
        </button>
      </form>
    </section>
  );
}

function ChangeDialog({
  row,
  units,
  categories,
  priceIndicators,
  ccCategories,
}: {
  row: ActivityTypeRow;
  units: ActivityUnitChoice[];
  categories: ActivityCategoryOption[];
  priceIndicators: ActivityCategoryOption[];
  ccCategories: CostCenterCategory[];
}) {
  const [state, formAction, pending] = useActionState<ActivityTypeActionState, FormData>(
    saveActivityTypeAction,
    { ok: true },
  );
  const suffix = `${row.activityType}-${row.validFrom}`;
  const label = `${row.activityType} · from ${row.validFrom}`;
  return (
    <DialogShell summary="Change" title={`Change ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="mode" value="CHANGE" />
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="activityType" value={row.activityType} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <TypeFields
          idPrefix={`act-type-${suffix}`}
          row={row}
          units={units}
          categories={categories}
          priceIndicators={priceIndicators}
          ccCategories={ccCategories}
        />
        <ReasonField id={`act-type-change-reason-${suffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Save changes
        </button>
      </form>
    </DialogShell>
  );
}

function LockDialog({ row }: { row: ActivityTypeRow }) {
  const [state, formAction, pending] = useActionState<ActivityTypeActionState, FormData>(
    lockActivityTypeAction,
    { ok: true },
  );
  const suffix = `${row.activityType}-${row.validFrom}`;
  const label = `${row.activityType} · from ${row.validFrom}`;
  const verb = row.isPostingLocked ? 'Unlock' : 'Lock';
  return (
    <DialogShell summary={verb} title={`${verb} ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="activityType" value={row.activityType} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <input type="hidden" name="locked" value={row.isPostingLocked ? 'false' : 'true'} />
        <p className="text-sm text-ink-soft">
          {row.isPostingLocked
            ? 'Unlocking offers this type to new pricing and allocation again.'
            : 'Locking stops new pricing and allocation against this type; the type keeps its definition and stays listed.'}
        </p>
        <ReasonField id={`act-type-lock-reason-${suffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          {verb} activity type
        </button>
      </form>
    </DialogShell>
  );
}

function DeleteDialog({ row }: { row: ActivityTypeRow }) {
  const [state, formAction, pending] = useActionState<ActivityTypeActionState, FormData>(
    deleteActivityTypeAction,
    { ok: true },
  );
  const suffix = `${row.activityType}-${row.validFrom}`;
  const label = `${row.activityType} · from ${row.validFrom}`;
  return (
    <DialogShell summary="Delete" title={`Delete ${label}`} code={label}>
      <form className="space-y-3" action={formAction}>
        <input type="hidden" name="controllingArea" value={row.controllingArea} />
        <input type="hidden" name="activityType" value={row.activityType} />
        <input type="hidden" name="validFrom" value={row.validFrom} />
        <p className="text-sm text-ink-soft">
          Deleting removes this validity period. Nothing prices or allocates against activity types
          yet, so no usage count stands against deletion today; when rates land, they will. The
          posting lock is the alternative that keeps the type standing.
        </p>
        <ReasonField id={`act-type-delete-reason-${suffix}`} />
        <Message state={state} />
        <button type="submit" className="btn-primary" disabled={pending}>
          Delete activity type period
        </button>
      </form>
    </DialogShell>
  );
}

export default function ActivityTypes({
  areas,
  selectedArea,
  rows,
  units,
  categories,
  priceIndicators,
  ccCategories,
  canMaintain,
}: {
  areas: CostCenterArea[];
  selectedArea: string;
  rows: ActivityTypeRow[];
  units: ActivityUnitChoice[];
  categories: ActivityCategoryOption[];
  priceIndicators: ActivityCategoryOption[];
  ccCategories: CostCenterCategory[];
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

      {canMaintain && selectedArea !== '' && (
        <CreatePanel
          selectedArea={selectedArea}
          units={units}
          categories={categories}
          priceIndicators={priceIndicators}
          ccCategories={ccCategories}
        />
      )}

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
                  <th>Categories valid</th>
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
                    <td className="code">{row.validCcCategories || 'All'}</td>
                    <td>{row.isPostingLocked ? 'Locked' : 'Open'}</td>
                    <td>
                      {canMaintain ? (
                        <div className="flex flex-wrap gap-1">
                          <ChangeDialog
                            row={row}
                            units={units}
                            categories={categories}
                            priceIndicators={priceIndicators}
                            ccCategories={ccCategories}
                          />
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

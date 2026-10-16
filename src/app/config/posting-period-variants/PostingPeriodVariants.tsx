'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import type {
  PostingPeriodIntervalDefault,
  PostingPeriodVariantRow,
} from '@/modules/foundation/posting-period-variant-definition';
import {
  deletePostingPeriodVariantAction,
  savePostingPeriodVariantAction,
  type PostingPeriodVariantActionState,
} from './actions';

/** The contract's key rule: up to four letters or digits, held upper case. */
const VARIANT_PATTERN = /^[A-Z0-9]{1,4}$/;
const NAME_MAX = 30;

export function ActionMessage({ state }: { state: PostingPeriodVariantActionState }) {
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

function DialogHeader({ code, label }: { code: string; label: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">OBBO · {code}</span>
        <p className="font-semibold">{label}</p>
      </div>
      <button
        type="button"
        className="btn btn-default min-h-11 sm:min-h-9"
        onClick={(event) => {
          const details = event.currentTarget.closest('details');
          if (details) details.open = false;
        }}
      >
        {t('common.close')}
      </button>
    </div>
  );
}

/**
 * OBBO Define Posting Period Variants: the new-entry form and the registry grid.
 *
 * One form serves create and change because the two are the same two questions, and a
 * registry that validates one of them and not the other is how a screen ends up accepting
 * what the database refuses. The key is read-only on change: a variant is the identity its
 * Company Codes point at, so changing it would mean defining another one.
 *
 * The intervals are shown, never edited here. They are created with the variant and opened
 * or closed against a Company Code, on the screen where the operator closing a month
 * already is; a second place to move them would be a second answer to the same question.
 */
export function PostingPeriodVariantForm({
  mode,
  initial,
  variants,
  defaults,
  canMaintain,
}: {
  mode: 'CREATE' | 'CHANGE';
  initial?: PostingPeriodVariantRow;
  variants: PostingPeriodVariantRow[];
  defaults: PostingPeriodIntervalDefault[];
  canMaintain: boolean;
}) {
  const editing = mode === 'CHANGE' && initial !== undefined;
  const [variant, setVariant] = useState(initial?.variant ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [state, formAction, pending] = useActionState<PostingPeriodVariantActionState, FormData>(
    savePostingPeriodVariantAction,
    { ok: true },
  );

  const key = variant.trim().toUpperCase();

  const problems: string[] = [];
  if (!editing) {
    if (!VARIANT_PATTERN.test(key)) problems.push(t('ppv.keyRule'));
    else if (variants.some((row) => row.variant === key)) {
      problems.push(t('ppv.keyTaken', { variant: key }));
    }
  }
  if (!name.trim()) problems.push(t('ppv.nameRequired'));
  else if (name.trim().length > NAME_MAX) problems.push(t('ppv.nameTooLong'));

  // Read-only while the write is in flight: a field that can still be edited during a
  // submission is a field whose edit is silently thrown away.
  const locked = !canMaintain || pending;
  const canSubmit = canMaintain && !pending && problems.length === 0;

  return (
    <form className="space-y-3" action={formAction}>
      <input type="hidden" name="mode" value={mode} />
      {editing && <input type="hidden" name="variant" value={initial.variant} />}

      <ActionMessage state={state} />

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`ppv-variant-${mode}`} className="field-label">
            {t('ppv.key')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          {editing ? (
            <>
              <input
                id={`ppv-variant-${mode}`}
                className="field-input code"
                value={initial.variant}
                readOnly
              />
              <p className="mt-1 text-xs text-ink-soft">{t('ppv.keyImmutable')}</p>
            </>
          ) : (
            <input
              id={`ppv-variant-${mode}`}
              name="variant"
              className="field-input code"
              maxLength={4}
              value={variant}
              placeholder="C002"
              disabled={locked}
              onChange={(event) => setVariant(event.target.value.toUpperCase())}
            />
          )}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor={`ppv-name-${mode}`} className="field-label">
            {t('ppv.name')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          <input
            id={`ppv-name-${mode}`}
            name="name"
            className="field-input"
            maxLength={NAME_MAX}
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </div>

      {!editing && defaults.length > 0 && (
        <div className="border border-line bg-sunken p-3 text-xs text-ink-soft">
          <p className="font-medium text-ink">{t('ppv.defaultsTitle')}</p>
          <p className="mt-1">{t('ppv.defaultsRule')}</p>
          <ul className="mt-2 space-y-0.5">
            {defaults.map((interval) => (
              <li key={interval.accountType} className="code">
                {interval.accountTypeLabel} — {interval.summary}
              </li>
            ))}
          </ul>
        </div>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 border border-signal-error bg-white p-3 text-sm text-signal-error">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          {editing ? t('ppv.saveChanges') : t('ppv.create')}
        </button>
        {editing && (
          <button
            type="button"
            className="btn btn-default min-h-11 sm:min-h-9"
            onClick={(event) => {
              const details = event.currentTarget.closest('details');
              if (details) details.open = false;
            }}
          >
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

export function PostingPeriodVariantPanel({
  variants,
  defaults,
  canMaintain,
}: {
  variants: PostingPeriodVariantRow[];
  defaults: PostingPeriodIntervalDefault[];
  canMaintain: boolean;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="ppv-create-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="ppv-create-title" className="font-semibold">{t('ppv.createTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('ppv.createRule')}</p>
      </div>
      {canMaintain ? (
        <div className="p-4">
          <PostingPeriodVariantForm
            mode="CREATE"
            variants={variants}
            defaults={defaults}
            canMaintain={canMaintain}
          />
        </div>
      ) : (
        <p role="status" className="px-4 py-6 text-sm text-ink-soft">{t('ppv.readOnly')}</p>
      )}
    </section>
  );
}

function IntervalList({ row }: { row: PostingPeriodVariantRow }) {
  if (row.intervals.length === 0) {
    return <p className="text-xs text-ink-soft">{t('ppv.noIntervals')}</p>;
  }
  return (
    <table className="grid-table min-w-[520px]">
      <thead>
        <tr>
          <th>{t('ppv.accountType')}</th>
          <th>{t('ppv.openRange')}</th>
          <th>{t('ppv.yearShiftPast')}</th>
          <th>{t('ppv.yearShiftFuture')}</th>
        </tr>
      </thead>
      <tbody>
        {row.intervals.map((interval) => (
          <tr key={interval.accountType}>
            <td>{interval.accountTypeLabel}</td>
            <td>{interval.summary}</td>
            <td className="tabular">{interval.yearShiftPast}</td>
            <td className="tabular">{interval.yearShiftFuture}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Deleting a variant takes its own intervals with it. What it may not take is a Company
 * Code's posting control, so a variant anything posts against is refused here, on the
 * screen, before the operator is offered a button the write side would reject.
 */
function VariantDeleteControl({ row, canMaintain }: { row: PostingPeriodVariantRow; canMaintain: boolean }) {
  const [state, formAction, pending] = useActionState<PostingPeriodVariantActionState, FormData>(
    deletePostingPeriodVariantAction,
    { ok: true },
  );
  const blocked = row.usedByCompanyCodes.length > 0;
  const label = `${t('ppv.delete')} ${row.variant}`;

  return (
    <details className="min-w-28">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
        {t('ppv.delete')}
      </summary>
      <div className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <DialogHeader code={row.variant} label={label} />
          <section className="panel overflow-hidden p-4">
            <form className="space-y-3" action={formAction}>
              <input type="hidden" name="variant" value={row.variant} />

              <ActionMessage state={state} />

              <p className="text-sm text-ink">
                {t('ppv.deleteConfirm', {
                  variant: row.variant,
                  name: row.name,
                  intervals: String(row.intervals.length),
                })}
              </p>

              {row.intervals.length > 0 && (
                <div className="overflow-x-auto border border-line">
                  <IntervalList row={row} />
                </div>
              )}

              {blocked ? (
                <p role="alert" className="border border-signal-error bg-white p-3 text-sm text-signal-error">
                  {t('ppv.deleteBlocked', {
                    variant: row.variant,
                    companyCodes: row.usedByLabel,
                  })}
                  <span className="mt-1 block text-xs text-ink-soft">{t('ppv.deleteBlockedRemedy')}</span>
                </p>
              ) : (
                <p className="text-xs text-ink-soft">{t('ppv.deleteRule')}</p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!canMaintain || blocked || pending}
                >
                  {t('ppv.deleteConfirmButton')}
                </button>
                <button
                  type="button"
                  className="btn btn-default min-h-11 sm:min-h-9"
                  onClick={(event) => {
                    const details = event.currentTarget.closest('details');
                    if (details) details.open = false;
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

export function PostingPeriodVariantList({
  variants,
  defaults,
  canMaintain,
}: {
  variants: PostingPeriodVariantRow[];
  defaults: PostingPeriodIntervalDefault[];
  canMaintain: boolean;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="ppv-list-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="ppv-list-title" className="font-semibold">{t('ppv.listTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('ppv.listRule')}</p>
      </div>

      {variants.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('ppv.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[900px]">
            <thead>
              <tr>
                <th>{t('ppv.key')}</th>
                <th>{t('ppv.name')}</th>
                <th>{t('ppv.intervals')}</th>
                <th>{t('ppv.usedBy')}</th>
                <th>{t('ppv.status')}</th>
                <th>{t('ppv.changed')}</th>
                {canMaintain && <th>{t('ppv.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {variants.map((row) => (
                <tr key={row.variant}>
                  <td className="code font-semibold">{row.variant}</td>
                  <td>{row.name}</td>
                  <td>
                    <details className="text-sm">
                      <summary className="min-h-11 cursor-pointer select-none py-2 font-medium text-accent hover:underline sm:min-h-9">
                        {t('ppv.intervalsCount', { count: String(row.intervals.length) })}
                      </summary>
                      <div className="overflow-x-auto border border-line bg-white p-2">
                        <IntervalList row={row} />
                      </div>
                    </details>
                  </td>
                  <td className="code text-xs">
                    {row.usedByCompanyCodes.length === 0 ? (
                      <span className="text-ink-faint">{t('ppv.usedByNone')}</span>
                    ) : (
                      row.usedByLabel
                    )}
                  </td>
                  <td>
                    <span className={row.isActive ? 'chip' : 'chip chip-neutral'}>
                      {row.isActive ? t('ppv.active') : t('ppv.deactivated')}
                    </span>
                  </td>
                  <td className="text-xs text-ink-soft">
                    {row.changedBy
                      ? `${row.changedBy} · ${new Date(row.changedAt ?? row.createdAt).toISOString().slice(0, 10)}`
                      : `${row.createdBy} · ${new Date(row.createdAt).toISOString().slice(0, 10)}`}
                  </td>
                  {canMaintain && (
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <details className="min-w-28">
                          <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
                            {t('ppv.change')}
                          </summary>
                          <div className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
                            <div className="mx-auto max-w-3xl">
                              <DialogHeader
                                code={row.variant}
                                label={`${t('ppv.change')} ${row.variant}`}
                              />
                              <section className="panel overflow-hidden p-4">
                                <PostingPeriodVariantForm
                                  mode="CHANGE"
                                  initial={row}
                                  variants={variants}
                                  defaults={defaults}
                                  canMaintain={canMaintain}
                                />
                              </section>
                            </div>
                          </div>
                        </details>
                        <VariantDeleteControl row={row} canMaintain={canMaintain} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { periodWindows } from '@/platform/periods/windows';
import { t } from '@/platform/i18n';
import type { FiscalYearVariantRow } from '@/modules/foundation/fiscal-year-variant-maintenance';
import {
  saveFiscalYearPeriodsAction,
  saveFiscalYearVariantAction,
  setFiscalYearVariantActiveAction,
  type FiscalYearVariantActionState,
} from './actions';

const VARIANT_PATTERN = /^[A-Z0-9]{2}$/;
const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const SHIFTS = [-1, 0, 1];

export function ActionMessage({ state }: { state: FiscalYearVariantActionState }) {
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

/**
 * OB29 Fiscal Year Variants: the registry grid, the definition form and the period list.
 *
 * One form serves Create and Change, because the two screens that ask the same six questions
 * are how a registry ends up validating one of them and not the other. The key is read-only on
 * change: a variant is the identity its Company Codes and Controlling Areas point at, so
 * changing it would mean defining another one.
 *
 * The period list is rendered only for a variant whose year is not the calendar year, on the
 * contract's rule: a calendar-year variant's periods are derived from its own counts, and a
 * screen that offered to edit them would offer to make the variant disagree with itself. Where
 * the list is shown, the grid holds exactly as many rows as the variant defines periods, so the
 * "numbers run from 1 without a gap" rule is a property of the form rather than something the
 * operator has to get right. The derived start column appears only when reading: it comes from
 * the posting engine, and a screen that recomputed it in the browser would be a second
 * implementation of the same rule.
 */
export function FiscalYearVariantForm({
  mode,
  initial,
  variants,
  canMaintain,
}: {
  mode: 'CREATE' | 'CHANGE';
  initial?: FiscalYearVariantRow;
  variants: FiscalYearVariantRow[];
  canMaintain: boolean;
}) {
  const editing = mode === 'CHANGE' && initial !== undefined;
  const [variant, setVariant] = useState(initial?.variant ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [isCalendarYear, setIsCalendarYear] = useState(initial?.isCalendarYear ?? false);
  const [regularPeriods, setRegularPeriods] = useState(String(initial?.regularPeriods ?? 12));
  const [specialPeriods, setSpecialPeriods] = useState(String(initial?.specialPeriods ?? 4));
  const [isYearDependent, setIsYearDependent] = useState(initial?.isYearDependent ?? false);
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<FiscalYearVariantActionState, FormData>(
    saveFiscalYearVariantAction,
    { ok: true },
  );

  const regular = Number(regularPeriods);
  const special = Number(specialPeriods);
  const key = variant.trim().toUpperCase();

  const problems: string[] = [];
  if (!editing) {
    if (!VARIANT_PATTERN.test(key)) problems.push(t('fiscalYearVariant.keyRule'));
    else if (variants.some((row) => row.variant === key)) {
      problems.push(t('fiscalYearVariant.keyTaken', { variant: key }));
    }
  }
  if (!name.trim()) problems.push(t('fiscalYearVariant.nameRequired'));
  else if (name.trim().length > 30) problems.push(t('fiscalYearVariant.nameTooLong'));
  if (!Number.isInteger(regular) || regular < 1 || regular > 16) {
    problems.push(t('fiscalYearVariant.regularRule'));
  }
  if (!Number.isInteger(special) || special < 0 || special > 4) {
    problems.push(t('fiscalYearVariant.specialRule'));
  }
  if (!isCalendarYear && regular > 12 && !isYearDependent) {
    problems.push(t('fiscalYearVariant.shiftedTooLong'));
  }
  if (!reason.trim()) problems.push(t('fiscalYearVariant.reasonRequired'));

  const locked = !canMaintain || pending;
  const canSubmit = canMaintain && !pending && problems.length === 0;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="expectedVersion" value={editing ? initial.version : 0} />
      {editing && <input type="hidden" name="variant" value={initial.variant} />}

      <ActionMessage state={state} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor={`fyv-variant-${mode}`} className="field-label">
            {t('fiscalYearVariant.key')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          {editing ? (
            <>
              <input
                id={`fyv-variant-${mode}`}
                className="field-input code"
                value={initial.variant}
                readOnly
              />
              <p className="mt-1 text-xs text-ink-soft">{t('fiscalYearVariant.keyImmutable')}</p>
            </>
          ) : (
            <input
              id={`fyv-variant-${mode}`}
              name="variant"
              className="field-input code"
              maxLength={2}
              value={variant}
              placeholder="K4"
              disabled={locked}
              onChange={(event) => setVariant(event.target.value.toUpperCase())}
            />
          )}
        </div>

        <div className="sm:col-span-2">
          <label htmlFor={`fyv-name-${mode}`} className="field-label">
            {t('fiscalYearVariant.name')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          <input
            id={`fyv-name-${mode}`}
            name="name"
            className="field-input"
            maxLength={30}
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor={`fyv-regular-${mode}`} className="field-label">
            {t('fiscalYearVariant.regularPeriods')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          <input
            id={`fyv-regular-${mode}`}
            name="regularPeriods"
            className="field-input tabular"
            type="number"
            min={1}
            max={16}
            value={regularPeriods}
            disabled={locked}
            onChange={(event) => setRegularPeriods(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor={`fyv-special-${mode}`} className="field-label">
            {t('fiscalYearVariant.specialPeriods')}
          </label>
          <input
            id={`fyv-special-${mode}`}
            name="specialPeriods"
            className="field-input tabular"
            type="number"
            min={0}
            max={4}
            value={specialPeriods}
            disabled={locked}
            onChange={(event) => setSpecialPeriods(event.target.value)}
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              name="isCalendarYear"
              className="mt-1 h-4 w-4"
              checked={isCalendarYear}
              disabled={locked}
              onChange={(event) => setIsCalendarYear(event.target.checked)}
            />
            <span>
              {t('fiscalYearVariant.calendarYear')}
              <span className="block text-xs text-ink-soft">{t('fiscalYearVariant.calendarYearHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              name="isYearDependent"
              className="mt-1 h-4 w-4"
              checked={isYearDependent}
              disabled={locked}
              onChange={(event) => setIsYearDependent(event.target.checked)}
            />
            <span>
              {t('fiscalYearVariant.yearDependent')}
              <span className="block text-xs text-ink-soft">{t('fiscalYearVariant.yearDependentHint')}</span>
            </span>
          </label>
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label htmlFor={`fyv-reason-${mode}`} className="field-label">
            {t('fiscalYearVariant.reason')}
            <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
          </label>
          <textarea
            id={`fyv-reason-${mode}`}
            name="reason"
            rows={2}
            maxLength={500}
            className="field-input"
            value={reason}
            readOnly={locked}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        {problems.map((problem) => (
          <p key={problem} className="border border-line bg-white p-3 text-sm text-ink-soft">{problem}</p>
        ))}
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          {pending
            ? t('common.saving')
            : editing
              ? t('fiscalYearVariant.saveChanges')
              : t('fiscalYearVariant.create')}
        </button>
      </div>
    </form>
  );
}

export function FiscalYearVariantPanel({
  variants,
  canMaintain,
}: {
  variants: FiscalYearVariantRow[];
  canMaintain: boolean;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="fyv-variant-create-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="fyv-variant-create-title" className="font-semibold">{t('fiscalYearVariant.createTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('fiscalYearVariant.createRule')}</p>
      </div>
      {canMaintain ? (
        <div className="p-4">
          <FiscalYearVariantForm mode="CREATE" variants={variants} canMaintain={canMaintain} />
        </div>
      ) : (
        <p role="status" className="px-4 py-6 text-sm text-ink-soft">{t('fiscalYearVariant.readOnly')}</p>
      )}
    </section>
  );
}

export function FiscalYearVariantList({
  variants,
  canMaintain,
}: {
  variants: FiscalYearVariantRow[];
  canMaintain: boolean;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="fyv-variant-list-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="fyv-variant-list-title" className="font-semibold">{t('fiscalYearVariant.listTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('fiscalYearVariant.listRule')}</p>
      </div>

      {variants.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('fiscalYearVariant.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[61.25rem]">
            <thead>
              <tr>
                <th>{t('fiscalYearVariant.key')}</th>
                <th>{t('fiscalYearVariant.name')}</th>
                <th>{t('fiscalYearVariant.calendarYear')}</th>
                <th>{t('fiscalYearVariant.regularPeriods')}</th>
                <th>{t('fiscalYearVariant.specialPeriods')}</th>
                <th>{t('fiscalYearVariant.yearDependent')}</th>
                <th>{t('fiscalYearVariant.status')}</th>
                <th>{t('fiscalYearVariant.version')}</th>
                {canMaintain && <th>{t('fiscalYearVariant.actions')}</th>}
                <th>{t('fiscalYearVariant.periods')}</th>
              </tr>
            </thead>
            <tbody>
              {variants.map((row) => (
                <tr key={row.variant}>
                  <td className="code font-semibold">{row.variant}</td>
                  <td>{row.name}</td>
                  <td>{row.isCalendarYear ? t('common.yes') : t('common.no')}</td>
                  <td className="tabular">{row.regularPeriods}</td>
                  <td className="tabular">{row.specialPeriods}</td>
                  <td>{row.isYearDependent ? t('common.yes') : t('common.no')}</td>
                  <td>
                    <span className={row.isActive ? 'chip' : 'chip chip-neutral'}>
                      {row.isActive ? t('fiscalYearVariant.active') : t('fiscalYearVariant.deactivated')}
                    </span>
                  </td>
                  <td className="tabular">{row.version}</td>
                  {canMaintain && (
                    <td>
                      <div className="flex flex-wrap gap-2">
                        {row.isActive && (
                          <details className="min-w-28">
                            <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
                              {t('fiscalYearVariant.change')}
                            </summary>
                            <div className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
                              <div className="mx-auto max-w-3xl">
                                <DialogHeader
                                  code={row.variant}
                                  label={`${t('fiscalYearVariant.change')} ${row.variant}`}
                                />
                                <section className="panel overflow-hidden p-4">
                                  <FiscalYearVariantForm
                                    mode="CHANGE"
                                    initial={row}
                                    variants={variants}
                                    canMaintain={canMaintain}
                                  />
                                </section>
                              </div>
                            </div>
                          </details>
                        )}
                        <VariantLifecycleControl row={row} />
                      </div>
                    </td>
                  )}
                  <td>
                    <details className="text-sm">
                      <summary className="min-h-11 cursor-pointer select-none py-2 font-medium text-accent hover:underline sm:min-h-9">
                        {t('fiscalYearVariant.showPeriods')}
                      </summary>
                      {/* The period form opens on top of the list, like Change and the
                          lifecycle control, instead of expanding inside this narrow
                          table cell where the grid was squeezed to the side. */}
                      <div
                        role="dialog"
                        aria-modal="true"
                        aria-label={`${t('fiscalYearVariant.periods')} ${row.variant}`}
                        className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
                      >
                        <div className="mx-auto max-w-3xl">
                          <DialogHeader
                            code={row.variant}
                            label={`${t('fiscalYearVariant.periods')} · ${row.variant}`}
                          />
                          <section className="panel overflow-hidden p-4">
                            <div className="overflow-x-auto">
                              <PeriodPanel row={row} canMaintain={canMaintain} />
                            </div>
                          </section>
                        </div>
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DialogHeader({ code, label }: { code: string; label: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">OB29 · {code}</span>
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

function VariantLifecycleControl({ row }: { row: FiscalYearVariantRow }) {
  const [state, formAction, pending] = useActionState<FiscalYearVariantActionState, FormData>(
    setFiscalYearVariantActiveAction,
    { ok: true },
  );
  const [reason, setReason] = useState('');
  const label = `${row.isActive ? t('fiscalYearVariant.deactivate') : t('fiscalYearVariant.reactivate')} ${row.variant}`;

  return (
    <details className="min-w-32">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {row.isActive ? t('fiscalYearVariant.deactivate') : t('fiscalYearVariant.reactivate')}
      </summary>
      <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <DialogHeader code={row.variant} label={label} />
          <section className="panel overflow-hidden">
            <div className="border-b border-line bg-sunken px-4 py-3">
              <h3 className="font-semibold">{t('fiscalYearVariant.lifecycleRule')}</h3>
            </div>
            <div className="space-y-3 p-4">
              <ActionMessage state={state} />
              <form action={formAction} className="space-y-3">
                <input type="hidden" name="variant" value={row.variant} />
                <input type="hidden" name="isActive" value={row.isActive ? 'false' : 'true'} />
                <input type="hidden" name="expectedVersion" value={row.version} />
                <div>
                  <label htmlFor={`fyv-lifecycle-${row.variant}`} className="field-label">
                    {t('fiscalYearVariant.reason')}
                    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                  </label>
                  <textarea
                    id={`fyv-lifecycle-${row.variant}`}
                    name="reason"
                    required
                    minLength={1}
                    maxLength={500}
                    rows={3}
                    className="field-input"
                    value={reason}
                    disabled={pending}
                    onChange={(event) => setReason(event.currentTarget.value.slice(0, 500))}
                  />
                  <p className="mt-1 text-xs text-ink-faint">
                    {row.isActive ? t('fiscalYearVariant.inactiveRetained') : t('fiscalYearVariant.lifecycleRule')}
                  </p>
                </div>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={pending || !reason.trim()}
                >
                  {pending
                    ? t('common.saving')
                    : row.isActive
                      ? t('fiscalYearVariant.deactivate')
                      : t('fiscalYearVariant.reactivate')}
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </details>
  );
}

/** The same date shape the read side stores its derived windows in. */
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function PeriodPanel({ row, canMaintain }: { row: FiscalYearVariantRow; canMaintain: boolean }) {
  const thisYear = new Date().getFullYear();
  const maintainedYears = row.years.filter((year) => year !== 0);
  const [year, setYear] = useState(
    row.isYearDependent ? (maintainedYears[0] ?? thisYear) : 0,
  );
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<FiscalYearVariantActionState, FormData>(
    saveFiscalYearPeriodsAction,
    { ok: true },
  );
  // The ends live in the fields themselves, so this holds only what has been edited. It exists
  // to show the window posting will derive; the fields still submit their own values.
  const [draft, setDraft] = useState<Record<number, { month?: number; day?: number; yearShift?: number }>>({});

  if (row.isCalendarYear) {
    return (
      <p className="mt-2 border border-line bg-white p-3 text-xs text-ink-soft">
        {t('fiscalYearVariant.periodsDerived', {
          regular: String(row.regularPeriods),
          special: String(row.specialPeriods),
        })}
      </p>
    );
  }

  const total = row.regularPeriods + row.specialPeriods;
  const editable = canMaintain && row.isActive;
  const stored = row.periods.filter((period) => period.calendarYear === year);
  // The grid always holds exactly the periods the variant defines, so the "no gaps" rule is a
  // property of the form. A period nobody has maintained yet starts as its own month ending on
  // the last day, which is the shape the service will refuse if it does not cover the year.
  const rows = Array.from({ length: total }, (_, index) => {
    const period = index + 1;
    const existing = stored.find((entry) => entry.period === period);
    return {
      period,
      periodType: period <= row.regularPeriods ? 'REGULAR' : 'SPECIAL',
      month: existing?.month ?? Math.min(period, 12),
      day: existing?.day ?? 31,
      yearShift: existing?.yearShift ?? 0,
      derivedStart: existing?.derivedStart ?? null,
      derivedEnd: existing?.derivedEnd ?? null,
    };
  });

  // What each period will be, once the ends in the fields are what is stored. A list held for
  // every year is stored against year zero and shown against this year, as the read side shows it.
  const edited = rows.map((period) => ({ ...period, ...draft[period.period] }));
  const preview = new Map(
    periodWindows(
      edited
        .filter((period) => period.periodType === 'REGULAR')
        .map(({ period, month, day, yearShift }) => ({ period, month, day, yearShift })),
      year === 0 ? thisYear : year,
    ).map((window) => [window.period, window] as const),
  );
  const startText = new Map<number, string>();
  for (const period of rows) {
    const window = preview.get(period.period);
    startText.set(
      period.period,
      editable
        ? window
          ? `${iso(window.start)} → ${iso(window.end)}`
          : t('fiscalYearVariant.notDerived')
        : period.derivedStart && period.derivedEnd
          ? `${period.derivedStart} → ${period.derivedEnd}`
          : t('fiscalYearVariant.notDerived'),
    );
  }

  // The grid is rendered inside the form that submits it when the list is editable, and
  // outside any form when it is read-only, so it is built once and placed by the branch.
  const grid = (
        <table className="grid-table min-w-[38.75rem]">
          <thead>
            <tr>
              <th>{t('fiscalYearVariant.period')}</th>
              <th>{t('fiscalYearVariant.periodType')}</th>
              <th>{t('fiscalYearVariant.periodEnds')}</th>
              <th>{t('fiscalYearVariant.periodStart')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((period) => (
              <tr key={period.period}>
                <td className="tabular">
                  {period.period}
                  <input type="hidden" name="periodNumber" value={period.period} />
                </td>
                <td>
                  <span className={period.periodType === 'SPECIAL' ? 'chip chip-neutral' : 'chip'}>
                    {period.periodType === 'SPECIAL'
                      ? t('fiscalYearVariant.special')
                      : t('fiscalYearVariant.regular')}
                  </span>
                </td>
                <td>
                  {editable ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <select
                        name="periodMonth"
                        aria-label={`${t('fiscalYearVariant.periodMonth')} ${period.period}`}
                        className="field-input tabular w-20"
                        defaultValue={period.month}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (!Number.isFinite(value)) return;
                          setDraft((current) => ({
                            ...current,
                            [period.period]: { ...current[period.period], month: value },
                          }));
                        }}
                        disabled={pending}
                      >
                        {MONTHS.map((month) => (
                          <option key={month} value={month}>{month}</option>
                        ))}
                      </select>
                      <input
                        name="periodDay"
                        aria-label={`${t('fiscalYearVariant.periodDay')} ${period.period}`}
                        className="field-input tabular w-20"
                        type="number"
                        min={1}
                        max={31}
                        defaultValue={period.day}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (!Number.isFinite(value)) return;
                          setDraft((current) => ({
                            ...current,
                            [period.period]: { ...current[period.period], day: value },
                          }));
                        }}
                        disabled={pending}
                      />
                      <select
                        name="periodYearShift"
                        aria-label={`${t('fiscalYearVariant.periodYearShift')} ${period.period}`}
                        className="field-input tabular w-20"
                        defaultValue={period.yearShift}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (!Number.isFinite(value)) return;
                          setDraft((current) => ({
                            ...current,
                            [period.period]: { ...current[period.period], yearShift: value },
                          }));
                        }}
                        disabled={pending}
                      >
                        {SHIFTS.map((shift) => (
                          <option key={shift} value={shift}>{shift > 0 ? `+${shift}` : shift}</option>
                        ))}
                      </select>
                    </span>
                  ) : (
                    <span className="tabular">
                      {t('fiscalYearVariant.endOfMonth', {
                        month: String(period.month),
                        day: String(period.day),
                        shift: String(period.yearShift),
                      })}
                    </span>
                  )}
                </td>
                <td className="tabular text-xs text-ink-soft">
                  {startText.get(period.period)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
  );

  return (
    <div className="mt-2 space-y-2">
      {row.isYearDependent ? (
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          {t('fiscalYearVariant.calendarYearLabel')}
          <input
            type="number"
            className="field-input tabular w-28"
            value={year}
            min={1}
            max={9999}
            disabled={!editable || pending}
            onChange={(event) => setYear(Number(event.target.value))}
          />
          <span>{t('fiscalYearVariant.yearDependentRule')}</span>
        </label>
      ) : (
        <p className="border border-line bg-white p-3 text-xs text-ink-soft">
          {t('fiscalYearVariant.everyYearRule')}
        </p>
      )}

      {editable ? (
        <form action={formAction} className="space-y-2">
          <input type="hidden" name="variant" value={row.variant} />
          <input type="hidden" name="calendarYear" value={year} />
          <input type="hidden" name="expectedVersion" value={row.version} />
          {grid}
          <p className="border border-line bg-white p-3 text-xs text-ink-soft">
            {t('fiscalYearVariant.startPreview')}
          </p>
          <ActionMessage state={state} />
          <p className="border border-line bg-white p-3 text-xs text-ink-soft">
            {t('fiscalYearVariant.periodEditorRule', { total: String(total), regular: String(row.regularPeriods) })}
          </p>
          <div>
            <label htmlFor={`fyv-periods-reason-${row.variant}`} className="field-label">
              {t('fiscalYearVariant.reason')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <textarea
              id={`fyv-periods-reason-${row.variant}`}
              name="reason"
              rows={2}
              maxLength={500}
              className="field-input"
              value={reason}
              readOnly={pending}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary" disabled={pending || !reason.trim()}>
            {pending ? t('common.saving') : t('fiscalYearVariant.periodSave')}
          </button>
        </form>
      ) : (
        <>
          {grid}
          <p className="border border-line bg-white p-3 text-xs text-ink-soft">
            {t('fiscalYearVariant.periodsReadOnly')}
          </p>
        </>
      )}
    </div>
  );
}

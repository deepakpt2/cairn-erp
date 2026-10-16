'use client';

import { useState } from 'react';
import { t } from '@/platform/i18n';
import type { FiscalYearVariantRow } from '@/modules/foundation/fiscal-year-variant-maintenance';

const VARIANT_PATTERN = /^[A-Z0-9]{2}$/;

/**
 * OB29 Fiscal Year Variants: the registry grid, the create form and the period drill-down.
 *
 * The period list is rendered only for a variant whose year is not the calendar year, because
 * a calendar-year variant's periods are derived from its own parameters — twelve monthly
 * periods and the special periods after them — and a screen that offered to edit them would
 * offer to make the variant disagree with itself. Where the list is shown, the start column is
 * derived rather than stored, and is labelled as derived: it is the half of the definition
 * nobody wrote down, and a consultant reading only the ends cannot see whether the year is
 * covered.
 *
 * Writes are deliberately inert: the service stage publishes them.
 */
export function FiscalYearVariantForm({
  variants,
  canMaintain,
}: {
  variants: FiscalYearVariantRow[];
  canMaintain: boolean;
}) {
  const [variant, setVariant] = useState('');
  const [name, setName] = useState('');
  const [isCalendarYear, setIsCalendarYear] = useState(false);
  const [regularPeriods, setRegularPeriods] = useState('12');
  const [specialPeriods, setSpecialPeriods] = useState('4');
  const [isYearDependent, setIsYearDependent] = useState(false);
  const [reason, setReason] = useState('');

  const regular = Number(regularPeriods);
  const special = Number(specialPeriods);
  const key = variant.trim().toUpperCase();

  const problems: string[] = [];
  if (!VARIANT_PATTERN.test(key)) problems.push(t('fiscalYearVariant.keyRule'));
  else if (variants.some((row) => row.variant === key)) {
    problems.push(t('fiscalYearVariant.keyTaken', { variant: key }));
  }
  if (!name.trim()) problems.push(t('fiscalYearVariant.nameRequired'));
  else if (name.trim().length > 30) problems.push(t('fiscalYearVariant.nameTooLong'));
  if (!Number.isInteger(regular) || regular < 1 || regular > 16) {
    problems.push(t('fiscalYearVariant.regularRule'));
  }
  if (!Number.isInteger(special) || special < 0 || special > 4) {
    problems.push(t('fiscalYearVariant.specialRule'));
  }
  // The same combination the derivation refuses: more periods than a shifted year can hold
  // without running past the next calendar year as well.
  if (!isCalendarYear && regular > 12 && !isYearDependent) {
    problems.push(t('fiscalYearVariant.shiftedTooLong'));
  }
  if (!reason.trim()) problems.push(t('fiscalYearVariant.reasonRequired'));

  const canSubmit = canMaintain && problems.length === 0;

  return (
    <section className="panel overflow-hidden" aria-labelledby="oby7-variant-create-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="oby7-variant-create-title" className="font-semibold">{t('fiscalYearVariant.createTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('fiscalYearVariant.createRule')}</p>
      </div>

      {canMaintain ? (
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="oby7-variant" className="field-label">
              {t('fiscalYearVariant.key')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="oby7-variant"
              name="variant"
              className="field-input code"
              maxLength={2}
              value={variant}
              placeholder="K4"
              onChange={(event) => setVariant(event.target.value.toUpperCase())}
            />
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="oby7-variant-name" className="field-label">
              {t('fiscalYearVariant.name')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="oby7-variant-name"
              name="name"
              className="field-input"
              maxLength={30}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div>
            <label htmlFor="oby7-regular" className="field-label">
              {t('fiscalYearVariant.regularPeriods')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <input
              id="oby7-regular"
              name="regularPeriods"
              className="field-input tabular"
              type="number"
              min={1}
              max={16}
              value={regularPeriods}
              onChange={(event) => setRegularPeriods(event.target.value)}
            />
          </div>

          <div>
            <label htmlFor="oby7-special" className="field-label">
              {t('fiscalYearVariant.specialPeriods')}
            </label>
            <input
              id="oby7-special"
              name="specialPeriods"
              className="field-input tabular"
              type="number"
              min={0}
              max={4}
              value={specialPeriods}
              onChange={(event) => setSpecialPeriods(event.target.value)}
            />
          </div>

          <div className="space-y-2 sm:col-span-2 lg:col-span-3">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                name="isCalendarYear"
                className="mt-1 h-4 w-4"
                checked={isCalendarYear}
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
                onChange={(event) => setIsYearDependent(event.target.checked)}
              />
              <span>
                {t('fiscalYearVariant.yearDependent')}
                <span className="block text-xs text-ink-soft">{t('fiscalYearVariant.yearDependentHint')}</span>
              </span>
            </label>
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor="oby7-variant-reason" className="field-label">
              {t('fiscalYearVariant.reason')}
              <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
            </label>
            <textarea
              id="oby7-variant-reason"
              name="reason"
              rows={2}
              maxLength={200}
              className="field-input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <div className="space-y-2 sm:col-span-2 lg:col-span-3">
            {problems.map((problem) => (
              <p key={problem} className="border border-line bg-white p-3 text-sm text-ink-soft">{problem}</p>
            ))}
            <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
              {t('fiscalYearVariant.inert')}
            </p>
            <button type="button" className="btn-primary" disabled={!canSubmit} title={t('fiscalYearVariant.inert')}>
              {t('fiscalYearVariant.create')}
            </button>
          </div>
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
    <section className="panel overflow-hidden" aria-labelledby="oby7-variant-list-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="oby7-variant-list-title" className="font-semibold">{t('fiscalYearVariant.listTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('fiscalYearVariant.listRule')}</p>
      </div>

      {variants.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('fiscalYearVariant.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[880px]">
            <thead>
              <tr>
                <th>{t('fiscalYearVariant.key')}</th>
                <th>{t('fiscalYearVariant.name')}</th>
                <th>{t('fiscalYearVariant.calendarYear')}</th>
                <th>{t('fiscalYearVariant.regularPeriods')}</th>
                <th>{t('fiscalYearVariant.specialPeriods')}</th>
                <th>{t('fiscalYearVariant.yearDependent')}</th>
                <th>{t('fiscalYearVariant.status')}</th>
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
                  <td>
                    <details className="text-sm">
                      <summary className="cursor-pointer list-none border border-line bg-white px-2 py-1 hover:bg-sunken">
                        {t('fiscalYearVariant.showPeriods')}
                      </summary>
                      <PeriodTable row={row} canMaintain={canMaintain} />
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

function PeriodTable({ row, canMaintain }: { row: FiscalYearVariantRow; canMaintain: boolean }) {
  const years = row.years.length > 0 ? row.years : [0];
  const [year, setYear] = useState(years[0]!);
  const periods = row.periods.filter((period) => period.calendarYear === year);

  if (row.isCalendarYear) {
    // The contract's rule: a calendar-year variant's periods are generated from its own
    // parameters, so there is no per-period mapping to maintain and none is offered.
    return (
      <p className="mt-2 border border-line bg-white p-3 text-xs text-ink-soft">
        {t('fiscalYearVariant.periodsDerived', {
          regular: String(row.regularPeriods),
          special: String(row.specialPeriods),
        })}
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {row.isYearDependent && (
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          {t('fiscalYearVariant.calendarYearLabel')}
          <select
            className="field-input code w-28"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          >
            {years.map((entry) => (
              <option key={entry} value={entry}>
                {entry === 0 ? t('fiscalYearVariant.everyYear') : entry}
              </option>
            ))}
          </select>
        </label>
      )}

      {periods.length === 0 ? (
        <p className="border border-line bg-white p-3 text-xs text-ink-soft">{t('fiscalYearVariant.noPeriods')}</p>
      ) : (
        <table className="grid-table min-w-[560px]">
          <thead>
            <tr>
              <th>{t('fiscalYearVariant.period')}</th>
              <th>{t('fiscalYearVariant.periodType')}</th>
              <th>{t('fiscalYearVariant.periodEnds')}</th>
              <th>{t('fiscalYearVariant.periodStart')}</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={`${period.calendarYear}-${period.period}`}>
                <td className="tabular">{period.period}</td>
                <td>
                  <span className={period.periodType === 'SPECIAL' ? 'chip chip-neutral' : 'chip'}>
                    {period.periodType === 'SPECIAL'
                      ? t('fiscalYearVariant.special')
                      : t('fiscalYearVariant.regular')}
                  </span>
                </td>
                <td className="tabular">
                  {t('fiscalYearVariant.endOfMonth', {
                    month: String(period.month),
                    day: String(period.day),
                    shift: String(period.yearShift),
                  })}
                </td>
                <td className="tabular text-xs text-ink-soft">
                  {period.derivedStart && period.derivedEnd
                    ? `${period.derivedStart} → ${period.derivedEnd}`
                    : t('fiscalYearVariant.notDerived')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="border border-line bg-white p-3 text-xs text-ink-soft">
        {canMaintain ? t('fiscalYearVariant.periodsInert') : t('fiscalYearVariant.periodsReadOnly')}
      </p>
    </div>
  );
}

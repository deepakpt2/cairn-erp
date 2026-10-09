'use client';

import { useState } from 'react';
import { t } from '@/platform/i18n';

export interface PeriodRuleRow {
  accountType: string;
  accountTypeLabel: string;
  periodFrom: number;
  periodTo: number;
  allowSpecialPeriods: boolean;
}

/**
 * Period rule editor — FIN.CLOSE.PERIOD.
 *
 * A client component because this is genuinely interactive: the user is deciding
 * what the books will accept, and the visual grid of open periods makes the
 * consequence of a change obvious before it is applied.
 *
 * Saving goes through a server action, which writes a change document. Closing a
 * period is not a preference — it is a control, and controls are logged.
 */
export function PeriodRules({
  canEdit,
  variant,
  rules,
  regularPeriods,
  specialPeriods,
  onSave,
}: {
  canEdit: boolean;
  variant: string;
  rules: PeriodRuleRow[];
  regularPeriods: number;
  specialPeriods: number;
  onSave: (formData: FormData) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [rows, setRows] = useState(rules);
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [pending, setPending] = useState(false);

  const totalPeriods = regularPeriods + specialPeriods;

  async function apply(accountType: string) {
    const row = rows.find((r) => r.accountType === accountType);
    if (!row) return;

    setPending(true);
    const formData = new FormData();
    formData.set('variant', variant);
    formData.set('accountType', row.accountType);
    formData.set('periodFrom', String(row.periodFrom));
    formData.set('periodTo', String(row.periodTo));
    formData.set('allowSpecialPeriods', row.allowSpecialPeriods ? 'on' : '');

    const outcome = await onSave(formData);
    setResult(outcome);
    setPending(false);
  }

  function update(accountType: string, patch: Partial<PeriodRuleRow>) {
    setRows((current) =>
      current.map((row) => (row.accountType === accountType ? { ...row, ...patch } : row)),
    );
    setResult(null);
  }

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <h2 className="panel-title">{t('pp.title')}</h2>
        <span className="code text-ink-faint">{variant}</span>
      </div>

      {result && (
        <div
          className={`border-b px-3 py-2 text-sm ${
            result.ok
              ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok'
              : 'border-signal-error/30 bg-signal-error-soft text-signal-error'
          }`}
        >
          {result.ok ? result.message : result.message}
        </div>
      )}

      <table className="grid-table">
        <thead>
          <tr>
            <th className="w-44">{t('pp.accountType')}</th>
            <th className="w-24">{t('pp.from')}</th>
            <th className="w-24">{t('pp.to')}</th>
            <th>{t('pp.openRange')}</th>
            <th className="w-28">{t('pp.specials')}</th>
            <th className="w-24" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.accountType}>
              <td className="font-medium">{row.accountTypeLabel}</td>
              <td>
                <input
                  type="number"
                  disabled={!canEdit}
                  min={1}
                  max={totalPeriods}
                  value={row.periodFrom}
                  onChange={(e) =>
                    update(row.accountType, { periodFrom: Number(e.target.value) })
                  }
                  className="field-input tabular w-20"
                />
              </td>
              <td>
                <input
                  type="number"
                  disabled={!canEdit}
                  min={1}
                  max={totalPeriods}
                  value={row.periodTo}
                  onChange={(e) =>
                    update(row.accountType, { periodTo: Number(e.target.value) })
                  }
                  className="field-input tabular w-20"
                />
              </td>
              <td>
                {/* A visual of the period grid: open periods filled, closed periods
                    empty. Reading a bar of squares is faster than reading two
                    numbers, and a mistake is visible before saving. */}
                <div className="flex gap-px" role="img" aria-label={`Open periods ${row.periodFrom} to ${row.periodTo}`}>
                  {Array.from({ length: totalPeriods }, (_, index) => {
                    const period = index + 1;
                    const isSpecial = period > regularPeriods;
                    const isOpen =
                      period >= row.periodFrom &&
                      period <= row.periodTo &&
                      (!isSpecial || row.allowSpecialPeriods);
                    return (
                      <span
                        key={period}
                        title={`Period ${period}${isSpecial ? ' (special)' : ''}`}
                        className={`h-4 w-4 border ${
                          isOpen
                            ? 'border-accent bg-accent'
                            : 'border-line-strong bg-sunken'
                        } ${isSpecial ? 'border-dashed' : ''}`}
                      />
                    );
                  })}
                </div>
              </td>
              <td>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={row.allowSpecialPeriods}
                    onChange={(e) =>
                      update(row.accountType, { allowSpecialPeriods: e.target.checked })
                    }
                    className="accent-accent"
                  />
                  <span className="text-ink-soft">
                    {regularPeriods + 1}–{totalPeriods}
                  </span>
                </label>
              </td>
              <td className="text-end">
                <button
                  type="button"
                  onClick={() => apply(row.accountType)}
                  disabled={pending || !canEdit}
                  className="btn btn-default"
                >
                  {t('pp.save')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-line bg-sunken px-3 py-2 text-2xs text-ink-faint">
        {t('pp.note')}
      </p>
    </div>
  );
}

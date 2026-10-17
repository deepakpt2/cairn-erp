'use client';

import { useState, type FormEvent } from 'react';

import { t } from '@/platform/i18n';
import type { PostingPeriodVariantAssignmentRow } from '@/modules/foundation/posting-period-variant-assignment';

export interface PostingPeriodVariantChoice {
  variant: string;
  name: string;
}

function DialogHeader({ code, label }: { code: string; label: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">OBBP · {code}</span>
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
 * The write path arrives with the service (SCR-033 stage 3). An inert form says so
 * rather than pretending: a button that silently does nothing teaches an operator
 * that the screen is broken. Same pattern as the OBBO screen's first stage.
 */
function inertSubmit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  window.alert(t('ppvAssign.inert'));
}

function AssignmentControl({
  row,
  choices,
}: {
  row: PostingPeriodVariantAssignmentRow;
  choices: PostingPeriodVariantChoice[];
}) {
  const [variant, setVariant] = useState(row.postingPeriodVariant ?? '');
  const [reason, setReason] = useState('');
  const label = `${t('ppvAssign.assign')} ${row.companyCode}`;
  const clearing = variant === '' && row.postingPeriodVariant !== null;
  const unchanged = variant === (row.postingPeriodVariant ?? '');

  return (
    <details className="min-w-28">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {row.postingPeriodVariant ? t('ppvAssign.change') : t('ppvAssign.assign')}
      </summary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
      >
        <div className="mx-auto max-w-2xl">
          <DialogHeader code={row.companyCode} label={label} />
          <section className="panel overflow-hidden p-4">
            <form className="space-y-3" onSubmit={inertSubmit}>
              <input type="hidden" name="companyCode" value={row.companyCode} />
              <input type="hidden" name="expectedVariant" value={row.postingPeriodVariant ?? ''} />

              <div>
                <span className="field-label">{t('ppvAssign.companyCode')}</span>
                <p className="code font-medium">{row.companyCode}</p>
                <p className="text-sm text-ink-soft">{row.name}</p>
              </div>

              <div>
                <label htmlFor={`ppv-assign-variant-${row.companyCode}`} className="field-label">
                  {t('ppvAssign.variant')}
                  <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                </label>
                <select
                  id={`ppv-assign-variant-${row.companyCode}`}
                  name="variant"
                  className="field-input code"
                  value={variant}
                  onChange={(event) => setVariant(event.target.value)}
                >
                  <option value="">{t('cc.unassigned')}</option>
                  {choices.map((choice) => (
                    <option key={choice.variant} value={choice.variant}>
                      {choice.variant} — {choice.name}
                    </option>
                  ))}
                </select>
                {clearing && row.postedDocuments > 0 && (
                  <p className="mt-1 text-xs text-signal-error">
                    {t('ppvAssign.clearingPosted', { count: String(row.postedDocuments) })}
                  </p>
                )}
                {clearing && row.postedDocuments === 0 && (
                  <p className="mt-1 text-xs text-ink-soft">{t('ppvAssign.clearingRule')}</p>
                )}
              </div>

              <div>
                <label htmlFor={`ppv-assign-reason-${row.companyCode}`} className="field-label">
                  {t('ppvAssign.reason')}
                  <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                </label>
                <textarea
                  id={`ppv-assign-reason-${row.companyCode}`}
                  name="reason"
                  className="field-input"
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>

              <button
                type="submit"
                className="btn-primary"
                disabled={!reason.trim() || unchanged}
              >
                {t('ppvAssign.save')}
              </button>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

export function PostingPeriodVariantAssignments({
  rows,
  choices,
  canMaintain,
}: {
  rows: PostingPeriodVariantAssignmentRow[];
  choices: PostingPeriodVariantChoice[];
  canMaintain: boolean;
}) {
  return (
    <section className="panel overflow-hidden" aria-labelledby="ppv-assign-grid-title">
      <div className="panel-header">
        <h2 id="ppv-assign-grid-title" className="panel-title">
          {t('ppvAssign.gridTitle')}
        </h2>
      </div>
      <div className="overflow-x-auto">
        <table className="grid-table min-w-[640px]">
          <thead>
            <tr>
              <th>{t('ppvAssign.companyCode')}</th>
              <th>{t('ppvAssign.companyName')}</th>
              <th>{t('ppvAssign.variant')}</th>
              <th>{t('ppvAssign.status')}</th>
              {canMaintain && <th>{t('ppvAssign.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.companyCode}>
                <td className="code font-semibold">{row.companyCode}</td>
                <td>{row.name}</td>
                <td>
                  {row.postingPeriodVariant ? (
                    <span>
                      <span className="code">{row.postingPeriodVariant}</span>
                      {row.variantName ? (
                        <span className="text-ink-soft"> — {row.variantName}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-ink-faint">{t('cc.unassigned')}</span>
                  )}
                </td>
                <td>
                  <span className={row.isActive ? 'chip' : 'chip chip-neutral'}>
                    {row.isActive ? t('ppvAssign.active') : t('ppvAssign.inactive')}
                  </span>
                </td>
                {canMaintain && (
                  <td>
                    <AssignmentControl row={row} choices={choices} />
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={canMaintain ? 5 : 4} className="px-4 py-8 text-center text-sm text-ink-soft">
                  {t('ppvAssign.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

'use client';

import { useState } from 'react';
import { t } from '@/platform/i18n';

export interface AssignableCompanyCode {
  code: string;
  name: string;
  currency: string;
  fiscalYearVariant: string | null;
  isActive: boolean;
  postedDocuments: number;
  firstPostedYear: number | null;
  lastPostedYear: number | null;
  /** The Controlling Area this Company Code is linked to, if any. */
  area: { code: string; name: string | null; variant: string | null; scope: string | null } | null;
  /** The other Company Codes in that area, with the variant each one holds. */
  areaSiblings: Array<{ code: string; variant: string | null }>;
}

export interface AssignableVariant {
  code: string;
  name: string;
  isActive: boolean;
}

/**
 * OB37 Assign Fiscal Year Variant to Company Code.
 *
 * A grid of every Company Code in the tenant beside the variant it holds, with a per-row
 * dialog rather than one form for the whole grid: the decision belongs to one book, its reason
 * belongs beside that decision, and a bulk save would file one reason against several books
 * that an auditor cannot tell apart afterwards.
 *
 * Each row states its own constraints before anybody submits. A Company Code linked to a
 * Controlling Area shares that area's fiscal year variant with the area's other Company Codes,
 * so a reassignment that would break the shared variant is refused here and named — with the
 * siblings that would disagree — rather than discovered on save. A Company Code that has posted
 * documents can still be reassigned, because the owner ruled that a book may change calendar,
 * but only with a reason, and the row says how many documents and which years are affected:
 * those documents keep the period they were posted in, so from the change onward the same
 * variant means a different set of dates than it did before.
 *
 * The variant picker lists code and description together, which is what the reference F4 shows;
 * only active variants are offered, and a variant in use cannot be retired, so a Company Code
 * can never be left pointing at one.
 */
export function AssignCompanyCodesUI({
  companyCodes,
  variants,
  canMaintain,
}: {
  companyCodes: AssignableCompanyCode[];
  variants: AssignableVariant[];
  canMaintain: boolean;
}) {
  const active = variants.filter((variant) => variant.isActive);

  return (
    <section className="panel overflow-hidden" aria-labelledby="ob37-grid-title">
      <div className="border-b border-line bg-sunken px-4 py-3">
        <h2 id="ob37-grid-title" className="font-semibold">{t('fyvAssignment.gridTitle')}</h2>
        <p className="mt-1 text-xs text-ink-soft">{t('fyvAssignment.gridRule')}</p>
      </div>

      {companyCodes.length === 0 ? (
        <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{t('fyvAssignment.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[900px]">
            <thead>
              <tr>
                <th>{t('fyvAssignment.companyCode')}</th>
                <th>{t('fyvAssignment.companyName')}</th>
                <th>{t('fyvAssignment.variant')}</th>
                <th>{t('fyvAssignment.controllingArea')}</th>
                <th>{t('fyvAssignment.postedDocuments')}</th>
                {canMaintain && <th>{t('fyvAssignment.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {companyCodes.map((row) => (
                <CompanyCodeRow
                  key={row.code}
                  row={row}
                  variants={variants}
                  activeVariants={active}
                  canMaintain={canMaintain}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!canMaintain && (
        <p role="status" className="border-t border-line px-4 py-3 text-sm text-ink-soft">
          {t('fyvAssignment.readOnly')}
        </p>
      )}
    </section>
  );
}

function CompanyCodeRow({
  row,
  variants,
  activeVariants,
  canMaintain,
}: {
  row: AssignableCompanyCode;
  variants: AssignableVariant[];
  activeVariants: AssignableVariant[];
  canMaintain: boolean;
}) {
  const [variant, setVariant] = useState(row.fiscalYearVariant ?? '');
  const [reason, setReason] = useState('');

  const current = variants.find((entry) => entry.code === row.fiscalYearVariant) ?? null;
  const proposed = variants.find((entry) => entry.code === variant) ?? null;

  const problems: string[] = [];
  const notices: string[] = [];

  if (!variant) {
    problems.push(t('fyvAssignment.variantRequired'));
  } else if (!proposed || !proposed.isActive) {
    problems.push(t('fyvAssignment.variantUnknown', { variant }));
  } else if (variant === row.fiscalYearVariant) {
    notices.push(t('fyvAssignment.alreadyAssigned', { variant }));
  }

  // A Company Code in a Controlling Area holds that area's variant, and so does every other
  // Company Code in it. Refusing here is the same rule the service applies; showing it here is
  // what keeps the refusal from being a surprise.
  if (proposed && row.area && row.area.variant && row.area.variant !== proposed.code) {
    const disagreeing = row.areaSiblings.filter((sibling) => sibling.variant !== proposed.code);
    problems.push(t('fyvAssignment.areaConflict', {
      area: row.area.code,
      areaVariant: row.area.variant,
      variant: proposed.code,
    }));
    if (disagreeing.length > 0) {
      problems.push(t('fyvAssignment.areaSiblings', {
        siblings: disagreeing.map((sibling) => sibling.code).join(', '),
      }));
    }
  }

  if (proposed && row.postedDocuments > 0) {
    notices.push(t('fyvAssignment.postingsWarning', {
      count: String(row.postedDocuments),
      years: row.firstPostedYear === row.lastPostedYear
        ? String(row.firstPostedYear)
        : `${row.firstPostedYear ?? ''}–${row.lastPostedYear ?? ''}`,
    }));
  }
  if (!reason.trim()) problems.push(t('fyvAssignment.reasonRequired'));

  const canSubmit = canMaintain && problems.length === 0;
  const label = `${t('fyvAssignment.assign')} ${row.code}`;

  return (
    <tr>
      <td className="code font-semibold">{row.code}</td>
      <td>
        {row.name}
        <span className="block text-xs text-ink-faint">{t('fyvAssignment.localCurrency', { currency: row.currency })}</span>
      </td>
      <td>
        {row.fiscalYearVariant ? (
          <>
            <span className="code">{row.fiscalYearVariant}</span>
            <span className="block text-xs text-ink-soft">
              {current ? current.name : t('fyvAssignment.variantUnknownShort')}
            </span>
            {!current?.isActive && (
              <span className="chip chip-neutral">{t('fyvAssignment.variantInactive')}</span>
            )}
          </>
        ) : (
          <span className="chip chip-neutral">{t('fyvAssignment.unassigned')}</span>
        )}
      </td>
      <td>
        {row.area ? (
          <>
            <span className="code">{row.area.code}</span>
            <span className="block text-xs text-ink-soft">
              {row.area.variant
                ? t('fyvAssignment.areaVariant', { variant: row.area.variant })
                : t('fyvAssignment.areaNoVariant')}
            </span>
          </>
        ) : (
          <span className="text-xs text-ink-faint">{t('fyvAssignment.noArea')}</span>
        )}
      </td>
      <td className="tabular">
        {row.postedDocuments > 0 ? (
          <>
            {row.postedDocuments}
            <span className="block text-xs text-ink-faint">
              {row.firstPostedYear === row.lastPostedYear
                ? String(row.firstPostedYear)
                : `${row.firstPostedYear ?? ''}–${row.lastPostedYear ?? ''}`}
            </span>
          </>
        ) : (
          <span className="text-xs text-ink-faint">{t('fyvAssignment.noPostings')}</span>
        )}
      </td>
      {canMaintain && (
        <td>
          <details className="min-w-32">
            <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
              {t('fyvAssignment.assign')}
            </summary>
            <div
              role="dialog"
              aria-modal="true"
              aria-label={label}
              className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
            >
              <div className="mx-auto max-w-2xl">
                <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
                  <div>
                    <span className="code text-xs text-ink-faint">OB37 · {row.code}</span>
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

                <section className="panel overflow-hidden">
                  <div className="border-b border-line bg-sunken px-4 py-3">
                    <h3 className="font-semibold">{t('fyvAssignment.dialogRule')}</h3>
                  </div>
                  <form
                    className="space-y-3 p-4"
                    onSubmit={(event) => {
                      // Stage 1 renders the decision and its refusals; the write arrives with the
                      // assignment service, and an inert form says so rather than pretending.
                      event.preventDefault();
                      window.alert(t('fyvAssignment.inert'));
                    }}
                  >
                    <input type="hidden" name="companyCode" value={row.code} />
                    <input type="hidden" name="expectedVariant" value={row.fiscalYearVariant ?? ''} />

                    <div>
                      <label htmlFor={`ob37-variant-${row.code}`} className="field-label">
                        {t('fyvAssignment.variant')}
                        <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                      </label>
                      <select
                        id={`ob37-variant-${row.code}`}
                        name="fiscalYearVariant"
                        className="field-input code"
                        value={variant}
                        onChange={(event) => setVariant(event.target.value)}
                      >
                        <option value="">{t('fyvAssignment.chooseVariant')}</option>
                        {activeVariants.map((entry) => (
                          <option key={entry.code} value={entry.code}>
                            {`${entry.code} — ${entry.name}`}
                          </option>
                        ))}
                        {current && !current.isActive && (
                          <option value={current.code}>
                            {`${current.code} — ${current.name} (${t('fyvAssignment.variantInactive')})`}
                          </option>
                        )}
                      </select>
                      <p className="mt-1 text-xs text-ink-faint">{t('fyvAssignment.variantHelp')}</p>
                    </div>

                    <div>
                      <label htmlFor={`ob37-reason-${row.code}`} className="field-label">
                        {t('fyvAssignment.reason')}
                        <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                      </label>
                      <textarea
                        id={`ob37-reason-${row.code}`}
                        name="reason"
                        rows={3}
                        maxLength={500}
                        className="field-input"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      <p className="mt-1 text-xs text-ink-faint">{t('fyvAssignment.reasonHelp')}</p>
                    </div>

                    <div className="space-y-2">
                      {notices.map((notice) => (
                        <p key={notice} role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
                          {notice}
                        </p>
                      ))}
                      {problems.map((problem) => (
                        <p key={problem} role="alert" className="border border-line bg-white p-3 text-sm text-ink-soft">
                          {problem}
                        </p>
                      ))}
                      <button type="submit" className="btn-primary" disabled={!canSubmit}>
                        {t('fyvAssignment.assign')}
                      </button>
                    </div>
                  </form>
                </section>
              </div>
            </div>
          </details>
        </td>
      )}
    </tr>
  );
}

'use client';

import { t } from '@/platform/i18n';
import type {
  DocumentTypeRow,
  IntervalChoice,
} from '@/modules/foundation/document-type-definition';

/** The five account kinds a type may post to, as the engine's letters. */
const ACCOUNT_KINDS = [
  { letter: 'A', labelKey: 'docType.acct.A' },
  { letter: 'D', labelKey: 'docType.acct.D' },
  { letter: 'K', labelKey: 'docType.acct.K' },
  { letter: 'M', labelKey: 'docType.acct.M' },
  { letter: 'S', labelKey: 'docType.acct.S' },
] as const;

const REVERSAL_MODES = ['REVERSE_AND_ALT_DATE', 'REVERSE_ONLY', 'NO_REVERSE'] as const;

function DialogHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
      <div>
        <span className="code text-xs text-ink-faint">OBA7 · {sub}</span>
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

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function ReasonField({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {t('docType.reason')}<RequiredMark />
      </label>
      <textarea id={id} name="reason" className="field-input" rows={2} maxLength={500} disabled />
    </div>
  );
}

function InertNote() {
  return (
    <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
      {t('docType.inert')}
    </p>
  );
}

function IntervalSelect({
  id,
  intervals,
  defaultValue,
}: {
  id: string;
  intervals: IntervalChoice[];
  defaultValue?: string;
}) {
  return (
    <select id={id} name="interval" className="field-input" defaultValue={defaultValue ?? ''} disabled>
      <option value="">{t('docType.chooseInterval')}</option>
      {intervals.map((interval) => (
        <option key={`${interval.objectCode}/${interval.subObject}`} value={`${interval.objectCode}|${interval.subObject}`}>
          {interval.objectCode} · {interval.subObject}
        </option>
      ))}
    </select>
  );
}

function TypeFields({
  idPrefix,
  intervals,
  types,
  row,
}: {
  idPrefix: string;
  intervals: IntervalChoice[];
  types: DocumentTypeRow[];
  row: DocumentTypeRow | null;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-interval`} className="field-label">
            {t('docType.interval')}<RequiredMark />
          </label>
          <IntervalSelect
            id={`${idPrefix}-interval`}
            intervals={intervals}
            defaultValue={row ? `${row.numberRangeObject}|${row.numberRangeSubObject}` : undefined}
          />
          <p className="mt-1 text-xs text-ink-soft">{t('docType.intervalHint')}</p>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-reversal-type`} className="field-label">{t('docType.reversal')}</label>
          <select id={`${idPrefix}-reversal-type`} name="reversalDocumentType" className="field-input" defaultValue={row?.reversalDocumentType ?? ''} disabled>
            <option value="">{t('docType.noReversalType')}</option>
            {types.map((type) => (
              <option key={type.documentType} value={type.documentType}>
                {type.documentType} — {type.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-reversal-mode`} className="field-label">
            {t('docType.reversalMode')}<RequiredMark />
          </label>
          <select id={`${idPrefix}-reversal-mode`} name="reversalMode" className="field-input" defaultValue={row?.reversalMode ?? 'REVERSE_AND_ALT_DATE'} disabled>
            {REVERSAL_MODES.map((mode) => (
              <option key={mode} value={mode}>{t(`docType.mode.${mode}`)}</option>
            ))}
          </select>
        </div>
      </div>
      <fieldset>
        <legend className="field-label">
          {t('docType.accountTypes')}<RequiredMark />
        </legend>
        <div className="flex flex-wrap gap-4 pt-1">
          {ACCOUNT_KINDS.map((kind) => (
            <label key={kind.letter} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="accountTypes"
                value={kind.letter}
                defaultChecked={row ? row.allowedAccountTypes.includes(kind.letter) : kind.letter === 'S'}
                disabled
              />
              {t(kind.labelKey)} <span className="code text-ink-faint">({kind.letter})</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresReference" defaultChecked={row?.requiresReference ?? false} disabled />
          {t('docType.requiresReference')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresLineText" defaultChecked={row?.requiresLineText ?? false} disabled />
          {t('docType.requiresLineText')}
        </label>
      </div>
    </>
  );
}

/**
 * The stage-1 shape of the screen (SCR-038): every form renders the fields
 * its write will be judged against, disabled, with the inert note where a
 * save answer would stand. The table and its delivered types already exist —
 * the grid below is real data today; the writes arrive in stage 3, and
 * nothing here pretends otherwise.
 */
export function DocumentTypes({
  rows,
  intervals,
  canMaintain,
}: {
  rows: DocumentTypeRow[];
  intervals: IntervalChoice[];
  canMaintain: boolean;
}) {
  return (
    <>
      {canMaintain && (
        <section className="panel overflow-hidden" aria-labelledby="doc-type-create-title">
          <div className="panel-header">
            <h2 id="doc-type-create-title" className="panel-title">{t('docType.newTitle')}</h2>
          </div>
          <form className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="doc-type-code" className="field-label">
                  {t('docType.code')}<RequiredMark />
                </label>
                <input id="doc-type-code" name="documentType" className="field-input code" maxLength={2} placeholder="SA" disabled />
                <p className="mt-1 text-xs text-ink-soft">{t('docType.codeHint')}</p>
              </div>
              <div>
                <label htmlFor="doc-type-name" className="field-label">
                  {t('docType.name')}<RequiredMark />
                </label>
                <input id="doc-type-name" name="name" className="field-input" maxLength={120} disabled />
              </div>
            </div>
            <TypeFields idPrefix="doc-type" intervals={intervals} types={rows} row={null} />
            <ReasonField id="doc-type-reason" />
            <InertNote />
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
              {t('docType.create')}
            </button>
          </form>
        </section>
      )}

      <section className="panel overflow-hidden" aria-labelledby="doc-type-grid-title">
        <div className="panel-header">
          <h2 id="doc-type-grid-title" className="panel-title">{t('docType.gridTitle')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[900px]">
            <thead>
              <tr>
                <th>{t('docType.code')}</th>
                <th>{t('docType.name')}</th>
                <th>{t('docType.interval')}</th>
                <th>{t('docType.reversal')}</th>
                <th>{t('docType.accountTypes')}</th>
                <th>{t('docType.usedBy')}</th>
                <th>{t('docType.active')}</th>
                {canMaintain && <th>{t('docType.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={canMaintain ? 8 : 7} className="text-ink-soft">
                    {t('docType.empty')}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.documentType}>
                    <td><span className="code">{row.documentType}</span></td>
                    <td>{row.name}</td>
                    <td><span className="code">{row.numberRangeObject} · {row.numberRangeSubObject}</span></td>
                    <td><span className="code">{row.reversalDocumentType ?? '—'}</span></td>
                    <td><span className="code">{row.allowedAccountTypes}</span></td>
                    <td>{row.usedByEntries > 0 ? row.usedByEntries : '—'}</td>
                    <td>{row.isActive ? t('common.yes') : t('common.no')}</td>
                    {canMaintain && (
                      <td>
                        <RowDialogs row={row} rows={rows} intervals={intervals} />
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function RowDialogs({
  row,
  rows,
  intervals,
}: {
  row: DocumentTypeRow;
  rows: DocumentTypeRow[];
  intervals: IntervalChoice[];
}) {
  const toggleLabel = row.isActive ? t('docType.deactivate') : t('docType.reactivate');
  return (
    <div className="flex gap-3">
      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {t('docType.change')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('docType.change')} ${row.documentType}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={`${t('docType.change')} ${row.documentType}`} sub={row.name} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <div>
                  <label htmlFor={`doc-type-name-${row.documentType}`} className="field-label">
                    {t('docType.name')}<RequiredMark />
                  </label>
                  <input id={`doc-type-name-${row.documentType}`} name="name" className="field-input" maxLength={120} defaultValue={row.name} disabled />
                </div>
                <TypeFields idPrefix={`doc-type-${row.documentType}`} intervals={intervals} types={rows} row={row} />
                <ReasonField id={`doc-type-change-reason-${row.documentType}`} />
                <InertNote />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                  {t('docType.save')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
          {toggleLabel}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${toggleLabel} ${row.documentType}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={toggleLabel} sub={`${row.documentType} · ${row.name}`} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                <p className="text-sm text-ink-soft">
                  {row.isActive ? t('docType.deactivateNote') : t('docType.reactivateNote')}
                </p>
                <ReasonField id={`doc-type-toggle-reason-${row.documentType}`} />
                <InertNote />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                  {toggleLabel}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>

      <details className="min-w-16">
        <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-signal-error hover:underline sm:min-h-9">
          {t('docType.delete')}
        </summary>
        <div role="dialog" aria-modal="true" aria-label={`${t('docType.delete')} ${row.documentType}`} className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6">
          <div className="mx-auto max-w-2xl">
            <DialogHeader label={t('docType.delete')} sub={`${row.documentType} · ${row.name}`} />
            <section className="panel overflow-hidden p-4">
              <form className="space-y-3">
                {row.usedByEntries > 0 ? (
                  <p role="alert" className="text-sm text-signal-error">
                    {t('docType.deleteBlocked', { count: String(row.usedByEntries) })}
                  </p>
                ) : (
                  <p className="text-sm text-ink-soft">{t('docType.deleteNote')}</p>
                )}
                <ReasonField id={`doc-type-delete-reason-${row.documentType}`} />
                <InertNote />
                <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled>
                  {t('docType.delete')}
                </button>
              </form>
            </section>
          </div>
        </div>
      </details>
    </div>
  );
}

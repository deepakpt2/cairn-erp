'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import type {
  DocumentTypeRow,
  IntervalChoice,
} from '@/modules/foundation/document-type-definition';
import {
  deleteDocumentTypeAction,
  saveDocumentTypeAction,
  setDocumentTypeActiveAction,
  type DocumentTypeActionState,
} from './actions';

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

/** The action's answer, refusal or confirmation, with the remedy underneath it. */
function DocMessage({ state }: { state: DocumentTypeActionState }) {
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

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function ReasonField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {t('docType.reason')}<RequiredMark />
      </label>
      <textarea
        id={id}
        name="reason"
        className="field-input"
        rows={2}
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * The fields a create and a change share: interval, reversal, the account
 * kinds and the requirement flags. The key is not among them — on a change
 * the type is identified by the row the dialog opened from, and a key cannot
 * be edited into another.
 */
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
          <select
            id={`${idPrefix}-interval`}
            name="interval"
            className="field-input"
            defaultValue={row ? `${row.numberRangeObject}|${row.numberRangeSubObject}` : ''}
          >
            <option value="">{t('docType.chooseInterval')}</option>
            {intervals.map((interval) => (
              <option key={`${interval.objectCode}/${interval.subObject}`} value={`${interval.objectCode}|${interval.subObject}`}>
                {interval.objectCode} · {interval.subObject}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-soft">{t('docType.intervalHint')}</p>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-reversal-type`} className="field-label">{t('docType.reversal')}</label>
          <select id={`${idPrefix}-reversal-type`} name="reversalDocumentType" className="field-input" defaultValue={row?.reversalDocumentType ?? ''}>
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
          <select id={`${idPrefix}-reversal-mode`} name="reversalMode" className="field-input" defaultValue={row?.reversalMode ?? 'REVERSE_AND_ALT_DATE'}>
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
              />
              {t(kind.labelKey)} <span className="code text-ink-faint">({kind.letter})</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresReference" defaultChecked={row?.requiresReference ?? false} />
          {t('docType.requiresReference')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requiresLineText" defaultChecked={row?.requiresLineText ?? false} />
          {t('docType.requiresLineText')}
        </label>
      </div>
    </>
  );
}

function CreatePanel({ rows, intervals }: { rows: DocumentTypeRow[]; intervals: IntervalChoice[] }) {
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useActionState<DocumentTypeActionState, FormData>(
    saveDocumentTypeAction,
    { ok: true },
  );

  return (
    <section className="panel overflow-hidden" aria-labelledby="doc-type-create-title">
      <div className="panel-header">
        <h2 id="doc-type-create-title" className="panel-title">{t('docType.newTitle')}</h2>
      </div>
      <form className="space-y-3 p-4" action={formAction}>
        <input type="hidden" name="mode" value="CREATE" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="doc-type-code" className="field-label">
              {t('docType.code')}<RequiredMark />
            </label>
            <input id="doc-type-code" name="documentType" className="field-input code" maxLength={2} placeholder="SA" required />
            <p className="mt-1 text-xs text-ink-soft">{t('docType.codeHint')}</p>
          </div>
          <div>
            <label htmlFor="doc-type-name" className="field-label">
              {t('docType.name')}<RequiredMark />
            </label>
            <input id="doc-type-name" name="name" className="field-input" maxLength={120} required />
          </div>
        </div>
        <TypeFields idPrefix="doc-type" intervals={intervals} types={rows} row={null} />
        <ReasonField id="doc-type-reason" value={reason} onChange={setReason} />
        <DocMessage state={state} />
        <button type="submit" className="btn-primary" disabled={pending || !reason.trim()}>
          {t('docType.create')}
        </button>
      </form>
    </section>
  );
}

/**
 * Change, deactivate-or-reactivate, and delete, one dialog each per row.
 * The Delete dialog says where the type is used before it offers anything:
 * entries carry the type, so the count is every journal entry in the tenant
 * posted under it.
 */
function RowDialogs({
  row,
  rows,
  intervals,
}: {
  row: DocumentTypeRow;
  rows: DocumentTypeRow[];
  intervals: IntervalChoice[];
}) {
  const [changeReason, setChangeReason] = useState('');
  const [toggleReason, setToggleReason] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [changeState, changeAction, changePending] = useActionState<DocumentTypeActionState, FormData>(
    saveDocumentTypeAction,
    { ok: true },
  );
  const [toggleState, toggleAction, togglePending] = useActionState<DocumentTypeActionState, FormData>(
    setDocumentTypeActiveAction,
    { ok: true },
  );
  const [deleteState, deleteAction, deletePending] = useActionState<DocumentTypeActionState, FormData>(
    deleteDocumentTypeAction,
    { ok: true },
  );
  const used = row.usedByEntries > 0;
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
              <form className="space-y-3" action={changeAction}>
                <input type="hidden" name="mode" value="CHANGE" />
                <input type="hidden" name="documentType" value={row.documentType} />
                <div>
                  <label htmlFor={`doc-type-name-${row.documentType}`} className="field-label">
                    {t('docType.name')}<RequiredMark />
                  </label>
                  <input id={`doc-type-name-${row.documentType}`} name="name" className="field-input" maxLength={120} defaultValue={row.name} required />
                </div>
                <TypeFields idPrefix={`doc-type-${row.documentType}`} intervals={intervals} types={rows} row={row} />
                <ReasonField id={`doc-type-change-reason-${row.documentType}`} value={changeReason} onChange={setChangeReason} />
                <DocMessage state={changeState} />
                <button type="submit" className="btn-primary" disabled={changePending || !changeReason.trim()}>
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
              <form className="space-y-3" action={toggleAction}>
                <input type="hidden" name="documentType" value={row.documentType} />
                <input type="hidden" name="active" value={row.isActive ? 'false' : 'true'} />
                <p className="text-sm text-ink-soft">
                  {row.isActive ? t('docType.deactivateNote') : t('docType.reactivateNote')}
                </p>
                <ReasonField id={`doc-type-toggle-reason-${row.documentType}`} value={toggleReason} onChange={setToggleReason} />
                <DocMessage state={toggleState} />
                <button type="submit" className="btn-primary" disabled={togglePending || !toggleReason.trim()}>
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
              <form className="space-y-3" action={deleteAction}>
                <input type="hidden" name="documentType" value={row.documentType} />
                {used ? (
                  <p role="alert" className="text-sm text-signal-error">
                    {t('docType.deleteBlocked', { count: String(row.usedByEntries) })}
                  </p>
                ) : (
                  <p className="text-sm text-ink-soft">{t('docType.deleteNote')}</p>
                )}
                <ReasonField id={`doc-type-delete-reason-${row.documentType}`} value={deleteReason} onChange={setDeleteReason} />
                <DocMessage state={deleteState} />
                <button type="submit" className="btn-primary" disabled={deletePending || used || !deleteReason.trim()}>
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
      {canMaintain && <CreatePanel rows={rows} intervals={intervals} />}
      <section className="panel overflow-hidden" aria-labelledby="doc-type-grid-title">
        <div className="panel-header">
          <h2 id="doc-type-grid-title" className="panel-title">{t('docType.gridTitle')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="grid-table min-w-[56.25rem]">
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

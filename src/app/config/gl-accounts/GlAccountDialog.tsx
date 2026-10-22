'use client';

import type { ReactNode } from 'react';
import { t } from '@/platform/i18n';
import type { GlAccountActionState } from './actions';

/**
 * Outcome of an FS00 write, shared by the field screen, the account list and the Account
 * Groups panel.
 *
 * A refusal carries its remedy beside it: the services explain what to do next, and a
 * message that only says "invalid" sends the user back to guess which of fifteen fields it
 * meant.
 */
export function GlAccountActionMessage({ state }: { state: GlAccountActionState }) {
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className={`mx-3 mt-3 border p-3 text-sm ${
        state.ok
          ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok'
          : 'border-signal-error/30 bg-signal-error-soft text-signal-error'
      }`}
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1">{state.remedy}</p>}
    </div>
  );
}

/**
 * One FS00 row dialog: a browser-controlled `<details>`, a full-screen panel, the outcome
 * of the last write, and the form that produced it.
 *
 * The `<details>` is left to the browser on purpose — a React-controlled `open` would let
 * a save or a refresh close the dialog before its outcome had been read. The message
 * renders inside the dialog, above the form, so a refusal is read where it happened rather
 * than at the top of a page the user has already scrolled past.
 */
export function GlAccountDialog({
  label,
  dialogLabel,
  codeLine,
  bodyText,
  state,
  formAction,
  pending,
  submitLabel,
  children,
  readOnly = false,
  onToggle,
  submitDisabled = false,
}: {
  /** Row link that opens the dialog. */
  label: string;
  dialogLabel: string;
  /** Optional transaction/subject line above the dialog title, e.g. `FS00 · CA01`. */
  codeLine?: string;
  /** The rule this change is measured against, shown before the form. */
  bodyText: string;
  state: GlAccountActionState;
  formAction: (formData: FormData) => void;
  pending: boolean;
  submitLabel: string;
  children: ReactNode;
  /**
   * Show the contents without offering the write. A user who may read a matrix should see
   * it as the maintainer sees it, with the controls disabled, rather than as a different
   * table that could drift from the form.
   */
  readOnly?: boolean;
  onToggle?: (open: boolean) => void;
  submitDisabled?: boolean;
}) {
  return (
    <details className="min-w-44" onToggle={(event) => onToggle?.(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9 sm:py-1">
        {label}
      </summary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        className="fixed inset-0 z-40 overflow-y-auto bg-[#f4f6f7] p-3 sm:p-6"
      >
        <div className="mx-auto max-w-2xl">
          <div className="mb-3 flex items-center justify-between gap-3 border border-line bg-white p-3">
            <div>
              {codeLine && <span className="code text-xs text-ink-faint">{codeLine}</span>}
              <p className="font-semibold">{dialogLabel}</p>
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
              <p className="text-sm text-ink-soft">{bodyText}</p>
            </div>
            {state.message && <GlAccountActionMessage state={state} />}
            <form action={formAction} className="space-y-4 p-3 sm:p-5">
              {children}
              {!readOnly && (
                <div className="flex justify-end border-t border-line pt-4">
                  <button
                    type="submit"
                    className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
                    disabled={pending || submitDisabled}
                  >
                    {pending ? t('common.saving') : submitLabel}
                  </button>
                </div>
              )}
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

/**
 * The reason field.
 *
 * Required by default, because the changes that carry it — a block, a deletion, a group
 * leaving the F4 — are the ones an auditor asks about. `required={false}` is for the
 * edits that merely owe an explanation if the user has one, where a forced note would be
 * filled with noise to get past the form.
 */
export function ReasonField({
  id,
  hint,
  pending,
  value,
  onChange,
  required = true,
}: {
  id: string;
  hint: string;
  pending: boolean;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {t('glAccount.reason')}
        {required && <span className="ms-1 text-signal-error" aria-hidden="true">*</span>}
      </label>
      <textarea
        id={id}
        name="reason"
        rows={3}
        required={required}
        minLength={required ? 1 : undefined}
        maxLength={500}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value.slice(0, 500))}
        className="field-input mt-1 min-h-20 w-full"
        disabled={pending}
      />
      <p className="mt-1 text-xs text-ink-faint">{hint}</p>
    </div>
  );
}

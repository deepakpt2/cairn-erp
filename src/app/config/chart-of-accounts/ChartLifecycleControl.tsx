'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import type { ChartOfAccountsActionState } from './actions';
import { ActionMessage } from './ChartOfAccountsForm';

type LifecycleAction = (
  previous: ChartOfAccountsActionState,
  form: FormData,
) => Promise<ChartOfAccountsActionState>;

/**
 * Deactivate / reactivate control shared by operational charts and Group CoA entries.
 *
 * The reason is mandatory: a lifecycle change without an explanation is not an audit
 * record. The panel is a plain browser-controlled `<details>` so a save/refresh cycle
 * can never close it before the user has read the outcome.
 */
export function ChartLifecycleControl({
  action,
  codeField,
  code,
  isActive,
  version,
  canMaintain,
  idPrefix,
}: {
  action: LifecycleAction;
  codeField: 'chartOfAccounts' | 'groupChartOfAccounts';
  code: string;
  isActive: boolean;
  version: number;
  canMaintain: boolean;
  idPrefix: string;
}) {
  const [state, formAction, pending] = useActionState<ChartOfAccountsActionState, FormData>(action, { ok: true });
  const [reason, setReason] = useState('');
  const dialogLabel = `${isActive ? t('chartOfAccounts.deactivate') : t('chartOfAccounts.reactivate')} ${code}`;
  const isGroupEntry = codeField === 'groupChartOfAccounts';
  const submitLabel = isActive
    ? t(isGroupEntry ? 'chartOfAccounts.groupDeactivateButton' : 'chartOfAccounts.deactivateButton')
    : t(isGroupEntry ? 'chartOfAccounts.groupReactivateButton' : 'chartOfAccounts.reactivateButton');

  if (!canMaintain) return null;

  return (
    <details className="min-w-44">
      <summary className="min-h-11 cursor-pointer select-none py-2 text-sm font-medium text-accent hover:underline sm:min-h-9">
        {isActive ? t('chartOfAccounts.deactivate') : t('chartOfAccounts.reactivate')}
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
              <span className="code text-xs text-ink-faint">OB13 · {code}</span>
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
              <h3 className="font-semibold">{t('chartOfAccounts.lifecycleRule')}</h3>
            </div>
            {state.message && <ActionMessage state={state} />}
            <form action={formAction} className="space-y-4 p-3 sm:p-5">
              <input type="hidden" name={codeField} value={code} />
              <input type="hidden" name="isActive" value={isActive ? 'false' : 'true'} />
              <input type="hidden" name="expectedVersion" value={version} />

              <div>
                <label htmlFor={`${idPrefix}-lifecycle-reason`} className="field-label">
                  {t('chartOfAccounts.lifecycleReason')} <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                </label>
                <textarea
                  id={`${idPrefix}-lifecycle-reason`}
                  name="reason"
                  required
                  minLength={1}
                  maxLength={500}
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.currentTarget.value.slice(0, 500))}
                  className="field-input mt-1 min-h-20 w-full"
                  disabled={pending}
                />
                <p className="mt-1 text-xs text-ink-faint">{t('chartOfAccounts.lifecycleReasonRule')}</p>
              </div>

              <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="max-w-xl text-xs text-ink-soft">
                  {isActive
                    ? t('chartOfAccounts.inactiveRetained')
                    : t('chartOfAccounts.lifecycleRule')}
                </p>
                <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto" disabled={pending}>
                  {pending ? t('common.saving') : submitLabel}
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </details>
  );
}

'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLockClaim } from '@/ui/lock/ChangeLock';
import { shouldDispatch } from '@/ui/lock/claim';
import {
  assignControllingAreaCompanyAction,
  unassignControllingAreaCompanyAction,
  type ControllingAreaCompanyAssignmentActionState,
} from './assign-company-code/actions';
import { ControllingAreaValueHelp, type ControllingAreaChoice } from './ControllingAreaValueHelp';

export interface ControllingAreaAssignmentRow {
  controllingArea: string;
  controllingAreaName: string | null;
  companyCodeScope: string | null;
  controllingAreaCurrency: string | null;
  controllingAreaFiscalYearVariant: string | null;
  controllingAreaIsActive: boolean | null;
  companyCode: string;
  companyCodeName: string | null;
  companyCodeCurrency: string | null;
  companyCodeChartOfAccounts: string | null;
  companyCodeFiscalYearVariant: string | null;
  companyCodeIsActive: boolean | null;
}

interface ControllingAreaCompanyAssignmentUIProps {
  controllingAreas: ControllingAreaChoice[];
  companyCodes: ControllingAreaChoice[];
  assignments: ControllingAreaAssignmentRow[];
  canMaintain: boolean;
}

type HelpField = 'controllingArea' | 'companyCode';

/**
 * SCR-025 / OX19 assignment screen. Tenant-local value help and current links are
 * connected to protected add/unassign actions; mutation authority is still checked
 * again at the server-action boundary.
 */
export function ControllingAreaCompanyAssignmentUI({
  controllingAreas,
  companyCodes,
  assignments,
  canMaintain,
}: ControllingAreaCompanyAssignmentUIProps) {
  const [assignmentState, assignAction, assignmentPending] = useActionState<ControllingAreaCompanyAssignmentActionState, FormData>(
    assignControllingAreaCompanyAction,
    { ok: true },
  );
  const [unassignmentState, unassignAction, unassignmentPending] = useActionState<ControllingAreaCompanyAssignmentActionState, FormData>(
    unassignControllingAreaCompanyAction,
    { ok: true },
  );
  const [controllingAreaValue, setControllingAreaValue] = useState('');
  const [companyCodeValue, setCompanyCodeValue] = useState('');

  useEffect(() => {
    if (assignmentState.ok && assignmentState.message) {
      setControllingAreaValue('');
      setCompanyCodeValue('');
    }
  }, [assignmentState]);

  return (
    <div className="space-y-4">
      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm" aria-labelledby="assign-company-code-form-title">
        <header className="border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4">
          <h2 id="assign-company-code-form-title" className="text-base font-semibold text-[#334f65]">
            {t('controllingArea.assignmentFormTitle')}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{t('controllingArea.assignmentFormHint')}</p>
        </header>

        {!canMaintain && (
          <p role="status" className="border-b border-[#d6dce1] bg-[#f7f9fa] px-3 py-3 text-sm text-ink-soft sm:px-4">
            {t('controllingArea.assignmentPermissionRequired')}
          </p>
        )}

        {assignmentState.message && (
          <div
            role={assignmentState.ok ? 'status' : 'alert'}
            className={`mx-3 mt-3 border p-3 text-sm ${assignmentState.ok
              ? 'border-[#a8c9b1] bg-[#f3faf4] text-[#285d37]'
              : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}
          >
            <p>{assignmentState.message}</p>
            {assignmentState.remedy && <p className="mt-1">{assignmentState.remedy}</p>}
          </div>
        )}

        <form action={assignAction} className="space-y-4 p-3 sm:p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ControllingAreaValueHelp
              id="assign-company-code-controlling-area"
              name="controllingArea"
              label={t('controllingArea.code')}
              value={controllingAreaValue}
              onChange={setControllingAreaValue}
              choices={controllingAreas}
              dialogTitle={t('controllingArea.assignmentAreaLookupTitle')}
              openLabel={t('controllingArea.assignmentOpenAreaLookup')}
              emptyText={t('controllingArea.assignmentNoAreasMatch')}
              rule={t('controllingArea.assignmentAreaRule')}
              maxLength={4}
              pattern="[A-Za-z0-9]{4}"
              disabled={!canMaintain || assignmentPending}
            />
            <ControllingAreaValueHelp
              id="assign-company-code-company-code"
              name="companyCode"
              label={t('cc.code')}
              value={companyCodeValue}
              onChange={setCompanyCodeValue}
              choices={companyCodes}
              dialogTitle={t('controllingArea.assignmentCompanyLookupTitle')}
              openLabel={t('controllingArea.assignmentOpenCompanyLookup')}
              emptyText={t('controllingArea.assignmentNoCompanyCodesMatch')}
              rule={t('controllingArea.assignmentCompanyRule')}
              maxLength={4}
              pattern="[A-Za-z0-9]{4}"
              disabled={!canMaintain || assignmentPending}
              normalizeUppercase={false}
            />
          </div>

          <p className="border-s-2 border-[#8faabd] bg-[#f7f9fa] px-3 py-2 text-xs text-[#435b6d]">
            {t('controllingArea.assignmentCompatibilityRule')}
          </p>

          <div className="flex flex-col gap-3 border-t border-[#d6dce1] pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-soft">{t('controllingArea.assignmentActionsPending')}</p>
            <button
              type="submit"
              className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto"
              disabled={!canMaintain || assignmentPending}
              aria-describedby="assign-company-code-actions-pending"
            >
              {assignmentPending ? t('common.saving') : t('controllingArea.assignmentAddButton')}
            </button>
          </div>
          <span id="assign-company-code-actions-pending" className="sr-only">
            {t('controllingArea.assignmentActionsPending')}
          </span>
        </form>
      </section>

      <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm" aria-labelledby="assign-company-code-current-assignments-title">
        <div className="flex items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4">
          <h2 id="assign-company-code-current-assignments-title" className="min-w-0 flex-1 text-sm font-semibold text-[#334f65]">
            {t('controllingArea.assignmentListTitle')}
          </h2>
          <span className="code text-xs tabular text-ink-faint">{assignments.length}</span>
        </div>

        {unassignmentState.message && (
          <div
            role={unassignmentState.ok ? 'status' : 'alert'}
            className={`border-b px-3 py-3 text-sm sm:px-4 ${unassignmentState.ok
              ? 'border-[#a8c9b1] bg-[#f3faf4] text-[#285d37]'
              : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}
          >
            <p>{unassignmentState.message}</p>
            {unassignmentState.remedy && <p className="mt-1">{unassignmentState.remedy}</p>}
          </div>
        )}

        {assignments.length === 0 ? (
          <p role="status" className="p-4 text-sm text-ink-soft">{t('controllingArea.assignmentListEmpty')}</p>
        ) : (
          <>
            <div className="divide-y divide-[#d6dce1] sm:hidden" role="list" aria-label={t('controllingArea.assignmentListTitle')}>
              {assignments.map((item) => (
                <article key={`${item.controllingArea}/${item.companyCode}`} role="listitem" className="space-y-3 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="code font-semibold">{item.controllingArea}</span>
                    {item.controllingAreaIsActive !== null && (
                      <span className={`chip ${item.controllingAreaIsActive ? 'chip-ok' : 'chip-neutral'}`}>
                        {t(item.controllingAreaIsActive ? 'controllingArea.active' : 'controllingArea.inactive')}
                      </span>
                    )}
                    <span className="chip chip-info">
                      {t(item.companyCodeScope === 'MULTIPLE' ? 'controllingArea.assignmentScopeMultiple' : 'controllingArea.assignmentScopeSingle')}
                    </span>
                  </div>
                  <p className="break-words text-sm text-[#263b4d]">{item.controllingAreaName || t('controllingArea.assignmentUnknownArea')}</p>
                  <div className="border-s-2 border-[#d6dce1] ps-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="code font-semibold">{item.companyCode}</span>
                      {item.companyCodeIsActive !== null && (
                        <span className={`chip ${item.companyCodeIsActive ? 'chip-ok' : 'chip-neutral'}`}>
                          {t(item.companyCodeIsActive ? 'controllingArea.active' : 'controllingArea.inactive')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 break-words text-sm text-[#263b4d]">{item.companyCodeName || t('controllingArea.assignmentUnknownCompanyCode')}</p>
                    <dl className="mt-2 grid grid-cols-1 gap-y-1 text-xs text-ink-soft">
                      <div className="flex flex-wrap gap-x-2">
                        <dt>{t('controllingArea.assignmentOperationalChart')}:</dt>
                        <dd className="code">{item.companyCodeChartOfAccounts || '—'}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt>{t('controllingArea.fiscalYearVariant')}:</dt>
                        <dd className="code">{item.companyCodeFiscalYearVariant || '—'} / {item.controllingAreaFiscalYearVariant || '—'}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt>{t('controllingArea.assignmentCurrency')}:</dt>
                        <dd className="code">{item.companyCodeCurrency || '—'} / {item.controllingAreaCurrency || '—'}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="flex justify-end border-t border-[#e1e5e8] pt-2">
                    <UnassignPair
                      controllingArea={item.controllingArea}
                      companyCode={item.companyCode}
                      action={unassignAction}
                      pending={unassignmentPending}
                      canMaintain={canMaintain}
                      buttonClass="btn btn-default min-h-11"
                    />
                  </div>
                </article>
              ))}
            </div>

            <div className="hidden overflow-x-auto sm:block">
              <table className="min-w-[57.5rem] w-full border-collapse text-sm" aria-label={t('controllingArea.assignmentListTitle')}>
                <thead className="bg-[#eef1f4] text-[#33414c]">
                  <tr className="border-y border-[#c4ccd2]">
                    <th className="w-36 border-r border-[#cbd1d6] px-3 py-2 text-left">{t('controllingArea.code')}</th>
                    <th className="w-44 px-3 py-2 text-left">{t('controllingArea.assignmentControl')}</th>
                    <th className="w-36 border-r border-[#cbd1d6] px-3 py-2 text-left">{t('cc.code')}</th>
                    <th className="min-w-48 px-3 py-2 text-left">{t('controllingArea.assignmentOperationalChart')}</th>
                    <th className="w-40 px-3 py-2 text-left">{t('controllingArea.fiscalYearVariant')}</th>
                    <th className="w-36 px-3 py-2 text-left">{t('controllingArea.assignmentCurrency')}</th>
                    <th className="w-32 px-3 py-2 text-right">{t('controllingArea.assignmentActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((item) => (
                    <tr key={`${item.controllingArea}/${item.companyCode}`} className="border-b border-[#d6dce1] hover:bg-[#f8fbfd]">
                      <td className="border-r border-[#e1e5e8] px-3 py-2">
                        <span className="code font-semibold">{item.controllingArea}</span>
                        <span className="mt-0.5 block text-xs text-ink-soft">{item.controllingAreaName || t('controllingArea.assignmentUnknownArea')}</span>
                      </td>
                      <td className="px-3 py-2">{t(item.companyCodeScope === 'MULTIPLE' ? 'controllingArea.assignmentScopeMultiple' : 'controllingArea.assignmentScopeSingle')}</td>
                      <td className="border-r border-[#e1e5e8] px-3 py-2">
                        <span className="code font-semibold">{item.companyCode}</span>
                        <span className="mt-0.5 block text-xs text-ink-soft">{item.companyCodeName || t('controllingArea.assignmentUnknownCompanyCode')}</span>
                      </td>
                      <td className="px-3 py-2 font-mono">{item.companyCodeChartOfAccounts || '—'}</td>
                      <td className="px-3 py-2 font-mono">{item.companyCodeFiscalYearVariant || '—'} / {item.controllingAreaFiscalYearVariant || '—'}</td>
                      <td className="px-3 py-2 font-mono">{item.companyCodeCurrency || '—'} / {item.controllingAreaCurrency || '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <UnassignPair
                          controllingArea={item.controllingArea}
                          companyCode={item.companyCode}
                          action={unassignAction}
                          pending={unassignmentPending}
                          canMaintain={canMaintain}
                          buttonClass="btn btn-default min-h-11 sm:min-h-9"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * The listed pair is the opened assignment. A new pair stays unlocked.
 *
 * The press that opens the claim must not also be the press that is refused. A row form has no field to
 * focus before its button, so focus and submit arrive in the same interaction: if the gate simply asked
 * for `CHANGE`, the operator's first press was discarded in silence, and Pass 33 fixed that by keeping
 * the press until the opening answered.
 *
 * Pass 34 is what the shared contract now makes explicit, in `src/ui/lock/claim`:
 *
 * - the press proceeds on its own only when the claim is `open` — a grant from the platform;
 * - while an answer is owed (`pending`, or nothing asked for yet) the press is kept and dispatched the
 *   moment the answer is a grant, through the action `useActionState` returned, so `pending` and the
 *   result message behave as they do for any other press;
 * - `refused` is a display-only opening belonging to another session: the press is dropped, the notice
 *   carries the platform's own sentence with its recovery guidance, and the control is refused;
 * - `failed` is neither a grant nor a refusal — the claim itself did not reach an answer. The kept press
 *   is dropped, the platform's failure text is shown as an alert, and nothing is ever replayed. The
 *   operator's next press is the retry: it asks for the opening again and is honoured only if that
 *   claim is genuinely granted;
 * - a superseded row (the pair changed, the row left the screen) cannot land an answer or a dispatch at
 *   all, because both are scoped to the claim key the effect owns.
 *
 * The server boundary is untouched and is the real one: the action still re-checks the same session lock
 * and both capabilities before it writes anything.
 */
function UnassignPair({
  controllingArea,
  companyCode,
  action,
  pending,
  canMaintain,
  buttonClass,
}: {
  controllingArea: string;
  companyCode: string;
  action: (form: FormData) => void;
  pending: boolean;
  canMaintain: boolean;
  buttonClass: string;
}) {
  // Read for its FormData when a press kept for the opening is finally dispatched.
  const formRef = useRef<HTMLFormElement>(null);
  const [engaged, setEngaged] = useState(false);
  const { claim, notice, reportPress, dispatched } = useChangeLockClaim(
    'CONTROLLING_AREA_COMPANY',
    `${controllingArea}/${companyCode}`,
    'CFG.COST.CONTROLLINGAREA.DEFINE',
    // The row is opened by the interaction that needs the answer, and stays open while the claim holds
    // it. The queue is deliberately not part of this condition: a press cannot widen what is opened,
    // because the queue lives inside the claim the condition would be deciding — and a press never
    // arrives without engaging the row anyway, since the same handler sets both.
    engaged && canMaintain,
  );
  const refused = claim.phase === 'refused';

  useEffect(() => {
    // `shouldDispatch` is the shared rule: an owed press, and a grant to spend it on. Nothing else
    // reaches the action — not a refusal, not a failure, not an answer for another row.
    if (!shouldDispatch(claim)) return;
    dispatched();
    const form = formRef.current;
    if (form) action(new FormData(form));
  }, [claim, dispatched, action]);

  return (
    <form
      ref={formRef}
      action={action}
      onFocus={() => setEngaged(true)}
      onSubmit={(event) => {
        if (claim.phase === 'open') return;
        event.preventDefault();
        setEngaged(true);
        reportPress();
      }}
    >
      <input type="hidden" name="controllingArea" value={controllingArea} />
      <input type="hidden" name="companyCode" value={companyCode} />
      <LockNotice message={refused ? notice.message : null} remedy={refused ? notice.remedy : null} />
      {claim.phase === 'failed' && (
        <p role="alert" className="border border-signal-error/30 bg-signal-error-soft p-2 text-xs text-signal-error">
          {t('common.error')}: {notice.message}
        </p>
      )}
      <button
        type="submit"
        className={buttonClass}
        // Two refusals and only two: no maintenance capability, and an opening the platform gave to
        // somebody else. A claim still in flight, and a failed one, both keep the control pressable —
        // the first so the press can be queued, the second so the next press is the retry.
        disabled={!canMaintain || pending || refused}
      >
        {pending ? t('common.saving') : t('controllingArea.assignmentUnassignButton')}
      </button>
    </form>
  );
}

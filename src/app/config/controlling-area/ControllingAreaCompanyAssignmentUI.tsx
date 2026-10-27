'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
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
 * The press that opens the claim must not also be the press that is refused. `useChangeLock` has
 * nothing to report until its action answers, and a row form has no field to focus before the
 * button — so focus and submit arrive in the same interaction, the claim is still in flight when
 * the gate asks for `CHANGE`, and the operator's first press used to be discarded in silence: the
 * button stayed enabled, no notice appeared, and only a second press submitted.
 *
 * The gate itself is unchanged and stays strict: nothing submits unless this session holds the
 * change lock, and `unassignControllingAreaCompanyAction` re-checks that same lock on the server.
 * What changes is that the press is kept rather than thrown away — it claims the opening, and the
 * unassignment is dispatched the moment that opening answers with change. An opening that answers
 * display-only drops the press and lets the notice speak, the same sentence every other lock screen
 * gives, and its button stays refused exactly as it was.
 *
 * The control is deliberately NOT disabled while the claim is in flight, which is the one
 * temptation this round already fell for once: a press that lands between the mousedown that focuses
 * the button and the mouseup would then never reach `click` at all, and the row would swallow the
 * operator's press in a new and quieter way. It is the queue that makes the press safe to accept
 * early, not a disabled button.
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
  // Read for its FormData when a press held for the opening is finally dispatched.
  const formRef = useRef<HTMLFormElement>(null);
  const [engaged, setEngaged] = useState(false);
  const [queued, setQueued] = useState(false);
  const lock = useChangeLock(
    'CONTROLLING_AREA_COMPANY',
    `${controllingArea}/${companyCode}`,
    'CFG.COST.CONTROLLINGAREA.DEFINE',
    // A queued press may only ever widen what is already opened: the claim itself is not restarted,
    // so no press releases and re-acquires the lock the row already holds.
    (engaged || queued) && canMaintain,
  );
  const held = lock?.mode === 'CHANGE';

  useEffect(() => {
    // Hold the press until the opening answers. `lock` is null both while the claim is in flight and
    // while the row is not opened at all, so the queue — not a timer — is what says an answer is owed.
    if (!queued || !lock) return;
    setQueued(false);
    // Grant it and the press runs; refuse it and the notice below is what the operator reads
    // instead of a silent form. Either way the press is answered, never discarded.
    //
    // The press is handed to the action `useActionState` returned, with this form's own FormData,
    // rather than replayed through the form element: replaying it by submitting the form measured
    // one request on the wire — the claim — no mutation, and no message, because a submit that
    // arrives from an effect never carries the user gesture the form's own action path expects.
    // Dispatching the action is the same call React makes for the press, so the pending flag and
    // the result message behave exactly as they do when the operator presses an already-open row.
    const form = formRef.current;
    if (held && form) action(new FormData(form));
  }, [queued, held, lock, action]);

  return (
    <form
      ref={formRef}
      action={action}
      onFocus={() => setEngaged(true)}
      onSubmit={(event) => {
        if (held) return;
        event.preventDefault();
        setEngaged(true);
        if (!lock) setQueued(true);
      }}
    >
      <input type="hidden" name="controllingArea" value={controllingArea} />
      <input type="hidden" name="companyCode" value={companyCode} />
      <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} remedy={lock?.remedy} />
      <button
        type="submit"
        className={buttonClass}
        // Refused pressings are exactly the two that were refused before: no maintenance
        // capability, and an opening that came back display-only. A claim in flight keeps the
        // control pressable so the press can be queued instead of lost.
        disabled={!canMaintain || pending || lock?.mode === 'DISPLAY'}
      >
        {pending ? t('common.saving') : t('controllingArea.assignmentUnassignButton')}
      </button>
    </form>
  );
}

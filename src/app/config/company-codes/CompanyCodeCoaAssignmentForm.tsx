'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import { assignCompanyCodeCoaAction, type CompanyCodeCoaAssignmentState } from './actions';

export interface ChartOfAccountsChoice {
  code: string;
  name: string;
}

const INITIAL: CompanyCodeCoaAssignmentState = { ok: true };

/** Initial assignment only. The server action independently verifies authority and prerequisites. */
export function CompanyCodeCoaAssignmentForm({
  companyCode,
  charts,
}: {
  companyCode: string;
  charts: ChartOfAccountsChoice[];
}) {
  const [state, action, pending] = useActionState(assignCompanyCodeCoaAction, INITIAL);
  const [chosen, setChosen] = useState(false);
  const lock = useChangeLock('COMPANY_CODE', companyCode.trim(), 'CFG.ORG.COMPANYCODE.ASSIGN_COA', chosen);
  const held = lock?.mode === 'CHANGE';

  return (
    <div className="min-w-72 space-y-2">
      <LockNotice message={lock?.mode === 'DISPLAY' ? lock.message : null} />
      <form action={action} className="flex items-end gap-2">
        <input type="hidden" name="companyCode" value={companyCode} />
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t('cc.chartForCompany', { code: companyCode })}</span>
          <select
            name="chartOfAccounts"
            required
            defaultValue=""
            className="field-input code"
            disabled={pending || charts.length === 0}
            onChange={(event) => setChosen(Boolean(event.target.value))}
          >
            <option value="">{t('cc.chooseChart')}</option>
            {charts.map((chart) => (
              <option key={chart.code} value={chart.code}>
                {chart.code} · {chart.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" disabled={pending || charts.length === 0 || !held}>
          {pending ? t('common.saving') : t('cc.assign')}
        </button>
      </form>

      {state.message && (
        <div
          role="status"
          className={`border p-2 text-xs ${
            state.ok
              ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok'
              : 'border-signal-error/30 bg-signal-error-soft text-signal-error'
          }`}
        >
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1">{state.remedy}</p>}
        </div>
      )}
    </div>
  );
}

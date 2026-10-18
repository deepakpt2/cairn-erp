'use client';

import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import { assignCoaAction, type CoaAssignmentActionState } from './actions';

export interface CoaAssignableCompany {
  code: string;
  name: string;
  chartOfAccounts: string | null;
}

export interface CoaChartChoice {
  code: string;
  name: string;
}

const INITIAL: CoaAssignmentActionState = { ok: true };

/**
 * Dedicated chart-of-accounts assignment (SCR-013 act, own screen).
 * The server action independently verifies authority; the form submits
 * only the company, the chart and the mandatory reason.
 */
export function CoaAssignmentForm({
  companies,
  charts,
}: {
  companies: CoaAssignableCompany[];
  charts: CoaChartChoice[];
}) {
  const [state, action, pending] = useActionState(assignCoaAction, INITIAL);
  const unassigned = companies.filter((c) => !c.chartOfAccounts);

  return (
    <div className="space-y-4">
      <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">
            {t('coaAssign.company')}
          </span>
          <select name="companyCode" required defaultValue="" className="field-input code w-full" disabled={pending}>
            <option value="">{t('coaAssign.chooseCompany')}</option>
            {companies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.name}
                {c.chartOfAccounts ? ` · ${c.chartOfAccounts}` : ` · ${t('cc.unassigned')}`}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">
            {t('coaAssign.chart')}
          </span>
          <select name="chartOfAccounts" required defaultValue="" className="field-input code w-full" disabled={pending || charts.length === 0}>
            <option value="">{t('cc.chooseChart')}</option>
            {charts.map((chart) => (
              <option key={chart.code} value={chart.code}>
                {chart.code} · {chart.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">
            {t('coaAssign.reason')}
          </span>
          <input name="reason" required maxLength={500} className="field-input w-full" disabled={pending} />
        </label>
        <div className="flex items-end">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending || charts.length === 0}>
            {pending ? t('common.saving') : t('cc.assign')}
          </button>
        </div>
      </form>

      {state.message && (
        <div
          role="status"
          className={`border p-3 text-sm ${
            state.ok
              ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok'
              : 'border-signal-error/30 bg-signal-error-soft text-signal-error'
          }`}
        >
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1">{state.remedy}</p>}
        </div>
      )}

      <p className="text-sm text-ink-soft">
        {unassigned.length > 0
          ? t('coaAssign.unassignedCount', { count: String(unassigned.length) })
          : t('coaAssign.allAssigned')}
      </p>
    </div>
  );
}

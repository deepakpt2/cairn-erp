'use client';

import { useActionState } from 'react';
import { t } from '@/platform/i18n';
import {
  assignPlantCompanyCodeAction,
  type PlantCompanyCodeAssignmentState,
} from './actions';

export interface PlantCompanyCodeChoice {
  code: string;
  name: string;
}

const INITIAL: PlantCompanyCodeAssignmentState = { ok: true };

/** Initial assignment only; the server action independently checks authority and current state. */
export function PlantCompanyCodeAssignmentForm({
  plant,
  companyCodes,
}: {
  plant: string;
  companyCodes: PlantCompanyCodeChoice[];
}) {
  const [state, action, pending] = useActionState(assignPlantCompanyCodeAction, INITIAL);

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="plant" value={plant} />
        <label className="min-w-64 flex-1">
          <span className="field-label">{t('plant.companyCodeForPlant', { code: plant })}</span>
          <select
            name="companyCode"
            required
            defaultValue=""
            className="field-input code"
            disabled={pending || companyCodes.length === 0}
          >
            <option value="">{t('plant.chooseCompanyCode')}</option>
            {companyCodes.map((company) => (
              <option key={company.code} value={company.code}>
                {company.code} · {company.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" disabled={pending || companyCodes.length === 0}>
          {pending ? t('common.saving') : t('plant.assignCompanyCode')}
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

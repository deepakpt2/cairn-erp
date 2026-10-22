'use client';

import { useActionState, useEffect, useState } from 'react';

import { t } from '@/platform/i18n';
import type { EvaluationCriterion } from '@/modules/purchasing/vendor-evaluation';
import { saveManualScoreAction, type VendorEvaluationActionState } from './actions';

const INITIAL: VendorEvaluationActionState = { ok: false, message: '' };

function newRequestKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function ManualScoreForm({
  supplier,
  purchasingOrg,
  periodFrom,
  periodTo,
  criterion,
  requestKey: initialKey,
}: {
  supplier: string;
  purchasingOrg: string;
  periodFrom: string;
  periodTo: string;
  criterion: EvaluationCriterion;
  requestKey: string;
}) {
  const [state, action, pending] = useActionState(saveManualScoreAction, INITIAL);
  const [requestKey, setRequestKey] = useState(initialKey);
  const [version, setVersion] = useState(criterion.version == null ? '' : String(criterion.version));

  useEffect(() => {
    if (!state.ok || !state.wrote || state.version == null) return;
    setVersion(String(state.version));
    setRequestKey(newRequestKey());
  }, [state]);

  return (
    <form action={action} className="mt-3 space-y-3 border-t border-line pt-3" data-ve-save={criterion.criterionCode}>
      <input type="hidden" name="supplier" value={supplier} />
      <input type="hidden" name="purchasingOrg" value={purchasingOrg} />
      <input type="hidden" name="periodFrom" value={periodFrom} />
      <input type="hidden" name="periodTo" value={periodTo} />
      <input type="hidden" name="criterionCode" value={criterion.criterionCode} />
      <input type="hidden" name="requestKey" value={requestKey} />
      <input type="hidden" name="expectedVersion" value={version} />
      <p className="text-sm font-semibold">{criterion.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block min-w-32 flex-1 text-sm">
          <span className="mb-1 block text-ink-soft">{t('vendorEvaluation.score')}</span>
          <input id={`ve-score-${criterion.criterionCode}`} name="score" className="input w-full" required defaultValue={criterion.score ?? ''} maxLength={6} />
        </label>
        <label className="block min-w-48 flex-1 text-sm">
          <span className="mb-1 block text-ink-soft">{t('vendorEvaluation.reason')}</span>
          <input id={`ve-reason-${criterion.criterionCode}`} name="reason" className="input w-full" required defaultValue={criterion.reason ?? ''} maxLength={100} />
        </label>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending} data-ve-save-button={criterion.criterionCode}>
          {t('vendorEvaluation.save')}
        </button>
      </div>
      {state.message && (
        <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-sm' : 'text-sm text-red-700'} data-ve-save-result={criterion.criterionCode}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
    </form>
  );
}

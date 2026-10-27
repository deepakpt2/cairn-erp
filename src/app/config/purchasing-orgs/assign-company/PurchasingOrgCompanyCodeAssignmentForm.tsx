'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import {
  assignPurchasingOrgCompanyCodeAction,
  type PurchasingOrgCompanyCodeAssignmentState,
} from './actions';

interface CompanyCodeChoice {
  code: string;
  name: string;
}

export function PurchasingOrgCompanyCodeAssignmentForm({
  purchasingOrg,
  companyCodes,
}: {
  purchasingOrg: string;
  companyCodes: CompanyCodeChoice[];
}) {
  const [state, action, pending] = useActionState<PurchasingOrgCompanyCodeAssignmentState, FormData>(
    assignPurchasingOrgCompanyCodeAction,
    { ok: true },
  );
  const [engaged, setEngaged] = useState(false);
  const orgLock = useChangeLock('PURCHASING_ORG_COMPANY', purchasingOrg, 'CFG.PROC.PURORG.ASSIGN_COMPANY', engaged);

  if (state.ok && state.message) {
    return (
      <div className="space-y-2">
        <p role="status" className="text-sm text-signal-ok">{state.message}</p>
        <Link
          className="text-sm text-accent underline"
          href={`/config/purchasing-orgs?purchasingOrg=${encodeURIComponent(state.purchasingOrg ?? purchasingOrg)}`}
        >
          {t('purchasingOrg.open')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {state.message && (
        <div role="alert" className="border border-signal-error/30 bg-signal-error-soft p-2 text-xs text-signal-error">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1">{state.remedy}</p>}
        </div>
      )}
      <form
        action={action}
        className="flex flex-wrap items-end gap-2"
        onFocus={() => setEngaged(true)}
        onSubmit={(event) => {
          if (orgLock?.mode !== 'CHANGE') event.preventDefault();
        }}
      >
        <input type="hidden" name="purchasingOrg" value={purchasingOrg} />
        <label className="min-w-64 flex-1">
          <span className="sr-only">{t('purchasingOrg.companyCodeForOrg', { code: purchasingOrg })}</span>
          <select
            name="companyCode"
            required
            defaultValue=""
            className="field-input code"
            disabled={pending || companyCodes.length === 0}
          >
            <option value="">{t('purchasingOrg.chooseCompanyCode')}</option>
            {companyCodes.map((company) => (
              <option key={company.code} value={company.code}>
                {company.code} · {company.name}
              </option>
            ))}
          </select>
        </label>
        <LockNotice message={orgLock?.mode === 'DISPLAY' ? orgLock.message : null} remedy={orgLock?.remedy} />
        <button className="btn btn-primary" disabled={pending || companyCodes.length === 0 || orgLock?.mode === 'DISPLAY'}>
          {pending ? t('common.saving') : t('purchasingOrg.assignCompanyCode')}
        </button>
      </form>
    </div>
  );
}

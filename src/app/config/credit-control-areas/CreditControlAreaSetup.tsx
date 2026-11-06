'use client';

import { useActionState, useState } from 'react';

import { ClaimFailureNotice, LockNotice, useChangeLockClaim } from '@/ui/lock/ChangeLock';
import {
  CREDIT_CONTROL_AREA_ACTIVITY,
  CREDIT_CONTROL_AREA_LOCKS,
} from '@/modules/finance/credit-control-area-contract';
import { createCreditControlAreaAction, type CreditControlAreaActionState } from './actions';

const INITIAL_ACTION_STATE: CreditControlAreaActionState = { ok: false, message: '' };

type CompanyChoice = { companyCode: string; name: string; currency: string };
type Defaults = { creditControlArea: string; name: string; warningThresholdPercent: number };

export function CreditControlAreaSetup({ companies, defaults }: { companies: CompanyChoice[]; defaults: Defaults }) {
  const [state, action, pending] = useActionState(createCreditControlAreaAction, INITIAL_ACTION_STATE);
  const [areaCode, setAreaCode] = useState(defaults.creditControlArea);
  const [companyCode, setCompanyCode] = useState(companies[0]?.companyCode ?? '');
  const [name, setName] = useState(defaults.name);

  const normalizedArea = areaCode.trim().toUpperCase();
  const normalizedCompany = companyCode.trim().toUpperCase();
  const areaClaim = useChangeLockClaim(
    CREDIT_CONTROL_AREA_LOCKS.area,
    normalizedArea || null,
    CREDIT_CONTROL_AREA_ACTIVITY,
    Boolean(normalizedArea),
  );
  const companyClaim = useChangeLockClaim(
    CREDIT_CONTROL_AREA_LOCKS.company,
    normalizedCompany || null,
    CREDIT_CONTROL_AREA_ACTIVITY,
    Boolean(normalizedCompany),
  );
  const locksOpen = areaClaim.claim.phase === 'open' && companyClaim.claim.phase === 'open';
  const selectedCompany = companies.find((company) => company.companyCode === companyCode);

  if (companies.length === 0) {
    return (
      <section className="border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Initial setup</h2>
        <p className="mt-2 text-sm text-ink-soft">There are no active, unassigned Company Codes to configure.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="cca-setup" className="border border-line bg-surface p-4">
      <h2 id="cca-setup" className="text-sm font-semibold">Create and initially assign</h2>
      <p className="mt-1 text-sm text-ink-soft">
        This is an initial setup only. The area is created active; its currency is taken from the selected Company Code.
        Existing area settings and company assignments cannot be edited here.
      </p>

      {state.message && (
        <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}

      <form action={action} className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Credit control area</span>
          <input
            name="creditControlArea"
            required
            maxLength={4}
            pattern="[A-Za-z0-9]{4}"
            value={areaCode}
            onChange={(event) => setAreaCode(event.target.value.toUpperCase())}
            className="field w-full font-mono"
            aria-describedby="cca-code-help"
          />
          <span id="cca-code-help" className="mt-1 block text-xs text-ink-faint">Four letters or digits.</span>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">Company Code</span>
          <select
            name="companyCode"
            required
            value={companyCode}
            onChange={(event) => setCompanyCode(event.target.value)}
            className="field w-full"
          >
            {companies.map((company) => (
              <option key={company.companyCode} value={company.companyCode}>
                {company.companyCode} · {company.name} · {company.currency}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm md:col-span-2">
          <span className="mb-1 block font-medium">Name</span>
          <input
            name="name"
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="field w-full"
          />
        </label>

        <div className="rounded border border-line bg-canvas p-3 text-sm">
          <span className="block font-medium">Currency</span>
          <span className="mt-1 block font-mono">{selectedCompany?.currency ?? '—'}</span>
          <span className="mt-1 block text-xs text-ink-faint">Derived from Company Code; it cannot be overridden.</span>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">Warning threshold</span>
          <span className="flex items-center gap-2">
            <input
              name="warningThresholdPercent"
              required
              type="number"
              min={0}
              max={100}
              step={1}
              defaultValue={defaults.warningThresholdPercent}
              className="field w-28"
            />
            <span>% of the credit limit</span>
          </span>
        </label>

        <label className="block text-sm md:col-span-2">
          <span className="mb-1 block font-medium">Reason for setup</span>
          <textarea name="reason" required minLength={3} maxLength={500} rows={2} className="field w-full" />
        </label>

        <div className="space-y-2 md:col-span-2">
          <LockNotice message={areaClaim.notice.message} remedy={areaClaim.notice.remedy} />
          <ClaimFailureNotice claim={areaClaim.claim} onRetry={areaClaim.retry} />
          <LockNotice message={companyClaim.notice.message} remedy={companyClaim.notice.remedy} />
          <ClaimFailureNotice claim={companyClaim.claim} onRetry={companyClaim.retry} />
          {(!locksOpen && areaClaim.claim.phase !== 'refused' && companyClaim.claim.phase !== 'refused'
            && areaClaim.claim.phase !== 'failed' && companyClaim.claim.phase !== 'failed') && (
            <p role="status" className="text-xs text-ink-faint">Waiting for change locks on the area and Company Code…</p>
          )}
        </div>

        <div className="md:col-span-2">
          <button type="submit" disabled={pending || !locksOpen} className="btn btn-primary min-h-11 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-8">
            {pending ? 'Saving…' : 'Create and assign'}
          </button>
          {!locksOpen && <span className="ml-3 text-xs text-ink-faint">Both change locks must be held before saving.</span>}
        </div>
      </form>
    </section>
  );
}

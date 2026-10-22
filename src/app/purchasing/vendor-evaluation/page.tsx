import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import type { ReactNode } from 'react';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { ConstrainedField } from '@/ui/fields/ConstrainedField';
import {
  VENDOR_EVALUATION_CAPABILITY,
  VENDOR_EVALUATION_ROUTE,
  VendorEvaluationError,
  checkVendorEvaluation,
  type VendorEvaluation,
} from '@/modules/purchasing/vendor-evaluation';
import { ManualScoreForm } from './ManualScoreForm';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[value.length - 1]?.trim() ?? '';
  return value?.trim() ?? '';
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-40 flex-1 text-sm">
      <span className="mb-1 block text-ink-soft">{label}</span>
      {children}
    </label>
  );
}

function EvaluationView({ evaluation }: { evaluation: VendorEvaluation }) {
  return (
    <section aria-labelledby="ve-result" className="space-y-4" data-ve-evaluation>
      <div className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ve-result" className="text-sm font-semibold" data-ve-supplier>
          {evaluation.supplierNumber}{evaluation.supplierName ? ` · ${evaluation.supplierName}` : ''}
        </h2>
        <p className="mt-1 text-sm" data-ve-scope>
          {evaluation.purchasingOrg} · {evaluation.periodFrom} – {evaluation.periodTo}
        </p>
        <p className="mt-1 text-xs text-ink-soft" data-ve-nothing-written>{t('vendorEvaluation.nothingWritten')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-ve-no-period>{t('vendorEvaluation.noPeriod')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-ve-as-of>{t('vendorEvaluation.asOf')} {evaluation.asOfDate}</p>
        <p className="mt-1 text-xs text-ink-soft" data-ve-not-stored>{t('vendorEvaluation.notStored')}</p>
        <p className="mt-1 text-xs text-ink-soft" data-ve-missing-rule>{t('vendorEvaluation.missing')}</p>
        <p className="mt-2 text-sm" data-ve-message>{evaluation.message}</p>
        <p className="mt-1 text-sm" data-ve-coverage>
          {t('vendorEvaluation.coverage')} {evaluation.scored} / {evaluation.applicable}
        </p>
        <p className="mt-1 text-sm" data-ve-overall>
          {t('vendorEvaluation.overall')} {evaluation.overallScore ?? '—'}
        </p>
        {evaluation.blocked && (
          <p className="mt-2 text-sm text-red-700" role="status" data-ve-blocked>{t('vendorEvaluation.blocked')}</p>
        )}
      </div>

      <div className="rounded-card border border-line bg-surface p-4 shadow-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-ink-soft">
              <th className="py-1 pr-3">{t('vendorEvaluation.criterion')}</th>
              <th className="py-1 pr-3">{t('vendorEvaluation.method')}</th>
              <th className="py-1 pr-3">{t('vendorEvaluation.weight')}</th>
              <th className="py-1 pr-3">{t('vendorEvaluation.score')}</th>
              <th className="py-1">{t('vendorEvaluation.evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {evaluation.criteria.map((row) => (
              <tr key={row.criterionCode} data-ve-criterion={row.criterionCode}>
                <td className="py-2 pr-3">{row.criterionCode} · {row.description}</td>
                <td className="py-2 pr-3" data-ve-method={row.criterionCode}>{row.method === 'AUTOMATIC' ? t('vendorEvaluation.automatic') : t('vendorEvaluation.manual')}</td>
                <td className="py-2 pr-3">{row.weight}</td>
                <td className="py-2 pr-3" data-ve-score={row.criterionCode}>{row.score ?? '—'}</td>
                <td className="py-2" data-ve-evidence={row.criterionCode}>{row.evidenceNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {evaluation.criteria.filter((row) => row.method === 'AUTOMATIC').map((row) => (
          <p key={row.criterionCode} className="mt-2 text-xs text-ink-soft" data-ve-no-save={row.criterionCode}>{t('vendorEvaluation.noSave')}</p>
        ))}
        {!evaluation.blocked && evaluation.criteria.filter((row) => row.method === 'MANUAL').map((row) => (
          <ManualScoreForm
            key={`${row.criterionCode}-${row.version ?? 0}`}
            supplier={evaluation.supplierNumber}
            purchasingOrg={evaluation.purchasingOrg}
            periodFrom={evaluation.periodFrom}
            periodTo={evaluation.periodTo}
            criterion={row}
            requestKey={randomUUID()}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Maintain vendor evaluation — SCR-165.
 *
 * The key is the supplier, the purchasing organisation, and the period.
 * Check is a read. A manual score is the only write. The alias stays in the catalogue.
 */
export default async function VendorEvaluationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(VENDOR_EVALUATION_ROUTE);
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const text = last(value);
    if (text) params[name] = text;
  }
  const canEvaluate = can(session, VENDOR_EVALUATION_CAPABILITY);
  let evaluation: VendorEvaluation | null = null;
  let refusal = '';
  if (canEvaluate && Object.keys(params).length > 0) {
    try {
      evaluation = await checkVendorEvaluation(session.user.client, params);
    } catch (error) {
      refusal = error instanceof VendorEvaluationError
        ? `${error.message}${error.remedy ? ` ${error.remedy}` : ''}`
        : t('vendorEvaluation.title');
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('vendorEvaluation.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('vendorEvaluation.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('vendorEvaluation.subtitle')}</p>
      </header>

      {!canEvaluate && <p className="text-sm text-red-700" role="alert">{t('vendorEvaluation.capabilityMissing')}</p>}

      <section aria-labelledby="ve-selection" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="ve-selection" className="text-sm font-semibold">{t('vendorEvaluation.selection')}</h2>
        <p className="mt-1 text-xs text-ink-soft" data-ve-read-only>{t('vendorEvaluation.readOnly')}</p>
        <form method="get" action={VENDOR_EVALUATION_ROUTE} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('vendorEvaluation.supplier')}>
              <ConstrainedField id="ve-supplier" kind="supplier-purchasing" name="supplier" uppercase defaultValue={params.supplier ?? ''} />
            </Field>
            <Field label={t('vendorEvaluation.purchasingOrg')}>
              <ConstrainedField id="ve-org" kind="purchasing-org" name="purchasingOrg" defaultValue={params.purchasingOrg ?? ''} />
            </Field>
            <Field label={t('vendorEvaluation.periodFrom')}>
              <input id="ve-from" name="periodFrom" type="date" className="input w-full" defaultValue={params.periodFrom ?? ''} />
            </Field>
            <Field label={t('vendorEvaluation.periodTo')}>
              <input id="ve-to" name="periodTo" type="date" className="input w-full" defaultValue={params.periodTo ?? ''} />
            </Field>
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" data-ve-check>{t('vendorEvaluation.check')}</button>
          </div>
        </form>
        {refusal && <p className="mt-3 text-sm text-red-700" role="alert" data-ve-refused>{refusal}</p>}
      </section>

      {evaluation && <EvaluationView evaluation={evaluation} />}
    </div>
  );
}

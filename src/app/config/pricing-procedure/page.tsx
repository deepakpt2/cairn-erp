import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  PRICING_DEFINE_CAPABILITY,
  listPricingConfiguration,
} from '@/modules/sales/pricing-procedure-maintenance';
import { PricingProcedureSetup } from './PricingProcedureSetup';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/pricing-procedure';

export default async function PricingProcedurePage() {
  const session = await requireSession(ROUTE);
  const configuration = await listPricingConfiguration(session.user.client);
  const canMaintain = can(session, PRICING_DEFINE_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{PRICING_DEFINE_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Pricing procedures</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          How a sales document is priced: the condition types a figure can carry, the ordered steps of the
          procedure that calculates them, and the determination that decides which procedure answers for a
          sales area, a document type and a customer. Every order and every invoice is priced by this
          configuration and by nothing else — a document is never priced by a procedure it found lying
          around, and where no determination stands it is not priced at all.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for {PRICING_DEFINE_CAPABILITY};
            broad wildcard role patterns do not grant it.
          </p>
        )}
      </header>

      <section aria-labelledby="pricing-types" className="border border-line bg-surface p-4">
        <h2 id="pricing-types" className="text-sm font-semibold">Condition types as configured</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="grid-table text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th>Type</th>
                <th>Name</th>
                <th>Class</th>
                <th>Calculated as</th>
                <th>Sign</th>
                <th>Statistical</th>
                <th>Account key</th>
                <th>Records</th>
                <th>Steps</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {configuration.types.map((type) => (
                <tr key={type.conditionType}>
                  <td className="font-mono">{type.conditionType}</td>
                  <td>{type.name}</td>
                  <td className="font-mono">{type.conditionClass}</td>
                  <td className="font-mono">{type.calculationType}</td>
                  <td>{type.isNegative ? 'Takes away' : 'Adds'}</td>
                  <td>{type.isStatistical ? 'Yes' : '—'}</td>
                  <td className="font-mono">{type.accountKey ?? '—'}</td>
                  <td>{type.recordsStanding}</td>
                  <td>{type.stepsStanding}</td>
                  <td>{type.isActive ? 'Offered' : 'Withdrawn'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {configuration.types.length === 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            No condition types stand for this tenant, so no procedure can be built and no document can be
            priced.
          </p>
        )}
      </section>

      <section aria-labelledby="pricing-procedures" className="border border-line bg-surface p-4">
        <h2 id="pricing-procedures" className="text-sm font-semibold">Procedures as configured</h2>
        <div className="mt-3 space-y-4">
          {configuration.procedures.map((procedure) => (
            <div key={procedure.procedureCode} className="border border-line">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
                <h3 className="font-mono text-sm">
                  {procedure.procedureCode} — {procedure.name}
                </h3>
                <span className="text-xs text-ink-faint">
                  {procedure.steps.filter((step) => step.isActive).length} step(s) ·{' '}
                  {procedure.documentsStanding} document(s) priced ·{' '}
                  {procedure.isActive ? 'Offered' : 'Withdrawn'}
                </span>
              </div>
              {procedure.steps.length === 0 ? (
                <p className="px-3 py-2 text-sm text-ink-soft">
                  No steps stand, so this procedure prices nothing.
                </p>
              ) : (
                <table className="grid-table text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th>Step</th>
                      <th>Condition</th>
                      <th>What it is</th>
                      <th>Calculated on</th>
                      <th>Level</th>
                      <th>Required</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {procedure.steps.map((step) => (
                      <tr key={step.stepNumber}>
                        <td className="font-mono">{step.stepNumber}</td>
                        <td className="font-mono">{step.conditionType}</td>
                        <td>{step.conditionTypeName}</td>
                        <td className="font-mono">
                          {step.fromStep === null ? '—' : `steps ${step.fromStep}–${step.toStep}`}
                        </td>
                        <td className="font-mono">{step.conditionLevel}</td>
                        <td>{step.isRequired ? 'Yes' : 'May go without'}</td>
                        <td>{step.isActive ? 'Executed' : 'Withdrawn'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
        {configuration.procedures.length === 0 && (
          <p className="mt-2 text-sm text-ink-soft">No pricing procedures stand for this tenant.</p>
        )}
      </section>

      <section aria-labelledby="pricing-determination" className="border border-line bg-surface p-4">
        <h2 id="pricing-determination" className="text-sm font-semibold">Which procedure answers</h2>
        {configuration.determinations.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No determination stands, so no sales document can be priced: a document priced by a procedure
            nobody named is not priced by a rule at all.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Sales area</th>
                  <th>Document</th>
                  <th>Customer</th>
                  <th>Prices by</th>
                  <th>Area stands</th>
                </tr>
              </thead>
              <tbody>
                {configuration.determinations.map((row) => (
                  <tr key={`${row.salesOrg}/${row.distributionChannel}/${row.division}/${row.documentPricingProcedure}/${row.customerPricingProcedure}`}>
                    <td className="font-mono">
                      {row.salesOrg || '(any)'}/{row.distributionChannel || '(any)'}/{row.division || '(any)'}
                    </td>
                    <td className="font-mono">{row.documentPricingProcedure}</td>
                    <td className="font-mono">{row.customerPricingProcedure}</td>
                    <td className="font-mono">{row.procedureCode}</td>
                    <td>
                      {row.areaStands ? (
                        'Yes'
                      ) : (
                        <span className="text-red-700">No — no document in that area is priced</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 max-w-3xl text-xs text-ink-faint">
          The most specific row that fits answers: a row naming the customer’s own pricing procedure before
          the wildcard, and a row naming the sales area before the one that names none.
        </p>
      </section>

      {canMaintain && (
        <PricingProcedureSetup
          types={configuration.types}
          procedures={configuration.procedures}
          determinations={configuration.determinations}
        />
      )}
    </main>
  );
}

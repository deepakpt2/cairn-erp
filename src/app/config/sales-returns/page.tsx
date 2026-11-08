import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  RETURNS_CONFIGURATION_ROUTE,
  RETURNS_DEFINE_CAPABILITY,
  getReturnsConfiguration,
  type ReturnsConfigurationPart,
} from '@/modules/sales/returns-configuration';
import { ReturnsChainSetup } from './ReturnsChainSetup';

export const dynamic = 'force-dynamic';

const ROUTE = RETURNS_CONFIGURATION_ROUTE;

const PARTS: ReadonlyArray<{ key: 'returnsOrderType' | 'returnsDeliveryType' | 'complaintType' | 'creditMemoType' | 'receiptMovementType'; label: string; what: string }> = [
  { key: 'returnsOrderType', label: 'Returns order', what: 'The complaint, recorded against the invoice' },
  { key: 'returnsDeliveryType', label: 'Returns delivery', what: 'What the goods come back on' },
  { key: 'complaintType', label: 'Complaint', what: 'The credit memo request, held until released' },
  { key: 'creditMemoType', label: 'Credit memo', what: 'What gives the customer their money back' },
  { key: 'receiptMovementType', label: 'Receipt movement', what: 'What receives the goods into returns stock' },
];

function Cell({ part }: { part: ReturnsConfigurationPart }) {
  return (
    <>
      <td className="font-mono">{part.code || '—'}</td>
      <td>{part.name}</td>
      <td>
        {part.stands ? (
          'Stands'
        ) : (
          <span className="text-red-700">Does not stand</span>
        )}
      </td>
      <td>{part.documentsStanding}</td>
    </>
  );
}

export default async function SalesReturnsConfigurationPage() {
  const session = await requireSession(ROUTE);
  const view = await getReturnsConfiguration(session.user.client);
  const canMaintain = can(session, RETURNS_DEFINE_CAPABILITY);

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{RETURNS_DEFINE_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">The returns chain</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Which documents a return is: the order that records the complaint, the delivery the goods come back
          on, the request a credit is raised from, the credit memo itself, and the movement that receives the
          goods into returns stock. Every service in the chain reads this row before it creates anything —
          which is what makes a returns process that numbers apart a configuration rather than a deployment.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for {RETURNS_DEFINE_CAPABILITY};
            broad wildcard role patterns do not grant it.
          </p>
        )}
        {!view.configured && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            The returns chain is not configured for this tenant, so no returns document can be created and no
            goods can be received back. Name the five parts below.
          </p>
        )}
      </header>

      <section aria-labelledby="returns-chain-list" className="border border-line bg-surface p-4">
        <h2 id="returns-chain-list" className="text-sm font-semibold">The chain as it stands</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="grid-table text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-ink-faint">
                <th>Part</th>
                <th>Code</th>
                <th>Name</th>
                <th>Stands</th>
                <th>Documents standing</th>
                <th>What it is</th>
              </tr>
            </thead>
            <tbody>
              {PARTS.map((entry) => (
                <tr key={entry.key}>
                  <td>{entry.label}</td>
                  <Cell part={view[entry.key]} />
                  <td className="text-ink-faint">{entry.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 max-w-3xl text-xs text-ink-faint">
          A part that does not stand is the one fault the chain cannot recover from: the service that needs it
          refuses, and the refusal names this screen. Withdrawing a document type on the sales document types
          screen withdraws it here too, and with it the returns chain.
        </p>
      </section>

      {canMaintain && (
        <ReturnsChainSetup
          choices={view.choices}
          values={{
            returnsOrderType: view.returnsOrderType.code,
            returnsDeliveryType: view.returnsDeliveryType.code,
            complaintType: view.complaintType.code,
            creditMemoType: view.creditMemoType.code,
            receiptMovementType: view.receiptMovementType.code,
          }}
        />
      )}
    </main>
  );
}

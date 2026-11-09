import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  SHIPPING_POINT_CAPABILITY,
  listShippingPointConfiguration,
} from '@/modules/sales/shipping-point-maintenance';
import { ShippingConditionSetup } from './ShippingConditionSetup';
import { ShippingPointSetup } from './ShippingPointSetup';
import { ShippingPointAssignmentSetup } from './ShippingPointAssignmentSetup';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/shipping-points';

export default async function ShippingPointsPage() {
  const session = await requireSession(ROUTE);
  const configuration = await listShippingPointConfiguration(session.user.client);
  const canMaintain = can(session, SHIPPING_POINT_CAPABILITY);
  const unassigned = configuration.plants
    .filter((site) => !configuration.assignments
      .some((row) => row.deliveringPlant === site.plant && row.isActive && row.shippingCondition === '' && row.loadingGroup === ''));

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{SHIPPING_POINT_CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Shipping points</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Where the goods leave from. A delivery names the plant its stock stands in, and the plant is not
          the answer a warehouse needs: what it needs is the dock. That is derived, from three things the
          documents and the masters already carry — the shipping condition of the customer the goods are
          going to, the loading group of the material being sent, and the delivering plant. Those three
          name a shipping point through the table maintained here, and where no row fits, the delivery is
          refused rather than raised with no dock to load from.
        </p>
        {!canMaintain && (
          <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
            Read-only. Maintenance requires an explicit exact-code role grant for{' '}
            {SHIPPING_POINT_CAPABILITY}; broad wildcard role patterns do not grant it.
          </p>
        )}
      </header>

      <section aria-labelledby="docks" className="border border-line bg-surface p-4">
        <h2 id="docks" className="text-sm font-semibold">The docks that stand</h2>
        {configuration.points.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No shipping point stands for this tenant, so no delivery can be raised at all.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Shipping point</th>
                  <th>What it is</th>
                  <th>Rows naming it</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {configuration.points.map((row) => (
                  <tr key={row.shippingPoint}>
                    <td className="font-mono">{row.shippingPoint}</td>
                    <td>{row.name}</td>
                    <td className="font-mono">{row.assignments}</td>
                    <td>{row.isActive ? 'Loads' : <span className="text-red-700">Withdrawn</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="conditions" className="border border-line bg-surface p-4">
        <h2 id="conditions" className="text-sm font-semibold">What a customer may ask for</h2>
        {configuration.conditions.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No shipping condition stands. Customers can still be maintained with none — those are answered
            by the rows below that name no condition.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Code</th>
                  <th>What it means</th>
                  <th>Customers carrying it</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {configuration.conditions.map((row) => (
                  <tr key={row.shippingCondition}>
                    <td className="font-mono">{row.shippingCondition}</td>
                    <td>{row.description}</td>
                    <td className="font-mono">{row.carriers}</td>
                    <td>{row.isActive ? 'Stands' : <span className="text-red-700">Withdrawn</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {configuration.customersWithoutCondition > 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            {configuration.customersWithoutCondition} customer sales area
            {configuration.customersWithoutCondition === 1 ? '' : 's'} carry no condition, so they are
            answered by the rows that name none.
          </p>
        )}
      </section>

      <section aria-labelledby="assignments" className="border border-line bg-surface p-4">
        <h2 id="assignments" className="text-sm font-semibold">What each plant loads, and where</h2>
        {configuration.assignments.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            No plant is assigned a shipping point, so no delivery can be raised.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Delivering plant</th>
                  <th>Shipping condition</th>
                  <th>Loading group</th>
                  <th>Loads through</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {configuration.assignments.map((row) => (
                  <tr key={`${row.deliveringPlant}/${row.shippingCondition}/${row.loadingGroup}`}>
                    <td className="font-mono">{row.deliveringPlant}</td>
                    <td className="font-mono">{row.shippingCondition || '(any)'}</td>
                    <td className="font-mono">{row.loadingGroup || '(any)'}</td>
                    <td className="font-mono">
                      {row.shippingPoint}
                      {row.shippingPointName ? <span className="text-ink-faint"> · {row.shippingPointName}</span> : null}
                    </td>
                    <td>
                      {!row.isActive
                        ? 'Withdrawn'
                        : row.pointStands
                          ? 'Answers'
                          : <span className="text-red-700">Its shipping point is withdrawn</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {unassigned.length > 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            {unassigned.map((site) => site.plant).join(', ')} carries no row naming neither condition nor
            group, so a delivery from {unassigned.length === 1 ? 'it' : 'them'} is refused for any
            combination no more specific row answers.
          </p>
        )}
        <p className="mt-3 max-w-3xl text-xs text-ink-faint">
          The most specific row that fits answers: the row naming both the condition and the loading group
          first, then the row naming the group alone, then the row naming the condition alone, then the
          plant&apos;s row that names neither. The material&apos;s group stands over the customer&apos;s
          condition, because a dock that cannot lift the goods is no answer at all, whereas a customer who
          wants them quickly can be served from anywhere that can load them.
        </p>
      </section>

      {canMaintain && (
        <>
          <ShippingPointSetup rows={configuration.points} />
          <ShippingConditionSetup rows={configuration.conditions} />
          <ShippingPointAssignmentSetup
            rows={configuration.assignments}
            choices={{
              plants: configuration.plants,
              points: configuration.points.map((row) => ({
                shippingPoint: row.shippingPoint, name: row.name,
              })),
              conditions: configuration.conditions.map((row) => ({
                shippingCondition: row.shippingCondition, description: row.description,
              })),
              loadingGroups: configuration.loadingGroups,
            }}
          />
        </>
      )}
    </main>
  );
}

'use client';

import Link from 'next/link';

import type { AuthorityChart, GrantLevel, GrantLine } from '@/modules/people/authority-chart';

/**
 * The authority chart.
 *
 * Two columns: the people in the line on the left, everything about the chosen
 * one on the right. The left column is a list rather than a search box because
 * the set is already bounded — a search field here would imply you can reach
 * someone outside your line, and you cannot.
 *
 * The three delegation panels render their empty state rather than being hidden.
 * They are the reason this screen exists, and a superior reading an empty panel
 * learns that nothing is delegated; a superior reading nothing learns only that
 * the screen is unfinished.
 */

const LEVELS: Record<GrantLevel, string> = {
  TENANT: 'Tenant',
  plant: 'Plant',
  companyCode: 'Company code',
  purchasingOrg: 'Purchasing org',
  purchasingGroup: 'Purchasing group',
  salesOrg: 'Sales org',
  distributionChannel: 'Distribution channel',
  division: 'Division',
  creditControlArea: 'Credit control area',
  controllingArea: 'Controlling area',
};

const SOURCES: Record<GrantLine['source'], string> = {
  ROLE: 'Role',
  POSITION: 'Position',
  DIRECT: 'Direct',
};

function Empty({ children }: { children: string }) {
  return <p className="mt-1 text-xs text-ink-faint">{children}</p>;
}

export default function Authority({
  chart,
  selectedUserId,
  canMaintain,
}: {
  chart: AuthorityChart;
  selectedUserId: string;
  canMaintain: boolean;
}) {
  const { viewer, subjects, selected } = chart;

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <section className="panel p-4" aria-label="People in your reporting line">
        <h2 className="text-sm font-semibold">Your reporting line</h2>
        <p className="mt-1 text-xs text-ink-faint">
          {viewer.fullName}
          {viewer.positions.length === 0
            ? ' holds no position, so there is no line beneath you to read.'
            : ` · ${viewer.positions.map((p) => p.code).join(', ')}`}
        </p>

        {subjects.length === 0 ? (
          <Empty>
            {viewer.positions.length === 0
              ? 'Authority in this system runs through positions. Once you hold one, the people beneath it appear here.'
              : 'No one currently stands in a position beneath yours.'}
          </Empty>
        ) : (
          <table className="grid-table mt-2 text-xs">
            <thead>
              <tr className="text-left text-ink-faint">
                <th>Name</th>
                <th className="text-right">Pos.</th>
                <th className="text-right">Grants</th>
              </tr>
            </thead>
            <tbody>
              {subjects.map((person) => {
                const here = person.userId === selectedUserId;
                return (
                  <tr key={person.userId} className={here ? 'bg-surface-2' : undefined}>
                    <td>
                      <Link
                        href={`/people/authority?user=${encodeURIComponent(person.userId)}`}
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {person.fullName}
                      </Link>
                      <div className="text-ink-faint">{person.username}</div>
                    </td>
                    <td className="text-right">{person.positionCount}</td>
                    <td className="text-right">{person.grantCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="space-y-4">
        {!selected ? (
          <section className="panel p-4" aria-label="Pick a person">
            <h2 className="text-sm font-semibold">No one selected</h2>
            <Empty>
              {subjects.length === 0
                ? 'There is no one in your reporting line to select.'
                : 'Choose someone from your reporting line to see where they stand and what they hold.'}
            </Empty>
          </section>
        ) : (
          <>
            <section className="panel p-4" aria-label="Where they stand">
              <h2 className="text-sm font-semibold">{selected.fullName}</h2>
              <p className="mt-1 text-xs text-ink-faint">{selected.username}</p>

              {selected.positions.length === 0 ? (
                <Empty>Holds no position, so stands outside the structure.</Empty>
              ) : (
                <table className="grid-table mt-2 text-xs">
                  <thead>
                    <tr className="text-left text-ink-faint">
                      <th>Position</th>
                      <th>Title</th>
                      <th>Org unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.positions.map((position) => (
                      <tr key={position.code}>
                        <td className="code">{position.code}</td>
                        <td>{position.title}</td>
                        <td>
                          {position.orgUnitCode
                            ? `${position.orgUnitCode} · ${position.orgUnitName}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {selected.superiorLine.length > 0 && (
                <p className="mt-3 text-xs text-ink-soft">
                  Reports up:{' '}
                  {selected.superiorLine
                    .map((step) => (step.kind === 'ORG_UNIT' ? `${step.label} (unit)` : step.label))
                    .join('  →  ')}
                </p>
              )}
            </section>

            <section className="panel p-4" aria-label="What they hold">
              <h2 className="text-sm font-semibold">What they hold</h2>
              <p className="mt-1 text-xs text-ink-faint">
                One row per grant per level. A grant covering two plants reads as one row listing
                both, so that a grant covering forty is still one row rather than a wall.
              </p>
              {selected.grants.length === 0 ? (
                <Empty>
                  Holds nothing: no role, no position capability, and no direct grant.
                </Empty>
              ) : (
                <table className="grid-table mt-2 text-xs">
                  <thead>
                    <tr className="text-left text-ink-faint">
                      <th>Capability</th>
                      <th>Source</th>
                      <th>Via</th>
                      <th>Level</th>
                      <th>Values</th>
                      <th>Until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.grants.map((grant, index) => (
                      <tr key={`${grant.pattern}-${grant.level}-${index}`}>
                        <td className="code">{grant.pattern}</td>
                        <td>{SOURCES[grant.source] ?? grant.source}</td>
                        <td className="text-ink-faint">{grant.via || '—'}</td>
                        <td>{LEVELS[grant.level] ?? grant.level}</td>
                        <td>{grant.values.length ? grant.values.join(', ') : 'all'}</td>
                        <td className="text-ink-faint">{grant.validTo ?? 'open'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {selected.grants.some((grant) => grant.reason) && (
                <ul className="mt-2 space-y-1 text-xs text-ink-faint">
                  {selected.grants
                    .filter((grant) => grant.reason)
                    .map((grant, index) => (
                      <li key={`reason-${index}`}>
                        {grant.pattern} — {grant.reason}
                        {grant.granter ? ` (given by ${grant.granter})` : ''}
                      </li>
                    ))}
                </ul>
              )}
            </section>

            <section className="panel p-4" aria-label="Delegated to them">
              <h2 className="text-sm font-semibold">Delegated to them</h2>
              <Empty>
                Nothing has been delegated to this person. Delegation is not built yet — this panel
                fills when it is.
              </Empty>
            </section>

            <section className="panel p-4" aria-label="What they have delegated away">
              <h2 className="text-sm font-semibold">What they have delegated away</h2>
              <Empty>
                They have delegated nothing away. Delegation is not built yet — this panel fills
                when it is.
              </Empty>
            </section>

            <section className="panel p-4" aria-label="Pending acceptance">
              <h2 className="text-sm font-semibold">Pending acceptance</h2>
              <Empty>
                Nothing is waiting on this person to accept. Delegation is not built yet — this
                panel fills when it is.
              </Empty>
            </section>
          </>
        )}

        {!canMaintain && (
          <p className="text-xs text-ink-faint">
            This screen is read-only: seeing authority is not the same as granting it.
          </p>
        )}
      </div>
    </div>
  );
}

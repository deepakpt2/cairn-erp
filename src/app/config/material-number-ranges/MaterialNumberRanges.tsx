'use client';

/**
 * Material number range groups (SCR-051 / MMNR; inert since stage 1).
 *
 * The group–interval matrix: each group names one internal and one
 * external interval of the MATERIALNR object; the interval facts (bounds,
 * current number, next preview) read from the standing engine. Group
 * maintenance and the assignment of types land with the service.
 */
export interface RangeGroupRow {
  internalKey: string;
  externalKey: string;
  description: string;
  internalFrom: number;
  internalTo: number;
  internalCurrent: number;
  internalStatus: string;
  externalFrom: number;
  externalTo: number;
  externalCurrent: number;
  externalStatus: string;
  assignedTypes: string[];
}

export interface UngroupedIntervalRow {
  rangeKey: string;
  isExternal: boolean;
  fromNumber: number;
  toNumber: number;
  currentNumber: number;
  status: string;
}

function nextPreview(current: number, to: number): string {
  return current + 1 <= to ? String(current + 1) : '—';
}

export default function MaterialNumberRanges({
  groups,
  ungrouped,
}: {
  groups: RangeGroupRow[];
  ungrouped: UngroupedIntervalRow[];
}) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="material-range-groups-grid" className="space-y-3">
        <h2 id="material-range-groups-grid" className="text-base font-semibold">
          Number range groups
        </h2>
        {groups.length === 0 ? (
          <p className="text-sm text-ink-faint">No number range groups stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Group</th>
                  <th className="py-2 pe-3">Internal interval</th>
                  <th className="py-2 pe-3">Bounds</th>
                  <th className="py-2 pe-3">Current</th>
                  <th className="py-2 pe-3">Next</th>
                  <th className="py-2 pe-3">External interval</th>
                  <th className="py-2 pe-3">Bounds</th>
                  <th className="py-2 pe-3">Current</th>
                  <th className="py-2 pe-3">Material types</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((row) => (
                  <tr
                    key={`${row.internalKey}/${row.externalKey}`}
                    className="border-b border-line/60"
                  >
                    <td className="py-2 pe-3 font-medium">{row.description}</td>
                    <td className="py-2 pe-3 font-mono">{row.internalKey}</td>
                    <td className="py-2 pe-3">
                      {row.internalFrom}–{row.internalTo} ({row.internalStatus})
                    </td>
                    <td className="py-2 pe-3">{row.internalCurrent}</td>
                    <td className="py-2 pe-3">
                      {nextPreview(row.internalCurrent, row.internalTo)}
                    </td>
                    <td className="py-2 pe-3 font-mono">{row.externalKey}</td>
                    <td className="py-2 pe-3">
                      {row.externalFrom}–{row.externalTo} ({row.externalStatus})
                    </td>
                    <td className="py-2 pe-3">{row.externalCurrent}</td>
                    <td className="py-2 pe-3">
                      {row.assignedTypes.length > 0 ? row.assignedTypes.join(', ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="material-range-ungrouped-grid" className="space-y-3">
        <h2 id="material-range-ungrouped-grid" className="text-base font-semibold">
          Ungrouped intervals
        </h2>
        {ungrouped.length === 0 ? (
          <p className="text-sm text-ink-faint">Every material interval stands in a group.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Range key</th>
                  <th className="py-2 pe-3">Assignment</th>
                  <th className="py-2 pe-3">Bounds</th>
                  <th className="py-2 pe-3">Current</th>
                  <th className="py-2 pe-3">Next</th>
                  <th className="py-2 pe-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {ungrouped.map((row) => (
                  <tr key={row.rangeKey} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-mono">{row.rangeKey}</td>
                    <td className="py-2 pe-3">{row.isExternal ? 'External' : 'Internal'}</td>
                    <td className="py-2 pe-3">
                      {row.fromNumber}–{row.toNumber}
                    </td>
                    <td className="py-2 pe-3">{row.currentNumber}</td>
                    <td className="py-2 pe-3">{nextPreview(row.currentNumber, row.toNumber)}</td>
                    <td className="py-2 pe-3">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

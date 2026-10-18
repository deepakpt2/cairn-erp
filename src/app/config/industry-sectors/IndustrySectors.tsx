'use client';

/**
 * Industry sector definition (SCR-052 / OMS3; inert since stage 1).
 *
 * The master materials are created under: one-character sector keys with
 * their names. Maintenance (create, rename, deactivate, delete-when-
 * unused) lands with the service; this stage renders the shape.
 */
export interface IndustrySectorRow {
  sector: string;
  name: string;
  isActive: boolean;
  materialCount: number;
}

export default function IndustrySectors({ sectors }: { sectors: IndustrySectorRow[] }) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="industry-sectors-grid" className="space-y-3">
        <h2 id="industry-sectors-grid" className="text-base font-semibold">
          Industry sectors
        </h2>
        {sectors.length === 0 ? (
          <p className="text-sm text-ink-faint">No industry sectors stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Sector</th>
                  <th className="py-2 pe-3">Name</th>
                  <th className="py-2 pe-3">Materials</th>
                  <th className="py-2 pe-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {sectors.map((row) => (
                  <tr key={row.sector} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">{row.sector}</td>
                    <td className="py-2 pe-3">{row.name}</td>
                    <td className="py-2 pe-3">{row.materialCount}</td>
                    <td className="py-2 pe-3">{row.isActive ? 'Active' : 'Inactive'}</td>
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

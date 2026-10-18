'use client';

import { t } from '@/platform/i18n';

/**
 * Material deletion flags (SCR-053 / MM06; inert since stage 1).
 *
 * The flag status at every standing scope: the client level and each
 * plant the material is extended to, with the stock standing at the
 * scope. Setting and cancelling land with the service; this stage
 * renders the shape.
 */
export interface DeletionFlagPlantRow {
  plant: string;
  flagged: boolean;
  stock: string;
}

export default function DeletionFlags({
  clientFlagged,
  clientStock,
  plants,
}: {
  clientFlagged: boolean;
  clientStock: string;
  plants: DeletionFlagPlantRow[];
}) {
  return (
    <section aria-labelledby="material-deletion-title" className="panel space-y-3 p-4">
      <h2 id="material-deletion-title" className="text-base font-semibold">
        {t('material.deletion')}
      </h2>
      <p className="max-w-3xl text-sm text-ink-soft">{t('material.deletionNote')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-ink-soft">
              <th className="py-2 pe-3">Scope</th>
              <th className="py-2 pe-3">{t('material.status')}</th>
              <th className="py-2 pe-3">Stock</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line/60">
              <td className="py-2 pe-3 font-medium">{t('material.deletionClient')}</td>
              <td className="py-2 pe-3">
                {clientFlagged ? t('material.flagged') : t('material.notFlagged')}
              </td>
              <td className="py-2 pe-3">{clientStock}</td>
            </tr>
            {plants.map((row) => (
              <tr key={row.plant} className="border-b border-line/60">
                <td className="py-2 pe-3 font-medium">
                  {t('material.deletionPlant', { plant: row.plant })}
                </td>
                <td className="py-2 pe-3">
                  {row.flagged || clientFlagged
                    ? t('material.flagged')
                    : t('material.notFlagged')}
                </td>
                <td className="py-2 pe-3">{row.stock}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

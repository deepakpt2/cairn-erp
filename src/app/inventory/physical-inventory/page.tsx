import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PHYSICAL_INVENTORY_CANCEL_CAPABILITY,
  PHYSICAL_INVENTORY_CREATE_CAPABILITY,
  PHYSICAL_INVENTORY_ROUTE,
  listPhysicalInventory,
} from '@/modules/inventory/physical-inventory';
import { CancelListed } from './CancelListed';
import PhysicalInventoryShell from './PhysicalInventoryShell';

export const dynamic = 'force-dynamic';

/**
 * Physical inventory documents — SCR-142 / INV.PHYINV.CREATE (MI01 as a search alias only).
 *
 * The count is the one inventory document that posts nothing: it names what will be counted
 * and, if asked, blocks the materials against movement until the count is done. The count itself is
 * entered on the count workbench, which this document links to: it records what a counter saw
 * against the book quantity frozen here and posts nothing. The difference review and the difference
 * posting are the rounds that follow.
 */
export default async function PhysicalInventoryPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession(PHYSICAL_INVENTORY_ROUTE);
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const documents = await listPhysicalInventory(session.user.client, {
    plant: params.plant?.trim() || undefined,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">INV.PHYINV.CREATE · MI01</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mi01.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mi01.subtitle')}</p>
      </header>

      <PhysicalInventoryShell
        canCreate={can(session, PHYSICAL_INVENTORY_CREATE_CAPABILITY)}
        canCancel={can(session, PHYSICAL_INVENTORY_CANCEL_CAPABILITY)}
        today={today}
      />

      <section aria-labelledby="count-list" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="count-list" className="text-sm font-semibold">{t('mi01.listHeader')}</h2>
        {documents.length === 0 ? (
          <p className="mt-1 text-sm text-ink-soft">{t('mi01.listEmpty')}</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <th className="py-1">{t('mi01.document')}</th>
                <th className="py-1">{t('mi01.fiscalYear')}</th>
                <th className="py-1">{t('mi01.plant')}</th>
                <th className="py-1">{t('mi01.storageLocation')}</th>
                <th className="py-1">{t('mi01.plannedCountDate')}</th>
                <th className="py-1">{t('mi01.blocked')}</th>
                <th className="py-1">{t('mi01.status')}</th>
                <th className="py-1">{t('mi01.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => (
                <tr key={`${document.inventoryDocumentNumber}/${document.fiscalYear}`} className="border-t border-line" data-document={document.inventoryDocumentNumber}>
                  <td className="py-1 code">{document.inventoryDocumentNumber}</td>
                  <td className="py-1 tabular">{document.fiscalYear}</td>
                  <td className="py-1">{document.plant}</td>
                  <td className="py-1">{document.storageLocation ?? t('mi01.wholePlant')}</td>
                  <td className="py-1 tabular">{document.plannedCountDate}</td>
                  <td className="py-1">{document.postingBlock ? t('mi01.blocked') : '—'}</td>
                  <td className="py-1" data-status={document.status}>{document.status}</td>
                  <td className="py-1">
                    {document.status === 'CREATED' && can(session, PHYSICAL_INVENTORY_CANCEL_CAPABILITY) && (
                      <CancelListed number={document.inventoryDocumentNumber} year={document.fiscalYear} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

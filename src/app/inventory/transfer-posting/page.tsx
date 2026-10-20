import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  TRANSFER_POST_CAPABILITY,
  getTransferDocument,
  transferStockAt,
} from '@/modules/inventory/transfer-posting';
import TransferPosting from './TransferPosting';

export const dynamic = 'force-dynamic';

const ROUTE = '/inventory/transfer-posting';

/**
 * Transfer posting (SCR-131 / MB1B as a search alias only).
 *
 * A transfer is a two-line material document: the issuing line and the
 * receiving line of one material, net zero. The movement type carries the
 * scenario — storage location, plant, or stock type — and the reversal is the
 * counter movement type, never a hand-entered document.
 */
export default async function TransferPostingPage({ searchParams }: {
  searchParams: Promise<{ material?: string; plant?: string; doc?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const document = params.doc ? await getTransferDocument(client, params.doc) : null;
  const material = params.material ?? document?.lines[0]?.materialNumber ?? '';
  const plant = params.plant ?? document?.lines[0]?.plant ?? '';
  const stock = material && plant ? await transferStockAt(client, material, plant) : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{t('mb1b.code')}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('mb1b.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
            {t('nav.launchpad')}
          </Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('mb1b.subtitle')}</p>
      </header>

      <TransferPosting
        document={document}
        stock={stock}
        canPost={can(session, TRANSFER_POST_CAPABILITY)}
        today={today}
      />
    </div>
  );
}


import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  TRANSFER_POST_CAPABILITY,
  getTransferDocument,
  transferStockAt,
} from '@/modules/inventory/transfer-posting';
import TransferPosting from './TransferPosting';
import StoIssuePanel from './StoIssuePanel';
import { getStoStatus } from '@/modules/inventory/stock-transport';
import { Page } from '@/ui/kit';

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
  searchParams: Promise<{ material?: string; plant?: string; doc?: string; sto?: string }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const document = params.doc ? await getTransferDocument(client, params.doc) : null;
  const material = params.material ?? document?.lines[0]?.materialNumber ?? '';
  const plant = params.plant ?? document?.lines[0]?.plant ?? '';
  const stock = material && plant ? await transferStockAt(client, material, plant) : [];
  const today = new Date().toISOString().slice(0, 10);
  const stoNumber = (params.sto ?? '').trim().toUpperCase();
  const stoStatus = stoNumber ? await getStoStatus(client, stoNumber, { userId: session.user.userId }) : null;

  return (
    <Page
      title={t('mb1b.title')} code={t('mb1b.code')} back={{ href: '/', label: t('nav.launchpad') }}
      description={t('mb1b.subtitle')}
    >

      <TransferPosting
        document={document}
        stock={stock}
        canPost={can(session, TRANSFER_POST_CAPABILITY)}
        today={today}
      />
      <StoIssuePanel
        status={stoStatus}
        orderNumber={stoNumber}
        canPost={can(session, TRANSFER_POST_CAPABILITY)}
        today={today}
        lookupMessage={stoNumber && !stoStatus ? `${stoNumber} is not a stock transport order.` : null}
      />
    </Page>
  );
}

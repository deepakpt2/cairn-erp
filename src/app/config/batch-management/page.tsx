import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  BATCH_IMG_NODES,
  NOT_OCHA,
  NOT_OPENED,
  RELATED_BATCH_NODES,
  ROUTE,
} from '@/modules/inventory/batch-management-img';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * IMG Batch Management. OCHA is a search alias only.
 * It lists the batch configuration screens that already exist.
 * It does not define a characteristic and it does not post.
 */
export default async function BatchManagementImgPage() {
  await requireSession(ROUTE);

  return (
    <Page
      title="IMG Batch Management" code={<>{ACTIVITY} · {ALIAS}</>} width="3xl" back={null}
      description="OCHA opens this index. It is not CT04. It does not define a characteristic, assign a class, store a batch value, create a batch, or post. Opening it writes nothing. A closed posting period does not block it."
      actions={
        <>
          <LinkButton href="/config">Workbench</LinkButton>
        </>
      }
    >

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Batch management</h2>
        <table className="grid-table mt-2 text-sm">
          <thead>
            <tr className="text-left">
              <th>Transaction</th>
              <th>Activity</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {BATCH_IMG_NODES.map((node) => (
              <tr key={node.tcode}>
                <td>
                  <Link href={node.route} className="code">{node.tcode}</Link>
                </td>
                <td>{node.title}</td>
                <td className="text-ink-soft">{node.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Related transactions</h2>
        <p className="mt-1 text-sm text-ink-soft">These are not IMG activities. The routes already exist.</p>
        <table className="grid-table mt-2 text-sm">
          <tbody>
            {RELATED_BATCH_NODES.map((node) => (
              <tr key={node.tcode}>
                <td>
                  <Link href={node.route} className="code">{node.tcode}</Link>
                </td>
                <td>{node.title}</td>
                <td className="text-ink-soft">{node.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Not this screen</h2>
        <table className="grid-table mt-2 text-sm">
          <tbody>
            {NOT_OCHA.map((node) => (
              <tr key={node.tcode}>
                <td>
                  <Link href={node.route} className="code">{node.tcode}</Link>
                </td>
                <td>{node.title}</td>
                <td className="text-ink-soft">{node.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm text-ink-soft">
          Not opened from here: {NOT_OPENED.join(', ')}. No route is invented for them.
        </p>
      </section>
    </Page>
  );
}

import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import {
  ACTIVITY,
  ALIAS,
  BATCH_IMG_NODES,
  NOT_OCHA,
  NOT_OPENED,
  ROUTE,
} from '@/modules/inventory/batch-management-img';

export const dynamic = 'force-dynamic';

/**
 * IMG Batch Management. OCHA is a search alias only.
 * It lists the batch configuration screens that already exist.
 * It does not define a characteristic and it does not post.
 */
export default async function BatchManagementImgPage() {
  await requireSession(ROUTE);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY} · {ALIAS}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">IMG Batch Management</h1>
          <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">Workbench</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          OCHA opens this index. It is not CT04. It does not define a characteristic, assign a class,
          store a batch value, create a batch, or post. Opening it writes nothing. A closed posting
          period does not block it.
        </p>
      </header>

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Batch management</h2>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-2 py-2">Transaction</th>
              <th className="px-2 py-2">Activity</th>
              <th className="px-2 py-2">What it does</th>
            </tr>
          </thead>
          <tbody>
            {BATCH_IMG_NODES.map((node) => (
              <tr key={node.tcode} className="border-b border-line/60">
                <td className="px-2 py-2">
                  <Link href={node.route} className="code">{node.tcode}</Link>
                </td>
                <td className="px-2 py-2">{node.title}</td>
                <td className="px-2 py-2 text-ink-soft">{node.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Not this screen</h2>
        <table className="mt-2 w-full text-sm">
          <tbody>
            {NOT_OCHA.map((node) => (
              <tr key={node.tcode} className="border-b border-line/60">
                <td className="px-2 py-2">
                  <Link href={node.route} className="code">{node.tcode}</Link>
                </td>
                <td className="px-2 py-2">{node.title}</td>
                <td className="px-2 py-2 text-ink-soft">{node.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm text-ink-soft">
          Not opened from here: {NOT_OPENED.join(', ')}. No route is invented for them.
        </p>
      </section>
    </div>
  );
}

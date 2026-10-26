import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  getSettlementConfiguration,
  SETTLEMENT_RULE_CAPABILITY,
  SETTLEMENT_RULE_ROUTE,
} from '@/modules/foundation/settlement-configuration';
import RuleForm from './RuleForm';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

/** Settlement rule entry. It has no SAP transaction code and does not post. */
export default async function SettlementRulePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(SETTLEMENT_RULE_ROUTE);
  if (!can(session, SETTLEMENT_RULE_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Settlement rule</h1>
        <p className="mt-2 text-sm">You do not hold the settlement-rule capability (CO.SETTLE.RULE).</p>
      </main>
    );
  }
  const orderNumber = last((await searchParams).order);
  const stored = orderNumber ? await getSettlementConfiguration(session.user.client, orderNumber) : null;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">CO.SETTLE.RULE</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Settlement rule</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Store the rule KO88 and KO8G read. Saving does not post. No receiver, percentage, or account is filled in. This screen has no SAP transaction code.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft">
          The profile, the allocation structure and its account assignments are shared by every order of the order type, so they are not
          maintained here.{' '}
          <Link href="/config/settlement-configuration" className="underline">Settlement configuration</Link>
          {' '}holds them.
        </p>
      </header>
      <RuleForm orderNumber={orderNumber} stored={stored} />
    </main>
  );
}

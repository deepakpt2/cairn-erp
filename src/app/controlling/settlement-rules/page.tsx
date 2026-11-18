import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  getSettlementConfiguration,
  SETTLEMENT_RULE_CAPABILITY,
  SETTLEMENT_RULE_ROUTE,
} from '@/modules/foundation/settlement-configuration';
import RuleForm from './RuleForm';
import { Page } from '@/ui/kit';

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
      <Page
      title="Settlement rule" width="3xl" back={null}
    >
        <p className="mt-2 text-sm">You do not hold the settlement-rule capability (CO.SETTLE.RULE).</p>
      </Page>
    );
  }
  const orderNumber = last((await searchParams).order);
  const stored = orderNumber ? await getSettlementConfiguration(session.user.client, orderNumber) : null;

  return (
    <Page
      title="Settlement rule" code="CO.SETTLE.RULE" width="4xl"
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              Store the rule KO88 and KO8G read. Saving does not post. No receiver, percentage, or account is filled in. This screen has no SAP transaction code.
            </p>
          <p className="max-w-3xl text-sm text-ink-soft">
              The profile, the allocation structure and its account assignments are shared by every order of the order type, so they are not
              maintained here.{' '}
              <Link href="/config/settlement-configuration" className="underline">Settlement configuration</Link>
              {' '}holds them.
            </p>
        </>
      }
    >
      <RuleForm orderNumber={orderNumber} stored={stored} />
    </Page>
  );
}

import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { listNumberRanges } from '@/modules/foundation/number-ranges';
import { hasCompanyCodeAssignments } from '@/modules/foundation/company-code-assignments';
import {
  ACCRUAL_CAPABILITY, listAccrualDocuments, listDueAccruals,
} from '@/modules/finance/accrual';
import { withTenant } from '@/platform/db/client';
import { reversalReason } from '@/modules/finance/schema';
import { and, eq } from 'drizzle-orm';
import AccrualShell from './AccrualShell';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/accruals';

/**
 * Accrual/deferral documents (SCR-100 / FBS1 entry and F.81
 * reversal processing as search aliases only).
 */
export default async function AccrualsPage() {
  const session = await requireSession(ROUTE);
  const { companies, types } = await listNumberRanges(session.user.client);
  const active = companies.filter((c) => c.isActive && hasCompanyCodeAssignments(c));
  const canPost = can(session, ACCRUAL_CAPABILITY);
  const reasons = canPost ? await withTenant(session.user.client, async (tx) => tx
    .select({ reasonCode: reversalReason.reasonCode, reasonDescription: reversalReason.reasonDescription })
    .from(reversalReason)
    .where(and(eq(reversalReason.client, session.user.client), eq(reversalReason.isActive, true)))
    .orderBy(reversalReason.reasonCode)) : [];
  const today = new Date().toISOString().slice(0, 10);
  const due = canPost ? await listDueAccruals(session.user.client, today) : [];
  const all = canPost ? await listAccrualDocuments(session.user.client) : [];
  const dueKeys = new Set(due.map((d) => `${d.documentNumber}|${d.fiscalYear}`));
  const listed = [...due, ...all.filter((d) => !dueKeys.has(`${d.documentNumber}|${d.fiscalYear}`))];
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">FIN.ACCRUAL.POST · FBS1 / F.81</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('accrual.title')}</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('accrual.subtitle')}</p>
      </header>
      <AccrualShell
        canPost={canPost}
        companies={active.map(({ companyCode, name, currency }) => ({ companyCode, name, currency }))}
        types={types.map(({ documentType, name }) => ({ documentType, name }))}
        reasons={reasons}
        due={listed}
      />
    </div>
  );
}

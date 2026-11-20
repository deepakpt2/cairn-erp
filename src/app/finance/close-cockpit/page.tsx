import type { Metadata } from 'next';
import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { t } from '@/platform/i18n';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { listCompanyCodes } from '@/modules/foundation/services';
import { hasCompanyCodeAssignments } from '@/modules/foundation/company-code-assignments';
import {
  CLOSE_COCKPIT_CAPABILITY, getTaskList, listEvents, listExecutions, listTaskLists, listTasks,
  type CloseCycleKey,
} from '@/modules/finance/close-cockpit';
import CloseCockpitShell from './CloseCockpitShell';
import { Page } from '@/ui/kit';

export const metadata: Metadata = { title: 'Close Cockpit' };

export default async function ScreenPage({ searchParams }: {
  searchParams: Promise<{ company?: string; list?: string; fy?: string; period?: string; error?: string }>;
}) {
  const session = await requireSession('/finance/close-cockpit');
  const params = await searchParams;
  const canUse = can(session, CLOSE_COCKPIT_CAPABILITY);
  const companies = (await listCompanyCodes(session.user.client))
    .filter((c) => c.isActive && hasCompanyCodeAssignments(c))
    .map((c) => ({ companyCode: c.companyCode, name: c.name }));
  const templates = canUse ? await withTenant(session.user.client, async (tx) => {
    const rows = await tx.execute(sql`
      select distinct template_code from closing_task_template where client = ${session.user.client} order by template_code
    `);
    return (rows as unknown as Array<{ template_code: string }>).map((r) => r.template_code);
  }) : [];
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };
  const lists = canUse ? await listTaskLists(session.user.client, authorization) : [];

  let selected: (CloseCycleKey & { list: Awaited<ReturnType<typeof getTaskList>> }) | null = null;
  let tasks: Awaited<ReturnType<typeof listTasks>> = [];
  let executions: Awaited<ReturnType<typeof listExecutions>> = [];
  let events: Awaited<ReturnType<typeof listEvents>> = [];
  if (canUse && params.company && params.list && params.fy && params.period) {
    const cycle: CloseCycleKey = {
      companyCode: params.company, taskListId: params.list.toUpperCase(),
      fiscalYear: Number(params.fy), postingPeriod: Number(params.period),
    };
    try {
      const list = await getTaskList(session.user.client, cycle, authorization);
      selected = { ...cycle, list };
      tasks = await listTasks(session.user.client, cycle, {}, authorization);
      executions = await listExecutions(session.user.client, cycle, undefined, authorization);
      events = await listEvents(session.user.client, cycle, authorization);
    } catch {
      selected = null;
    }
  }

  return (
    <Page
      title={t('close.title')} code={t('finance.label')} back={null}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">{t('close.intro')}</p>
          <Link href="/finance/journal" className="mt-1 inline-block text-sm text-accent hover:underline">
              {t('close.openJournal')}
            </Link>
        </>
      }
    >
      <CloseCockpitShell
        canUse={canUse}
        companies={companies}
        templates={templates}
        lists={lists}
        selected={selected}
        tasks={tasks}
        executions={executions}
        events={events}
        notice={params.error ?? null}
      />
    </Page>
  );
}

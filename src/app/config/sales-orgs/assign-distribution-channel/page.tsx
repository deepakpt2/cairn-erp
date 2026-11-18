import Link from 'next/link';
import { and, eq, inArray } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { salesOrgText } from '@/modules/foundation/schema';
import {
  listSalesOrgDistributionChannelAssignments,
  salesOrgDistributionChannelF4Choices,
} from '@/modules/foundation/sales-org-distribution-channel-assignment';
import { SalesOrgDistributionChannelAssignmentsList } from './AssignmentsList';
import { SalesOrgDistributionChannelAssignmentForm } from './AssignmentForm';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ACTIVITY = 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL';
const ROUTE = '/config/sales-orgs/assign-distribution-channel';
const SALES_AREA_ACTIVITY = 'CFG.ORG.SALESAREA.DEFINE';

/** OVXK-style tenant-local many-to-many assignment activity. */
export default async function AssignDistributionChannelPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const canDefineSalesArea = can(session, SALES_AREA_ACTIVITY);
  const languageKey = session.user.logonLanguage ?? 'E';

  const assignments = await listSalesOrgDistributionChannelAssignments(client);
  const valueHelp = canMaintain
    ? await salesOrgDistributionChannelF4Choices(client)
    : { salesOrganizations: [], distributionChannels: [] };

  const organisationCodes = [...new Set([
    ...assignments.map((item) => item.salesOrg.trim()),
    ...valueHelp.salesOrganizations.map((code) => code.trim()),
  ])];
  const organisationTexts = organisationCodes.length
    ? await withTenant(client, (tx) => tx
        .select({ salesOrg: salesOrgText.salesOrg, languageKey: salesOrgText.languageKey, name: salesOrgText.name })
        .from(salesOrgText)
        .where(and(
          eq(salesOrgText.client, client),
          inArray(salesOrgText.salesOrg, organisationCodes),
          inArray(salesOrgText.languageKey, [...new Set([languageKey, 'E'])]),
        )))
    : [];

  function organisationName(code: string) {
    const localised = organisationTexts.find((item) =>
      item.salesOrg.trim() === code && item.languageKey.trim() === languageKey,
    );
    const english = organisationTexts.find((item) =>
      item.salesOrg.trim() === code && item.languageKey.trim() === 'E',
    );
    return localised?.name.trim() || english?.name.trim() || t('salesOrg.noDescription');
  }

  const salesOrganizations = valueHelp.salesOrganizations.map((code) => ({
    code: code.trim(),
    name: organisationName(code.trim()),
  }));
  const assignmentRows = assignments.map((item) => ({
    salesOrg: item.salesOrg.trim(),
    salesOrgName: organisationName(item.salesOrg.trim()),
    salesOrgActive: item.salesOrgActive,
    distributionChannel: item.distributionChannel.trim(),
    distributionChannelName: item.distributionChannelName.trim(),
    distributionChannelActive: item.distributionChannelActive,
  }));
  const hasActiveSalesOrganizations = salesOrganizations.length > 0;
  const hasActiveDistributionChannels = valueHelp.distributionChannels.length > 0;

  return (
    <Page title={t('salesOrgChannel.title')} code={<>{ACTIVITY} · OVXK</>} back={{ href: '/config', label: t('nav.workbench') }}>
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-3 py-3 sm:py-2">
          <Link href="/config" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8 sm:py-1">
            {t('nav.workbench')}
          </Link>
          <Link href="/config/sales-orgs" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8 sm:py-1">
            {t('salesOrg.backToDefinitions')}
          </Link>
          <Link href="/config/distribution-channels" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8 sm:py-1">
            {t('distributionChannel.title')}
          </Link>
          {canDefineSalesArea && <Link href="/config/sales-areas" className="inline-flex min-h-11 items-center border border-line-strong bg-white px-3 text-sm font-medium text-accent hover:bg-sunken sm:min-h-8 sm:py-1">{t('salesArea.navLink')}</Link>}
        </div>
        <p className="border-b border-line px-3 py-3 text-sm text-ink-soft sm:px-4">{t('salesOrgChannel.subtitle')}</p>
        <p className="border-b border-line bg-sunken px-3 py-2 text-xs text-ink-soft sm:px-4">{t('salesOrgChannel.assignmentRule')}</p>
      </section>

      {!canMaintain && (
        <p role="status" className="border border-line bg-white p-3 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}
      {canMaintain && !hasActiveSalesOrganizations && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('salesOrgChannel.noActiveSalesOrgs')}
        </p>
      )}
      {canMaintain && !hasActiveDistributionChannels && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('salesOrgChannel.noActiveDistributionChannels')}
        </p>
      )}

      {canMaintain && hasActiveSalesOrganizations && hasActiveDistributionChannels && (
        <SalesOrgDistributionChannelAssignmentForm
          salesOrganizations={salesOrganizations}
          distributionChannels={valueHelp.distributionChannels}
        />
      )}

      <SalesOrgDistributionChannelAssignmentsList assignments={assignmentRows} canRemove={canMaintain} />
    </Page>
  );
}

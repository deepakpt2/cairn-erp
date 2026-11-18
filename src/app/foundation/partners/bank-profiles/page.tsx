import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { listPartnerBankProfileActivationRows } from '@/modules/foundation/partner-bank-profile-activation-view';
import { PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY } from '@/platform/security/partner-bank-profile-activation';
import { t } from '@/platform/i18n';
import { PartnerBankProfileActivationPanel } from '../PartnerBankProfileActivationPanel';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

export default async function PartnerBankProfilesPage() {
  const session = await requireSession('/foundation/partners/bank-profiles');
  if (!can(session, PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY)) {
    return (
      <main className="mx-auto max-w-6xl p-6">
        <p className="panel p-4">
          {t('auth.missingAuthority', { authority: PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY })}
        </p>
      </main>
    );
  }

  const rows = await listPartnerBankProfileActivationRows();
  return (
    <Page
      title={t('bp.profile.pageTitle')} code={PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY} back={{ href: '/config', label: t('nav.workbench') }}
      description={t('bp.profile.pageSubtitle')}
      actions={
        <>
          <Link className="btn btn-default" href="/foundation/partners">{t('bp.profile.backToPartners')}</Link>
        </>
      }
    >
      <PartnerBankProfileActivationPanel rows={rows} />
    </Page>
  );
}

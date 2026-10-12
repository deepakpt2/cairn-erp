import Link from 'next/link';
import { can, requireSession } from '@/platform/auth/current';
import { listPartnerBankProfileActivationRows } from '@/modules/foundation/partner-bank-profile-activation-view';
import { PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY } from '@/platform/security/partner-bank-profile-activation';
import { t } from '@/platform/i18n';
import { PartnerBankProfileActivationPanel } from '../PartnerBankProfileActivationPanel';

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
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY}</span>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{t('bp.profile.pageTitle')}</h1>
          <div className="flex gap-2">
            <Link className="btn btn-default" href="/foundation/partners">{t('bp.profile.backToPartners')}</Link>
            <Link className="btn btn-default" href="/config">{t('nav.workbench')}</Link>
          </div>
        </div>
        <p className="mt-1 text-sm text-ink-soft">{t('bp.profile.pageSubtitle')}</p>
      </header>
      <PartnerBankProfileActivationPanel rows={rows} />
    </main>
  );
}

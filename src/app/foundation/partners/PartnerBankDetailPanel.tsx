import Link from 'next/link';
import { t } from '@/platform/i18n';
import type { PartnerBankMaskedDetail } from '@/modules/foundation/partner-bank-detail-view';

interface PartnerBankDetailPanelProps {
  readonly partnerNumber: string;
  readonly detail: PartnerBankMaskedDetail | null;
}

/** Read-only detail view. The caller passes the already-projected mask only. */
export function PartnerBankDetailPanel({ partnerNumber, detail }: PartnerBankDetailPanelProps) {
  const listHref = `/foundation/partners?partner=${encodeURIComponent(partnerNumber)}&view=BANKS`;

  return (
    <section className="panel" aria-labelledby="partner-bank-detail-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-3">
        <h2 id="partner-bank-detail-title" className="panel-title">
          {t('bp.bank.detailTitle')}
        </h2>
        <Link href={listHref} className="text-sm text-accent underline">
          {t('bp.bank.backToList')}
        </Link>
      </div>
      {detail === null ? (
        <p className="p-4 text-signal-error">{t('bp.bank.detailUnavailable')}</p>
      ) : (
        <dl className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailField label={t('bp.bank.accountHolder')} value={detail.accountHolder || '—'} />
          <DetailField label={t('bp.bank.country')} value={detail.country} />
          <DetailField label={t('bp.bank.bankName')} value={detail.bankName || '—'} />
          <div>
            <dt className="field-label">{t('bp.bank.identifier')}</dt>
            <dd>
              <span aria-label={t('bp.bank.masked')}>{detail.maskedIdentifier}</span>
              <span className="ml-2 text-sm text-ink-soft">
                {t(detail.identifierKind === 'IBAN' ? 'bp.bank.iban' : 'bp.bank.localAccountNumber')}
              </span>
            </dd>
          </div>
          <DetailField label={t('bp.bank.bankCode')} value={detail.bankCode || '—'} />
          <DetailField label={t('bp.bank.bic')} value={detail.bic || '—'} />
          <DetailField label={t('bp.bank.validFrom')} value={detail.validFrom} />
          <DetailField label={t('bp.bank.validTo')} value={detail.validTo || '—'} />
          <DetailField
            label={t('bp.bank.status')}
            value={t(detail.isActive ? 'bp.bank.active' : 'bp.bank.inactive')}
          />
        </dl>
      )}
    </section>
  );
}

function DetailField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="field-label">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

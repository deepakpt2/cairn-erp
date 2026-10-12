import Link from 'next/link';
import { t } from '@/platform/i18n';
import type { PartnerBankMetadata } from '@/modules/foundation/partner-bank-reads';
import { BANK_ACCOUNT_VIEW_MASK } from '@/platform/security/partner-bank-view';

interface PartnerBankMetadataPanelProps {
  readonly partnerNumber: string;
  readonly records: readonly PartnerBankMetadata[] | null;
}

/** Read-only summary view: account identifiers are never passed to this component. */
export function PartnerBankMetadataPanel({ partnerNumber, records }: PartnerBankMetadataPanelProps) {
  return (
    <section className="panel overflow-x-auto" aria-labelledby="partner-bank-title">
      <h2 id="partner-bank-title" className="panel-header panel-title">
        {t('bp.bank.title')}
      </h2>
      <p className="px-3 pb-3 text-sm text-ink-soft">{t('bp.bank.readOnly')}</p>
      {records === null ? (
        <p className="p-4 text-signal-error">{t('bp.bank.unavailable')}</p>
      ) : records.length === 0 ? (
        <p className="p-4">{t('bp.bank.empty')}</p>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th>{t('bp.bank.accountHolder')}</th>
              <th>{t('bp.bank.country')}</th>
              <th>{t('bp.bank.bankName')}</th>
              <th>{t('bp.bank.identifier')}</th>
              <th>{t('bp.bank.bankCode')}</th>
              <th>{t('bp.bank.bic')}</th>
              <th>{t('bp.bank.validFrom')}</th>
              <th>{t('bp.bank.validTo')}</th>
              <th>{t('bp.bank.status')}</th>
              <th>{t('bp.bank.details')}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.bankRecordId}>
                <td>{record.accountHolder || '—'}</td>
                <td>{record.country}</td>
                <td>{record.bankName || '—'}</td>
                <td><span aria-label={t('bp.bank.masked')}>{BANK_ACCOUNT_VIEW_MASK}</span></td>
                <td>{record.bankCode || '—'}</td>
                <td>{record.bic || '—'}</td>
                <td>{record.validFrom}</td>
                <td>{record.validTo || '—'}</td>
                <td>{t(record.isActive ? 'bp.bank.active' : 'bp.bank.inactive')}</td>
                <td>
                  <Link
                    className="text-accent underline"
                    href={`/foundation/partners?partner=${encodeURIComponent(partnerNumber)}&view=BANKS&bank=${encodeURIComponent(record.bankRecordId)}`}
                  >
                    {t('bp.bank.openDetails')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

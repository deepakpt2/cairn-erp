/**
 * Pure normal-view projection for partner-bank identifiers — CAIRN.md D-074 / B-062.
 *
 * This is display-only: it does not authorize a read or reveal, access storage, or
 * decrypt ciphertext. Call it on a server-side record before passing props to a view.
 */
import {
  isPartnerHistoryMaskedField,
  PARTNER_BANK_OBJECT_CLASS,
  projectPartnerHistorySnapshot,
} from '../change/partner-data-history';

export type PartnerBankViewMode = 'list' | 'detail';
export const BANK_ACCOUNT_VIEW_MASK = '••••';

/**
 * Allowlisted bank fields only. Lists show a fixed mask; details add at most the
 * last four characters. Ciphertext columns, unknown fields and nested values never
 * pass through this projection.
 */
export function projectPartnerBankNormalView(
  snapshot: Record<string, unknown> | undefined,
  mode: PartnerBankViewMode,
): Record<string, unknown> | undefined {
  const allowlisted = projectPartnerHistorySnapshot(PARTNER_BANK_OBJECT_CLASS, snapshot);
  if (allowlisted === undefined || snapshot === undefined) return allowlisted;

  const projected: Record<string, unknown> = {};
  for (const [field, safeValue] of Object.entries(allowlisted)) {
    const canonicalField = normalizeFieldName(field);
    if (canonicalField.includes('ciphertext')) continue;

    if (isPartnerHistoryMaskedField(PARTNER_BANK_OBJECT_CLASS, field)) {
      projected[field] = maskIdentifier(snapshot[field], mode);
      continue;
    }

    projected[field] = safeValue;
  }

  return projected;
}

function maskIdentifier(value: unknown, mode: PartnerBankViewMode): unknown {
  if (value === null || value === undefined || value === '') return value;

  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : null;
  if (text === null || mode === 'list') return BANK_ACCOUNT_VIEW_MASK;

  const characters = Array.from(text);
  if (characters.length <= 4) return BANK_ACCOUNT_VIEW_MASK;
  return `${BANK_ACCOUNT_VIEW_MASK}${characters.slice(-4).join('')}`;
}

function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Privacy projection for partner-bank/contact change history — CAIRN.md D-059 / B-057.
 *
 * Only the approved, known field set is retained for these object classes. Sensitive
 * identifiers/contact coordinates are fully masked before the generic serializer.
 */
export const PARTNER_BANK_OBJECT_CLASS = 'partner_bank';
export const PARTNER_CONTACT_OBJECT_CLASS = 'partner_contact';
export const MASKED_HISTORY_VALUE = '[masked]';

const BANK_FIELDS = new Set([
  'accountholder',
  'country',
  'bankname',
  'bankcode',
  'iban',
  'ibanciphertext',
  'localaccountnumber',
  'localaccountnumberciphertext',
  'accountnumber',
  'accountnumberciphertext',
  'accountidentifier',
  'accountidentifierciphertext',
  'bic',
  'swift',
  'bicswift',
  'validfrom',
  'validto',
  'isactive',
]);

const BANK_MASKED_FIELDS = new Set([
  'iban',
  'ibanciphertext',
  'localaccountnumber',
  'localaccountnumberciphertext',
  'accountnumber',
  'accountnumberciphertext',
  'accountidentifier',
  'accountidentifierciphertext',
]);

const CONTACT_FIELDS = new Set([
  'name',
  'title',
  'function',
  'titlefunction',
  'email',
  'emailaddress',
  'contactemail',
  'emailciphertext',
  'contactemailciphertext',
  'phone',
  'phonenumber',
  'contactphone',
  'phoneciphertext',
  'contactphoneciphertext',
  'mobile',
  'mobilephone',
  'validfrom',
  'validto',
  'isactive',
  'isprimary',
]);

const CONTACT_MASKED_FIELDS = new Set([
  'email',
  'emailaddress',
  'contactemail',
  'emailciphertext',
  'contactemailciphertext',
  'phone',
  'phonenumber',
  'contactphone',
  'phoneciphertext',
  'contactphoneciphertext',
  'mobile',
  'mobilephone',
]);

export function isPartnerSensitiveHistoryClass(objectClass: string): boolean {
  return objectClass === PARTNER_BANK_OBJECT_CLASS || objectClass === PARTNER_CONTACT_OBJECT_CLASS;
}

export function isPartnerHistoryMaskedField(objectClass: string, field: string): boolean {
  const canonicalField = normalizeFieldName(field);
  if (objectClass === PARTNER_BANK_OBJECT_CLASS) return BANK_MASKED_FIELDS.has(canonicalField);
  if (objectClass === PARTNER_CONTACT_OBJECT_CLASS) return CONTACT_MASKED_FIELDS.has(canonicalField);
  return false;
}

/**
 * Projects a snapshot to a strict allowlist. Unknown/nested fields are dropped;
 * approved sensitive fields are replaced with one fixed marker, without suffixes.
 */
export function projectPartnerHistorySnapshot(
  objectClass: string,
  snapshot: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (snapshot === undefined || !isPartnerSensitiveHistoryClass(objectClass)) return snapshot;

  const allowed = objectClass === PARTNER_BANK_OBJECT_CLASS ? BANK_FIELDS : CONTACT_FIELDS;
  const masked = objectClass === PARTNER_BANK_OBJECT_CLASS ? BANK_MASKED_FIELDS : CONTACT_MASKED_FIELDS;
  const projected: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(snapshot)) {
    const canonicalField = normalizeFieldName(field);
    if (!allowed.has(canonicalField)) continue;

    if (masked.has(canonicalField)) {
      projected[field] = value === null || value === undefined ? value : MASKED_HISTORY_VALUE;
    } else if (isSafeHistoryScalar(value)) {
      projected[field] = value;
    }
  }

  return projected;
}

/** Reprojects a value already stored in generic history, for safe read-time defense in depth. */
export function projectPartnerHistoryStoredValue(
  objectClass: string,
  field: string,
  storedValue: string | null,
): { included: boolean; value: string | null } {
  const snapshot = projectPartnerHistorySnapshot(objectClass, { [field]: storedValue });
  if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, field)) {
    return { included: false, value: null };
  }

  const value = snapshot[field];
  if (value === null || value === undefined) return { included: true, value: null };
  if (value instanceof Date) return { included: true, value: value.toISOString() };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { included: true, value: String(value) };
  }
  return { included: false, value: null };
}

function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSafeHistoryScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

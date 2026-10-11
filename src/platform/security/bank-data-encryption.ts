/**
 * Bank-data authenticated encryption primitive — CAIRN.md D-067 / B-054.
 *
 * This module deliberately does not load keys, authorize reveals, write history,
 * or access the database. Callers must use a deployment-provisioned keyring and
 * must separately enforce the audited-reveal boundary before decrypting.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isBankRecordId, type BankRecordId } from './bank-record-id';

const ENVELOPE_VERSION = 'cbd1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_CONTEXT_COMPONENT_BYTES = 256;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Canonical key ID grammar shared with the deployment keyring parser. */
export function isBankDataKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID_PATTERN.test(value);
}

export interface BankDataKeyring {
  /** New ciphertext always uses this key; previous keys stay available for reads during rotation. */
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

/** Stable UUIDv4 row/field identity is authenticated so ciphertext cannot be copied to another value. */
export interface BankDataContext {
  readonly client: string;
  readonly partnerNumber: string;
  readonly bankRecordId: BankRecordId;
  readonly field: string;
}

/** Safe error surface: never includes plaintext, ciphertext, context, or key material. */
export class BankDataEncryptionError extends Error {
  readonly code = 'CAIRN_BANK_DATA_CRYPTO_FAILED';

  constructor() {
    super('Bank data encryption or decryption failed.');
    this.name = 'BankDataEncryptionError';
  }
}

/**
 * Encrypts one UTF-8 value using the keyring's active AES-256-GCM key.
 *
 * Envelope: `cbd1.<key-id>.<nonce>.<ciphertext>.<tag>`; all binary fields use
 * canonical unpadded base64url. The context is authenticated as GCM AAD.
 */
export function encryptBankData(
  plaintext: string,
  context: BankDataContext,
  keyring: BankDataKeyring,
): string {
  try {
    if (typeof plaintext !== 'string' || plaintext.length === 0) fail();
    const plaintextBytes = Buffer.from(plaintext, 'utf8');
    if (plaintextBytes.length > MAX_PLAINTEXT_BYTES) fail();

    const keyId = keyring.activeKeyId;
    const key = requiredKey(keyring, keyId);
    const aad = encodeContext(context, keyId);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      keyId,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.');
  } catch {
    throw new BankDataEncryptionError();
  }
}

/**
 * Decrypts an envelope only when its key ID is present and its authenticated
 * tenant/partner/record/field context matches. Authorization and reveal auditing
 * are intentionally the responsibility of a later, separate service boundary.
 */
export function decryptBankData(
  envelope: string,
  context: BankDataContext,
  keyring: BankDataKeyring,
): string {
  try {
    if (typeof envelope !== 'string' || envelope.length > MAX_PLAINTEXT_BYTES * 2) fail();
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) fail();

    const [, keyId, nonceText, ciphertextText, tagText] = parts;
    if (!isBankDataKeyId(keyId)) fail();
    const nonce = decodeBase64Url(nonceText);
    const ciphertext = decodeBase64Url(ciphertextText);
    const tag = decodeBase64Url(tagText);
    if (nonce.length !== NONCE_BYTES || ciphertext.length === 0 || tag.length !== TAG_BYTES) fail();

    const key = requiredKey(keyring, keyId);
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(encodeContext(context, keyId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) fail();

    const decoded = plaintext.toString('utf8');
    // Reject malformed UTF-8 rather than silently substituting replacement characters.
    if (!Buffer.from(decoded, 'utf8').equals(plaintext)) fail();
    return decoded;
  } catch {
    throw new BankDataEncryptionError();
  }
}

/**
 * Re-encrypts an authenticated envelope under the keyring's active key. If the
 * envelope is already current it is still fully decrypted/verified before the
 * original envelope is returned. This pure helper never persists or logs data.
 */
export function reencryptBankData(
  envelope: string,
  context: BankDataContext,
  keyring: BankDataKeyring,
): string {
  try {
    const priorKeyId = typeof envelope === 'string' ? envelope.split('.')[1] : undefined;
    const plaintext = decryptBankData(envelope, context, keyring);
    if (priorKeyId === keyring.activeKeyId) return envelope;
    return encryptBankData(plaintext, context, keyring);
  } catch {
    throw new BankDataEncryptionError();
  }
}

export interface BankDataReencryptionRecord {
  readonly client: string;
  readonly partnerNumber: string;
  readonly bankRecordId: BankRecordId;
  /** Encrypted field envelopes only; null values remain null. */
  readonly fields: Readonly<Record<string, string | null>>;
}

export interface BankDataReencryptionBatchResult {
  readonly records: readonly BankDataReencryptionRecord[];
  readonly reencryptedFieldCount: number;
}

/**
 * Purely transforms one caller-bounded batch of encrypted rows to the active
 * key. It returns ciphertext only and performs no database reads/writes, logging,
 * history updates, or old-key retirement verification.
 */
export function reencryptBankDataBatch(
  records: readonly BankDataReencryptionRecord[],
  keyring: BankDataKeyring,
): BankDataReencryptionBatchResult {
  if (!Array.isArray(records)) fail();

  let reencryptedFieldCount = 0;
  const nextRecords = records.map((record) => {
    if (!record || typeof record !== 'object' || !isBankRecordId(record.bankRecordId)) fail();
    if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) fail();

    const fields: Record<string, string | null> = {};
    for (const [field, envelope] of Object.entries(record.fields)) {
      if (envelope === null) {
        fields[field] = null;
        continue;
      }
      if (typeof envelope !== 'string') fail();

      const transformed = reencryptBankData(envelope, {
        client: record.client,
        partnerNumber: record.partnerNumber,
        bankRecordId: record.bankRecordId,
        field,
      }, keyring);
      if (transformed !== envelope) reencryptedFieldCount += 1;
      fields[field] = transformed;
    }

    return {
      client: record.client,
      partnerNumber: record.partnerNumber,
      bankRecordId: record.bankRecordId,
      fields,
    };
  });

  return { records: nextRecords, reencryptedFieldCount };
}

export interface BankDataActiveKeyVerificationResult {
  readonly activeKeyId: string;
  readonly recordCount: number;
  readonly encryptedFieldCount: number;
}

/**
 * Authenticates every non-null envelope in one supplied batch using a keyring
 * containing only the active key. This verifies only the supplied batch; it does
 * not prove that a database scan was complete or that prior keys can be retired.
 */
export function verifyBankDataBatchOnActiveKey(
  records: readonly BankDataReencryptionRecord[],
  activeOnlyKeyring: BankDataKeyring,
): BankDataActiveKeyVerificationResult {
  if (!Array.isArray(records)) fail();
  if (
    !activeOnlyKeyring ||
    !activeOnlyKeyring.keys ||
    activeOnlyKeyring.keys.size !== 1 ||
    !activeOnlyKeyring.keys.has(activeOnlyKeyring.activeKeyId)
  ) {
    fail();
  }
  requiredKey(activeOnlyKeyring, activeOnlyKeyring.activeKeyId);

  let encryptedFieldCount = 0;
  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      typeof record.client !== 'string' ||
      record.client.length === 0 ||
      typeof record.partnerNumber !== 'string' ||
      record.partnerNumber.length === 0 ||
      !isBankRecordId(record.bankRecordId) ||
      !record.fields ||
      typeof record.fields !== 'object' ||
      Array.isArray(record.fields)
    ) {
      fail();
    }

    for (const [field, envelope] of Object.entries(record.fields)) {
      if (envelope === null) continue;
      if (typeof envelope !== 'string' || envelope.split('.')[1] !== activeOnlyKeyring.activeKeyId) fail();
      decryptBankData(envelope, {
        client: record.client,
        partnerNumber: record.partnerNumber,
        bankRecordId: record.bankRecordId,
        field,
      }, activeOnlyKeyring);
      encryptedFieldCount += 1;
    }
  }

  return {
    activeKeyId: activeOnlyKeyring.activeKeyId,
    recordCount: records.length,
    encryptedFieldCount,
  };
}

function requiredKey(keyring: BankDataKeyring, keyId: string): Buffer {
  if (!keyring || !keyring.keys || !isBankDataKeyId(keyId)) fail();
  const material = keyring.keys.get(keyId);
  if (!(material instanceof Uint8Array) || material.byteLength !== KEY_BYTES) fail();
  return Buffer.from(material);
}

function encodeContext(context: BankDataContext, keyId: string): Buffer {
  if (!context || typeof context !== 'object' || !isBankDataKeyId(keyId)) fail();
  if (!isBankRecordId(context.bankRecordId)) fail();
  const components = [context.client, context.partnerNumber, context.bankRecordId];
  for (const component of components) {
    if (
      typeof component !== 'string' ||
      component.length === 0 ||
      Buffer.byteLength(component, 'utf8') > MAX_CONTEXT_COMPONENT_BYTES
    ) {
      fail();
    }
  }
  if (typeof context.field !== 'string' || !FIELD_PATTERN.test(context.field)) fail();

  return Buffer.from(
    JSON.stringify([ENVELOPE_VERSION, keyId, context.client, context.partnerNumber, context.bankRecordId, context.field]),
    'utf8',
  );
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) fail();
  return decoded;
}

function fail(): never {
  throw new BankDataEncryptionError();
}

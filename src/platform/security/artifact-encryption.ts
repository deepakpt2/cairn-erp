/**
 * Authenticated encryption for large private artifacts (payment CSVs) — CAIRN.md D-067 pattern, extended to
 * payloads larger than a bank field.
 *
 * The bank-data primitive caps a plaintext at 4 KB (it protects account values). A generated salary CSV is
 * larger, so this module reuses the SAME deployment keyring and AES-256-GCM authenticated envelope, with its own
 * version tag (`cad1`) and a size cap, and binds the ciphertext to tenant + artifact id + field as AAD. It never
 * loads keys, touches storage or logs plaintext; callers supply the keyring.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { isBankDataKeyId, type BankDataKeyring } from './bank-data-encryption';

const VERSION = 'cad1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface ArtifactContext {
  readonly client: string;
  readonly artifactId: string;
  readonly field: string;
}

export class ArtifactEncryptionError extends Error {
  readonly code = 'CAIRN_ARTIFACT_CRYPTO_FAILED';
  constructor() {
    super('Artifact encryption or decryption failed.');
    this.name = 'ArtifactEncryptionError';
  }
}

/** Encrypt one artifact under the keyring's active key. Returns the envelope text; never a plaintext. */
export function encryptArtifact(plaintext: Buffer, context: ArtifactContext, keyring: BankDataKeyring): string {
  try {
    if (!Buffer.isBuffer(plaintext) || plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) fail();
    const keyId = keyring.activeKeyId;
    if (!isBankDataKeyId(keyId)) fail();
    const key = requiredKey(keyring, keyId);
    const aad = encodeContext(context, keyId);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, keyId, nonce.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
  } catch {
    throw new ArtifactEncryptionError();
  }
}

/** Decrypt one artifact, verified against its keyring key and authenticated tenant/artifact context. */
export function decryptArtifact(envelope: string, context: ArtifactContext, keyring: BankDataKeyring): Buffer {
  try {
    if (typeof envelope !== 'string' || envelope.length > MAX_PLAINTEXT_BYTES * 2) fail();
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) fail();
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
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new ArtifactEncryptionError();
  }
}

function requiredKey(keyring: BankDataKeyring, keyId: string): Buffer {
  if (!keyring || !keyring.keys || !isBankDataKeyId(keyId)) fail();
  const material = keyring.keys.get(keyId);
  if (!(material instanceof Uint8Array) || material.byteLength !== KEY_BYTES) fail();
  return Buffer.from(material);
}

function encodeContext(context: ArtifactContext, keyId: string): Buffer {
  if (!context || typeof context !== 'object') fail();
  for (const c of [context.client, context.artifactId]) {
    if (typeof c !== 'string' || c.length === 0 || Buffer.byteLength(c, 'utf8') > 256) fail();
  }
  if (typeof context.field !== 'string' || !FIELD_PATTERN.test(context.field)) fail();
  return Buffer.from(JSON.stringify([VERSION, keyId, context.client, context.artifactId, context.field]), 'utf8');
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) fail();
  return decoded;
}

function fail(): never {
  throw new ArtifactEncryptionError();
}

export const ARTIFACT_KEY_ID_PATTERN = KEY_ID_PATTERN;

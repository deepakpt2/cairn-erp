/**
 * Retention of generated salary payment CSVs in private host storage, with safe metadata.
 *
 * `retainArtifact` encrypts the exact bytes, writes them durably (atomic rename) and records the metadata row
 * **after** the file is durable. It is called inside the same database transaction that commits the prepared
 * file / approved replacement, so a committed owner row always has an artifact; a failure leaves no published
 * file. Because the filesystem and the database commit are not one transaction, the write is published to a
 * unique artifact id and the transaction rolls back cleanly if anything later fails — an orphaned encrypted file
 * (never a partial one) may be left, and `deleteArtifact` removes it on the rollback path.
 *
 * `readArtifact` returns the exact plaintext bytes only after the caller has authorized the download; it verifies
 * the plaintext SHA-256. The artifact row is looked up by owner (FILE + preparation_id, or REISSUE + reissue_id).
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { type BankDataKeyring } from '../../platform/security/bank-data-encryption';
import { ArtifactEncryptionError, decryptArtifact, encryptArtifact } from '../../platform/security/artifact-encryption';
import { type StoredArtifactRef, readStoredArtifact, writeEncryptedArtifact } from '../../platform/security/artifact-store';
import { payrollPaymentArtifact } from './schema';

export class ArtifactError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ARTIFACT') {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}

export type ArtifactOwnerKind = 'FILE' | 'REISSUE';

const artifactField = 'paymentCsv';

/**
 * Encrypt and durably store the exact plaintext bytes, then insert the metadata row. Returns the artifact id.
 * The caller commits its owner row in the same transaction; a thrown error rolls back the metadata and the
 * caller may call `deleteArtifact` for the published orphan.
 */
export async function retainArtifact(
  tx: Tx,
  input: {
    client: string;
    ownerKind: ArtifactOwnerKind;
    ownerId: string;
    fileReference: string;
    bytes: Buffer;
    keyring: BankDataKeyring;
    changedBy: string;
  },
): Promise<{ artifactId: string; stored: StoredArtifactRef }> {
  const artifactId = randomUUID();
  const plaintextSha256 = createHash('sha256').update(input.bytes).digest('hex');
  let envelope: string;
  try {
    envelope = encryptArtifact(input.bytes, { client: input.client, artifactId, field: artifactField }, input.keyring);
  } catch (error) {
    if (error instanceof ArtifactEncryptionError) throw new ArtifactError('The payment file could not be encrypted for storage.', 'ARTIFACT_ENCRYPT');
    throw error;
  }
  // Publish the file BEFORE the metadata row, so a committed row always points at a durable file.
  let stored: StoredArtifactRef;
  try {
    stored = writeEncryptedArtifact(input.client, artifactId, envelope);
  } catch (error) {
    if (error instanceof Error) throw new ArtifactError(`${error.message}`, 'ARTIFACT_WRITE');
    throw error;
  }
  await tx.insert(payrollPaymentArtifact).values({
    client: input.client,
    artifactId,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    fileReference: input.fileReference,
    storagePath: stored.relativePath,
    storageFormat: 'cad1',
    keyId: input.keyring.activeKeyId,
    plaintextSha256,
    byteLength: input.bytes.length,
    generation: 1,
    createdBy: input.changedBy,
  });
  return { artifactId, stored };
}

export interface ArtifactRecord {
  artifactId: string;
  ownerKind: ArtifactOwnerKind;
  ownerId: string;
  fileReference: string;
  storagePath: string;
  keyId: string;
  plaintextSha256: string;
  byteLength: number;
}

/** The artifact metadata for one owner, or null. */
export async function artifactOf(tx: Tx, client: string, ownerKind: ArtifactOwnerKind, ownerId: string): Promise<ArtifactRecord | null> {
  const [row] = await tx.select().from(payrollPaymentArtifact)
    .where(and(
      eq(payrollPaymentArtifact.client, client),
      eq(payrollPaymentArtifact.ownerKind, ownerKind),
      eq(payrollPaymentArtifact.ownerId, ownerId),
    )).limit(1);
  if (!row) return null;
  return {
    artifactId: row.artifactId,
    ownerKind: row.ownerKind as ArtifactOwnerKind,
    ownerId: row.ownerId,
    fileReference: row.fileReference,
    storagePath: row.storagePath,
    keyId: row.keyId,
    plaintextSha256: row.plaintextSha256,
    byteLength: row.byteLength,
  };
}

/**
 * Read and verify the retained bytes. Returns null when the artifact row is absent or the file is missing or
 * unreadable — the caller fails closed. Never falls back to a freshly computed file: it is the retained original.
 */
export function readArtifact(record: ArtifactRecord, client: string, keyring: BankDataKeyring): Buffer | null {
  const envelope = readStoredArtifact(record.storagePath);
  if (!envelope) return null;
  let bytes: Buffer;
  try {
    bytes = decryptArtifact(envelope, { client, artifactId: record.artifactId, field: artifactField }, keyring);
  } catch {
    return null;
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== record.plaintextSha256) return null; // integrity mismatch: never serve wrong bytes
  return bytes;
}

/**
 * Retention of generated salary payment CSVs in private host storage, with safe metadata, plus reconciliation of
 * the filesystem/database gap and a conservative legacy backfill.
 *
 * Crash-safe ordering: `retainArtifact` encrypts, durably publishes the file (write → fsync → atomic rename →
 * fsync dir), THEN inserts the metadata row inside the caller's transaction. A committed owner row therefore
 * always has a durable file. If the transaction later fails, the metadata rolls back and an encrypted orphan
 * `.enc` may remain; `sweepOrphans` removes such files safely after a grace period.
 *
 * Why a marker, not "absent = legacy": an owner row that should have a NEW artifact but whose metadata is missing
 * must FAIL CLOSED, not silently fall back to a rebuilt CSV. `payroll_payment_artifact_state` records, per owner,
 * whether artifact retention applies (`cad1`) — a NEW owner is marked in the same transaction; only an owner with
 * NO marker at all is genuinely legacy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { type BankDataKeyring } from '../../platform/security/bank-data-encryption';
import { ArtifactEncryptionError, decryptArtifact, encryptArtifact } from '../../platform/security/artifact-encryption';
import {
  type StoredArtifactRef, readStoredArtifact, writeEncryptedArtifact, deleteArtifact,
  listTenantArtifacts, listStaleStaging, deleteStagingFile,
} from '../../platform/security/artifact-store';
import { lockArtifactStoreExclusive, lockArtifactStoreShared } from './payment-file-locks';
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
export const ARTIFACT_FORMAT = 'cad1' as const;

const artifactField = 'paymentCsv';

/** Marker table rows: `ownerKind + ownerId` has `format='cad1'` once retention applies to it. */
async function markOwner(tx: Tx, client: string, ownerKind: ArtifactOwnerKind, ownerId: string, changedBy: string): Promise<void> {
  await tx.execute(sql`
    insert into payroll_payment_artifact_state (client, owner_kind, owner_id, format, changed_by, changed_at)
    values (${client}, ${ownerKind}, ${ownerId}, ${ARTIFACT_FORMAT}, ${changedBy}, now())
    on conflict (client, owner_kind, owner_id) do nothing`);
}

/** Whether artifact retention applies to this owner (a NEW-format row). False means genuinely legacy. */
export async function ownerRequiresArtifact(tx: Tx, client: string, ownerKind: ArtifactOwnerKind, ownerId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    select 1 from payroll_payment_artifact_state
     where client = ${client} and owner_kind = ${ownerKind} and owner_id = ${ownerId} and format = ${ARTIFACT_FORMAT}
     limit 1`);
  return (rows as unknown as unknown[]).length > 0;
}

/**
 * Encrypt and durably store the exact bytes, mark the owner as new-format, then insert the metadata row. All in
 * the caller's transaction. Throws if storage/encryption fails, so the caller rolls back (and never advertises a
 * ready file whose artifact is missing).
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
  // Serialise with the orphan sweeper: held (shared) until this transaction commits or rolls back, BEFORE any
  // file is written, so a file this call publishes can never be seen as an orphan while it is in flight.
  await lockArtifactStoreShared(tx, input.client);
  const artifactId = randomUUID();
  const plaintextSha256 = createHash('sha256').update(input.bytes).digest('hex');
  let envelope: string;
  try {
    envelope = encryptArtifact(input.bytes, { client: input.client, artifactId, field: artifactField }, input.keyring);
  } catch (error) {
    if (error instanceof ArtifactEncryptionError) throw new ArtifactError('The payment file could not be encrypted for storage.', 'ARTIFACT_ENCRYPT');
    throw error;
  }
  let stored: StoredArtifactRef;
  try {
    stored = writeEncryptedArtifact(input.client, artifactId, envelope);
  } catch (error) {
    if (error instanceof Error) throw new ArtifactError(error.message, 'ARTIFACT_WRITE');
    throw error;
  }
  // Mark the owner BEFORE the metadata insert, in this transaction, so a committed owner is known to require an
  // artifact even if a later migration/reader sees the row and the metadata separately.
  await markOwner(tx, input.client, input.ownerKind, input.ownerId, input.changedBy);
  await tx.insert(payrollPaymentArtifact).values({
    client: input.client,
    artifactId,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    fileReference: input.fileReference,
    storagePath: stored.relativePath,
    storageFormat: ARTIFACT_FORMAT,
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
 * Read and verify the retained bytes. Returns null when the artifact row is absent or the file is missing,
 * unreadable or fails its integrity check — the caller fails closed. Never falls back to a freshly computed file.
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
  if (sha !== record.plaintextSha256) return null;
  return bytes;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface SweepResult {
  /** Published `.enc` files with no committed metadata row, older than the grace period, removed. */
  orphanedRemoved: number;
  /** Stale staging temp files removed. */
  stagingRemoved: number;
}

/**
 * Remove encrypted leftovers that no committed row references, and stale staging temps.
 *
 * The SAFETY mechanism is the exclusive tenant-scoped advisory lock: acquiring it first waits until every
 * publisher's shared lock has been released, i.e. every in-flight publish transaction has committed or rolled
 * back. Only then does this transaction list the directory and read references. Under READ COMMITTED (the
 * connection default) the reference `select` is a fresh statement that sees every commit made before the lock
 * was granted, so a publisher that committed is never treated as an orphan. The grace period is kept only as an
 * additional conservative condition (it lets an ordinary `.enc` published by a crashed transaction age out), and
 * is NOT what protects an in-flight publisher.
 *
 * This never deletes a committed artifact, and a crashed publisher's orphan is removed on a later sweep. If the
 * sweep transaction dies mid-way, its lock releases and any deletions already made were of unreferenced files.
 */
export async function sweepOrphans(tx: Tx, client: string, options: { graceMs?: number; now?: number } = {}): Promise<SweepResult> {
  // The safety argument needs READ COMMITTED: after waiting for the exclusive lock, the reference SELECT must be a
  // FRESH statement that sees every publisher commit. Under REPEATABLE READ the transaction snapshot was taken
  // earlier, so waiting does not refresh it — refuse rather than delete on a stale snapshot.
  const isolation = (await tx.execute(sql`select current_setting('transaction_isolation') as isolation`)) as unknown as Array<{ isolation: string }>;
  if (String(isolation[0]?.isolation ?? '').toLowerCase() !== 'read committed') {
    throw new ArtifactError('The orphan sweep requires a READ COMMITTED transaction.', 'ARTIFACT_ISOLATION');
  }
  // Must be the first lock statement of the sweep transaction: block until no publisher holds the shared lock.
  await lockArtifactStoreExclusive(tx, client);
  const graceMs = options.graceMs ?? 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  let orphanedRemoved = 0;
  let stagingRemoved = 0;

  for (const temp of listStaleStaging(client, graceMs, now)) {
    deleteStagingFile(temp);
    stagingRemoved += 1;
  }

  // Fresh statement after the exclusive lock was granted: under READ COMMITTED this sees every commit that
  // happened while we waited.
  const candidates = listTenantArtifacts(client).filter((f) => now - f.modifiedMs > graceMs);
  if (candidates.length === 0) return { orphanedRemoved, stagingRemoved };
  const ids = candidates.map((c) => c.artifactId);
  const referenced = await tx.execute(sql`
    select artifact_id::text as artifact_id from payroll_payment_artifact
     where client = ${client} and artifact_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  const known = new Set((referenced as unknown as Array<{ artifact_id: string }>).map((r) => r.artifact_id));
  for (const candidate of candidates) {
    if (known.has(candidate.artifactId)) continue; // committed: never delete
    deleteArtifact(candidate.relativePath);
    orphanedRemoved += 1;
  }
  return { orphanedRemoved, stagingRemoved };
}

// ── Legacy backfill ──────────────────────────────────────────────────────────

export interface BackfillOutcome {
  ownerKind: ArtifactOwnerKind;
  ownerId: string;
  result: 'already-retained' | 'backfilled-from-body' | 'backfilled-from-snapshot' | 'unverifiable' | 'not-found';
  sha256?: string;
}

/**
 * Retain EXACT legacy bytes where their integrity can be checked, without mutating the legacy evidence.
 *
 * - A legacy ORIGINAL with a stored plaintext body: verified against its stored checksum; if it matches, the
 *   exact bytes are encrypted and retained (the body row is left untouched).
 * - A legacy ORIGINAL with a bank snapshot but no body, or a legacy REISSUE: the caller must supply the bytes it
 *   can deterministically reconstruct AND the checksum they must match. If they match the stored evidence, they
 *   are retained; otherwise nothing is written and the outcome is `unverifiable` (no silent claim of equality).
 *
 * Never recalculates payroll, never rewrites old evidence, never stores plaintext. Repeatable: an owner already
 * retained is reported and skipped.
 */
export async function backfillLegacyArtifact(
  tx: Tx,
  input: {
    client: string;
    ownerKind: ArtifactOwnerKind;
    ownerId: string;
    fileReference: string;
    /** The exact bytes (already determined to be the issued file), and the stored checksum they must match. */
    bytes: Buffer;
    expectedSha256: string;
    /** Where the bytes came from — for an operator-facing report, never derived from new calculation. */
    source?: 'body' | 'snapshot';
    keyring: BankDataKeyring;
    changedBy: string;
  },
): Promise<BackfillOutcome> {
  if (await artifactOf(tx, input.client, input.ownerKind, input.ownerId)) {
    return { ownerKind: input.ownerKind, ownerId: input.ownerId, result: 'already-retained' };
  }
  const actualSha = createHash('sha256').update(input.bytes).digest('hex');
  if (actualSha !== input.expectedSha256) {
    return { ownerKind: input.ownerKind, ownerId: input.ownerId, result: 'unverifiable' };
  }
  await retainArtifact(tx, {
    client: input.client, ownerKind: input.ownerKind, ownerId: input.ownerId, fileReference: input.fileReference,
    bytes: input.bytes, keyring: input.keyring, changedBy: input.changedBy,
  });
  return {
    ownerKind: input.ownerKind, ownerId: input.ownerId,
    result: input.source === 'snapshot' ? 'backfilled-from-snapshot' : 'backfilled-from-body', sha256: actualSha,
  };
}

/** Whether any owner among these ids has artifact metadata (used by a status view that must never read content). */
export async function artifactIdsFor(tx: Tx, client: string, ownerKind: ArtifactOwnerKind, ownerIds: readonly string[]): Promise<Set<string>> {
  if (ownerIds.length === 0) return new Set();
  const rows = await tx.select({ ownerId: payrollPaymentArtifact.ownerId }).from(payrollPaymentArtifact)
    .where(and(eq(payrollPaymentArtifact.client, client), eq(payrollPaymentArtifact.ownerKind, ownerKind), inArray(payrollPaymentArtifact.ownerId, [...ownerIds])));
  return new Set(rows.map((r) => r.ownerId));
}

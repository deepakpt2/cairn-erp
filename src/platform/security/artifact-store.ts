/**
 * Private host storage for generated salary payment artifacts (original files and approved replacements).
 *
 * A deployment configures `CAIRN_PAYMENT_FILE_DIR` to a durable, host-mounted directory OUTSIDE the web root
 * and source checkout. The stored file is the artifact's authenticated AES-256-GCM envelope (see
 * `artifact-encryption.ts`) — never a plaintext CSV. The path is derived only from a server-generated artifact
 * id (`<tenant>/<artifactId>.enc`), never a client-supplied fragment, so there is no traversal surface. The
 * directory and files are created 0700/0600 where the platform permits.
 *
 * Crash-safety: the envelope is written to a private temp file in the same directory, fsynced, then atomically
 * renamed into place. A failure leaves no half-written published file; a retry overwrites nothing (the artifact
 * id is unique, and `existsSync` is used to refuse a silent overwrite). Filesystems and database commits are not
 * atomic together, so the database record is published only after the artifact is durable; a committed row with
 * a missing file fails closed at download with an actionable message.
 *
 * Persistence is NOT implied by a path: the deployment must mount a durable volume there, shared by every app
 * instance that may read the artifact (or use a shared host-mounted volume consistent across instances).
 */
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const PAYMENT_FILE_STORAGE_ENV = 'CAIRN_PAYMENT_FILE_DIR';

export class ArtifactStoreError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ARTIFACT_STORE') {
    super(message);
    this.name = 'ArtifactStoreError';
    this.code = code;
  }
}

/** The configured private directory, or null when the deployment has not set one (fail closed for storage). */
export function paymentFileStorageDir(): string | null {
  const dir = (process.env[PAYMENT_FILE_STORAGE_ENV] ?? '').trim();
  return dir.length > 0 ? dir : null;
}

function requireDir(): string {
  const dir = paymentFileStorageDir();
  if (!dir) fail(`Payment-file storage is not configured.`, 'Set CAIRN_PAYMENT_FILE_DIR to a durable, host-mounted private directory (see the deployment guide), then retry.');
  return dir;
}

/** Plaintext never touches disk: the caller passes the ENCRYPTED envelope text. */
export type StoredArtifactRef = { relativePath: string };

/**
 * Write an encrypted artifact durably and atomically. Refuses to overwrite an existing artifact. Returns the
 * relative path stored in the database (never absolute, never a URL).
 */
export function writeEncryptedArtifact(client: string, artifactId: string, envelope: string): StoredArtifactRef {
  const root = requireDir();
  if (!/^[A-Za-z0-9]{2,4}$/.test(client)) fail('The tenant key is not valid for storage.');
  if (!/^[0-9a-f-]{36}$/.test(artifactId)) fail('The artifact id is not valid for storage.');
  const tenantDir = join(root, client);
  const relativePath = join(client, `${artifactId}.enc`);
  const absolute = join(root, relativePath);
  try {
    if (!existsSync(tenantDir)) mkdirSync(tenantDir, { recursive: true, mode: 0o700 });
    if (existsSync(absolute)) throw new ArtifactStoreError('An artifact with this id already exists; refusing to overwrite it.', 'ARTIFACT_EXISTS');
    const temporary = join(tenantDir, `.${artifactId}.${process.pid}.${Date.now()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, envelope, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, 0o600);
    // Atomic publish: readers see the old state or the complete new file, never a partial one.
    renameSync(temporary, absolute);
    return { relativePath };
  } catch (error) {
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactStoreError('The payment-file artifact could not be stored.', 'ARTIFACT_WRITE');
  }
}

/** Read the stored envelope. Returns null when unconfigured, missing or unreadable — the caller fails closed. */
export function readStoredArtifact(relativePath: string): string | null {
  const dir = paymentFileStorageDir();
  if (!dir) return null;
  // Only ever a server-written relative path of the shape `<tenant>/<uuid>.enc`.
  if (!/^[A-Za-z0-9]{2,4}\/[0-9a-f-]{36}\.enc$/.test(relativePath.replaceAll('\\', '/'))) return null;
  const absolute = join(dir, relativePath);
  try {
    if (!statSync(absolute).isFile()) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/** Whether the artifact file stands, for a status that never reads its content. */
export function artifactExists(relativePath: string): boolean {
  const dir = paymentFileStorageDir();
  if (!dir) return false;
  if (!/^[A-Za-z0-9]{2,4}\/[0-9a-f-]{36}\.enc$/.test(relativePath.replaceAll('\\', '/'))) return false;
  try {
    return statSync(join(dir, relativePath)).isFile();
  } catch {
    return false;
  }
}

/** Remove an artifact (used only for orphan cleanup of a file a failed commit never referenced). */
export function deleteArtifact(relativePath: string): void {
  const dir = paymentFileStorageDir();
  if (!dir) return;
  if (!/^[A-Za-z0-9]{2,4}\/[0-9a-f-]{36}\.enc$/.test(relativePath.replaceAll('\\', '/'))) return;
  try {
    unlinkSync(join(dir, relativePath));
  } catch {
    // An already-missing orphan is the goal; nothing to do.
  }
}

function fail(message: string, remedy?: string, code = 'ARTIFACT_STORE'): never {
  throw new ArtifactStoreError(remedy ? `${message} ${remedy}` : message, code);
}

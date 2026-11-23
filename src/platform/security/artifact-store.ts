/**
 * Private host storage for generated salary payment artifacts (original files and approved replacements).
 *
 * A deployment configures `CAIRN_PAYMENT_FILE_DIR` to a durable, host-mounted directory OUTSIDE the web root
 * and source checkout. The stored file is the artifact's authenticated AES-256-GCM envelope (see
 * `artifact-encryption.ts`) — never a plaintext CSV. The path is derived only from a server-generated artifact
 * id (`<tenant>/<artifactId>.enc`), never a client-supplied fragment, so there is no traversal surface. The
 * directory and files are created 0700/0600 where the platform permits.
 *
 * Durability/crash-safety of a single publish:
 *  1. Write the envelope to a private STAGING file (`<tenant>/.staging/`), in the same filesystem so the later
 *     rename is atomic; every byte is written (a short write is retried) and the file is fsynced.
 *  2. Atomically rename it to `<tenant>/<artifactId>.enc`.
 *  3. fsync the TENANT DIRECTORY, so the rename's directory entry is durable too (a file fsync alone does not
 *     guarantee that a power loss preserves the name). Newly created tenant/staging directories also have their
 *     PARENT flushed, so the directory entry itself survives (see the note on filesystem limits below).
 * A crash leaves at most a staging temp (never a partial published file) or a fully written `.enc`. Refusing to
 * overwrite means a retry can never corrupt a published artifact.
 *
 * The filesystem and the database commit are NOT one atomic transaction. The caller therefore publishes the file
 * first and commits the metadata row afterwards; an orphan `.enc` (no metadata row) can remain if the commit
 * fails. `payroll-payment-artifacts.ts` reconciles those safely (see `sweepOrphans`), and `deleteArtifact` is only
 * ever called for a file proven unreferenced.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const PAYMENT_FILE_STORAGE_ENV = 'CAIRN_PAYMENT_FILE_DIR';
const STAGING_DIR = '.staging';

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
  if (!dir) fail('Payment-file storage is not configured.', 'Set CAIRN_PAYMENT_FILE_DIR to a durable, host-mounted private directory (see the deployment guide), then retry.');
  return dir;
}

/** Plaintext never touches disk: the caller passes the ENCRYPTED envelope text. */
export type StoredArtifactRef = { relativePath: string };

/** Write every byte, retrying a short write, and confirm the on-disk length matches. */
function writeFully(fd: number, data: string): void {
  const buffer = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (written <= 0) throw new ArtifactStoreError('The payment-file artifact could not be fully written.', 'ARTIFACT_WRITE');
    offset += written;
  }
  const size = fstatSync(fd).size;
  if (size !== buffer.length) throw new ArtifactStoreError('The payment-file artifact was written incompletely.', 'ARTIFACT_WRITE');
}

/** fsync a directory so a rename inside it is durable across power loss. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Write an encrypted artifact durably and atomically. Refuses to overwrite an existing artifact. Returns the
 * relative path stored in the database (never absolute, never a URL).
 */
export function writeEncryptedArtifact(client: string, artifactId: string, envelope: string): StoredArtifactRef {
  const root = requireDir();
  if (!/^[A-Za-z0-9]{2,4}$/.test(client)) fail('The tenant key is not valid for storage.');
  if (!/^[0-9a-f-]{36}$/.test(artifactId)) fail('The artifact id is not valid for storage.');
  const tenantDir = join(root, client);
  const stagingDir = join(tenantDir, STAGING_DIR);
  const relativePath = join(client, `${artifactId}.enc`);
  const absolute = join(root, relativePath);
  const staging = join(stagingDir, `${artifactId}.${process.pid}.${Date.now()}.tmp`);
  try {
    // Create the tenant/staging directories and make their PARENT entries durable: flushing the tenant directory
    // after a rename does not persist its own entry in the root.
    //
    // ALWAYS flush, never "only if this call created it". Publishers run concurrently under a SHARED lock, so a
    // conditional skip would let writer B trust a tenant directory that writer A created but has not yet flushed;
    // if A died, B's published file could reference a directory entry that is not durable. One extra directory
    // fsync per publication is cheap for this workload. This is a POSIX best-effort: on a filesystem that does not
    // persist directory fsync (some network filesystems), the platform cannot promise more than it provides.
    mkdirSync(tenantDir, { recursive: true, mode: 0o700 });
    fsyncDir(root);
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    fsyncDir(tenantDir);
    if (existsSync(absolute)) throw new ArtifactStoreError('An artifact with this id already exists; refusing to overwrite it.', 'ARTIFACT_EXISTS');
    const fd = openSync(staging, 'wx', 0o600);
    try {
      writeFully(fd, envelope);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(staging, 0o600);
    // Atomic publish: readers see nothing or the complete file, never a partial one.
    renameSync(staging, absolute);
    // Make the rename durable: flush the directory entry, not just the file contents.
    fsyncDir(tenantDir);
    return { relativePath };
  } catch (error) {
    // Best-effort removal of a staging temp this attempt created; never touches a published file.
    try { unlinkSync(staging); } catch { /* already gone */ }
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactStoreError('The payment-file artifact could not be stored.', 'ARTIFACT_WRITE');
  }
}

/** Read the stored envelope. Returns null when unconfigured, missing or unreadable — the caller fails closed. */
export function readStoredArtifact(relativePath: string): string | null {
  const dir = paymentFileStorageDir();
  if (!dir) return null;
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

/** Remove an artifact. Only ever called for a file proven to have no committed reference. */
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

export interface StoredFileEntry {
  artifactId: string;
  relativePath: string;
  modifiedMs: number;
}

/** List the published `.enc` files of one tenant with their mtimes, for reconciliation. */
export function listTenantArtifacts(client: string): StoredFileEntry[] {
  const root = paymentFileStorageDir();
  if (!root || !/^[A-Za-z0-9]{2,4}$/.test(client)) return [];
  const tenantDir = join(root, client);
  let names: string[];
  try {
    names = readdirSync(tenantDir);
  } catch {
    return [];
  }
  const entries: StoredFileEntry[] = [];
  for (const name of names) {
    const match = /^([0-9a-f-]{36})\.enc$/.exec(name);
    if (!match) continue;
    try {
      const stat = statSync(join(tenantDir, name));
      if (stat.isFile()) entries.push({ artifactId: match[1]!, relativePath: join(client, name), modifiedMs: stat.mtimeMs });
    } catch {
      // Vanished mid-scan: nothing to reconcile.
    }
  }
  return entries;
}

/** List stale staging temp files of one tenant older than `olderThanMs`, for cleanup. */
export function listStaleStaging(client: string, olderThanMs: number, now = Date.now()): string[] {
  const root = paymentFileStorageDir();
  if (!root || !/^[A-Za-z0-9]{2,4}$/.test(client)) return [];
  const stagingDir = join(root, client, STAGING_DIR);
  let names: string[];
  try {
    names = readdirSync(stagingDir);
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    try {
      const stat = statSync(join(stagingDir, name));
      if (stat.isFile() && now - stat.mtimeMs > olderThanMs) stale.push(join(stagingDir, name));
    } catch {
      // Vanished: fine.
    }
  }
  return stale;
}

/** Remove a stale staging temp file (never a published artifact). */
export function deleteStagingFile(absolutePath: string): void {
  try { unlinkSync(absolutePath); } catch { /* gone */ }
}

function fail(message: string, remedy?: string, code = 'ARTIFACT_STORE'): never {
  throw new ArtifactStoreError(remedy ? `${message} ${remedy}` : message, code);
}

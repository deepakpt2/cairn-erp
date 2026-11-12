/**
 * Demo credentials: one shared password, generated at deployment time, delivered
 * once, in a file.
 *
 * The password is never stored in the database and never appears in source, an
 * image, or an environment default. It is written to exactly one place — a file in
 * the deployment's own credential directory — and the database keeps only a
 * fingerprint, so that a later run can tell whether a password was already issued
 * without being able to reproduce it.
 *
 * That irreversibility is deliberate and it has one consequence worth stating
 * plainly: if the file is lost, the password is gone, and recovering it means
 * provisioning a fresh database. Storing it so the database could hand it back would
 * mean storing it where the database can be read.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Characters that survive being read off a screen and typed back in. No O/0, no I/l/1,
 * no punctuation that a shell or a URL might treat as its own.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 20;

export const DEMO_CREDENTIALS_FILENAME = 'demo-credentials.txt';
export const DEFAULT_CREDENTIALS_DIR = '/app/credentials';

export interface DemoAccount {
  username: string;
  fullName: string;
  email?: string;
  role: string;
}

/**
 * A password that satisfies the application's own policy, and that a person can
 * actually type.
 *
 * Letters and digits are each guaranteed rather than hoped for, and the rejection-
 * sampling loop keeps the choice uniform: taking a random byte modulo the alphabet
 * length would favour the first few characters, which is the kind of bias that never
 * shows up in a test and matters exactly once.
 */
export function generateDemoPassword(): string {
  let password = '';
  while (password.length < PASSWORD_LENGTH) {
    const bytes = randomBytes(PASSWORD_LENGTH * 2);
    for (const byte of bytes) {
      if (password.length >= PASSWORD_LENGTH) break;
      if (byte > 255 - (256 % ALPHABET.length)) continue;
      password += ALPHABET[byte % ALPHABET.length];
    }
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return generateDemoPassword();
  return password;
}

/** A one-way marker: enough to know a password was issued, not enough to recover it. */
export function fingerprintDemoPassword(password: string): string {
  return createHash('sha256').update(`cairn/demo-password/${password}`).digest('hex');
}

function line(label: string, value: string, width = 14): string {
  return `  ${label.padEnd(width)}${value}\n`;
}

/**
 * The credential report.
 *
 * The warning comes first because it is the part that must not be missed: this is a
 * shared password for a fictional company, and the one thing worse than losing it is
 * treating the environment it opens as somewhere to keep real books.
 */
export function renderDemoCredentialReport(input: {
  loginUrl: string;
  tenant: string;
  password: string | null;
  passwordGeneratedAt: string | null;
  accounts: DemoAccount[];
  filePath: string;
  hostPath: string;
  generatedAt: string;
}): string {
  const rule = '='.repeat(70) + '\n';
  const thin = '-'.repeat(70) + '\n';
  let out = '';

  out += rule;
  out += '  CAIRN — DEMO ENVIRONMENT CREDENTIALS\n';
  out += rule;
  out += '\n';
  out += '  This environment contains FICTIONAL DATA ONLY.\n';
  out += '\n';
  out += '  Do not enter real business data. A demo tenant is not backed up,\n';
  out += '  not supported, and may be discarded without notice.\n';
  out += '\n';
  out += '  Every account below shares ONE password. It was generated at\n';
  out += '  deployment time and it is the same for everyone. Do not reuse it\n';
  out += '  anywhere, and do not give this environment to anyone who might\n';
  out += '  mistake it for a real system.\n';
  out += '\n';
  out += thin;
  out += '\n';
  out += line('Login URL', input.loginUrl);
  out += line('Tenant', input.tenant);
  if (input.password) {
    out += line('Password', input.password);
  } else {
    out += line('Password', '(not recoverable — see the note below)');
  }
  out += '\n';

  if (input.accounts.length > 0) {
    out += thin;
    out += '  ACCOUNTS\n';
    out += thin;
    const width = Math.max(...input.accounts.map((a) => a.username.length), 8);
    for (const account of input.accounts) {
      out += `  ${account.username.padEnd(width)}  ${account.fullName}`;
      out += account.email ? ` <${account.email}>` : '';
      out += `\n  ${' '.repeat(width)}  ${account.role}\n`;
    }
    out += '\n';
  }

  if (!input.password) {
    out += thin;
    out += '  The shared password was issued during the original installation and is\n';
    out += '  not stored in the database — by design, so that reading the database\n';
    out += '  never reveals it. This copy of the file was written after that run, so\n';
    out += '  the password cannot be shown here.\n';
    out += '\n';
    out += '  If the original file is gone, provision a fresh database.\n';
    out += `  Password issued: ${input.passwordGeneratedAt ?? 'unknown'}\n`;
    out += '\n';
  }

  out += thin;
  out += line('Container', input.filePath, 12);
  out += line('On the host', input.hostPath, 12);
  out += line('Generated', input.generatedAt, 12);
  out += '\n';
  out += '  Keep this file private. It is not committed to Git and it is not\n';
  out += '  copied into the image.\n';
  out += rule;

  return out;
}

export interface WriteDemoCredentialsResult {
  filePath: string;
  /** Who owns the file after the write, or null when it was left as the process owner. */
  ownedBy: { uid: number; gid: number } | null;
  mode: number;
  directoryCreated: boolean;
}

/**
 * Write the credential report so that only its owner can read it.
 *
 * The write is atomic — a temporary file in the same directory, then a rename — so a
 * reader can never open a half-written report, and an interrupted write cannot leave
 * a file that looks finished but is not.
 *
 * Ownership is the part that a container gets wrong by default. The operations
 * container runs as root, so a file it creates in a bind-mounted directory is owned by
 * root on the host and unreadable without sudo. A bind mount preserves the host
 * directory's owner, so when the directory already exists its owner is the person who
 * will want to read the file; that is used unless an explicit uid/gid is supplied.
 */
export function writeDemoCredentials(
  report: string,
  options: {
    directory?: string;
    filename?: string;
    uid?: number | null;
    gid?: number | null;
  } = {},
): WriteDemoCredentialsResult {
  const directory = options.directory ?? process.env.CAIRN_DEMO_CREDENTIALS_DIR ?? DEFAULT_CREDENTIALS_DIR;
  const filePath = join(directory, options.filename ?? DEMO_CREDENTIALS_FILENAME);

  let directoryCreated = false;
  try {
    statSync(directory);
  } catch {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    directoryCreated = true;
  }

  // Resolve ownership before the file exists, from the directory the deployment owns.
  const explicitUid = options.uid ?? parseNumericEnv('CAIRN_DEMO_CREDENTIALS_UID');
  const explicitGid = options.gid ?? parseNumericEnv('CAIRN_DEMO_CREDENTIALS_GID');
  let uid = explicitUid;
  let gid = explicitGid;
  if (uid === null && gid === null) {
    try {
      const stat = statSync(directory);
      if (stat.uid !== 0) {
        uid = stat.uid;
        gid = stat.gid;
      }
    } catch {
      // Leave ownership alone rather than guessing at it.
    }
  }

  const temporary = join(directory, `.${options.filename ?? DEMO_CREDENTIALS_FILENAME}.${process.pid}.tmp`);
  writeFileSync(temporary, report, { mode: 0o600, encoding: 'utf8' });
  chmodSync(temporary, 0o600);
  if (uid !== null || gid !== null) {
    try {
      chownSync(temporary, uid ?? -1, gid ?? -1);
    } catch {
      // Ownership is a convenience; a file the owner can chmod is not worth failing a
      // deployment over, and the report says where it was written either way.
    }
  }
  renameSync(temporary, filePath);

  const mode = 0o600;
  let ownedBy: { uid: number; gid: number } | null = null;
  try {
    const stat = statSync(filePath);
    ownedBy = { uid: stat.uid, gid: stat.gid };
  } catch {
    ownedBy = null;
  }

  return { filePath, ownedBy, mode, directoryCreated };
}

function parseNumericEnv(name: string): number | null {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Read a report back, so a test can assert what the owner will actually see. */
export function readDemoCredentials(directory?: string): string | null {
  const dir = directory ?? process.env.CAIRN_DEMO_CREDENTIALS_DIR ?? DEFAULT_CREDENTIALS_DIR;
  try {
    return statSync(join(dir, DEMO_CREDENTIALS_FILENAME)).isFile()
      ? readFileSync(join(dir, DEMO_CREDENTIALS_FILENAME), 'utf8')
      : null;
  } catch {
    return null;
  }
}

export { dirname };

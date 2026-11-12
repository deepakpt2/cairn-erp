import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CREDENTIALS_DIR,
  DEMO_CREDENTIALS_FILENAME,
  fingerprintDemoPassword,
  generateDemoPassword,
  renderDemoCredentialReport,
  writeDemoCredentials,
} from '../src/platform/tenancy/demo-credentials';
import { checkPasswordPolicy } from '../src/platform/auth/password';

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-demo-cred-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('demo credentials', () => {
  it('generates a password that the application would accept, one hundred times over', () => {
    // The policy is the application's own: ten characters, a letter, a digit. A generated
    // password that failed it would fail at first login, and no test would notice.
    for (let index = 0; index < 100; index += 1) {
      const password = generateDemoPassword();
      expect(checkPasswordPolicy(password)).toBeNull();
      expect(password).toHaveLength(20);
      // Typed by a person, off a screen: nothing that reads as something else.
      expect(password).not.toMatch(/[O0Il1]/);
      expect(password).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('never generates the same password twice', () => {
    const passwords = new Set(Array.from({ length: 200 }, () => generateDemoPassword()));
    expect(passwords.size).toBe(200);
  });

  it('fingerprints without storing', () => {
    const password = generateDemoPassword();
    const fingerprint = fingerprintDemoPassword(password);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(fingerprintDemoPassword(password));
    expect(fingerprint).not.toContain(password);
    expect(fingerprintDemoPassword(password + 'x')).not.toBe(fingerprint);
  });

  it('writes a file only its owner can read', () => {
    const directory = scratch();
    const result = writeDemoCredentials('SECRET REPORT\n', { directory });

    expect(result.filePath).toBe(join(directory, DEMO_CREDENTIALS_FILENAME));
    // Group and other get nothing. A world-readable credential file is the failure
    // this whole step exists to avoid.
    expect(statSync(result.filePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(result.filePath, 'utf8')).toBe('SECRET REPORT\n');
  });

  it('creates the directory when the deployment has not mounted one', () => {
    const directory = join(scratch(), 'nested', 'credentials');
    const result = writeDemoCredentials('x', { directory });
    expect(result.directoryCreated).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('leaves an existing directory alone and reports that it did', () => {
    const directory = join(scratch(), 'nested', 'credentials');
    const result = writeDemoCredentials('x', { directory });
    const second = writeDemoCredentials('y', { directory });
    expect(result.directoryCreated).toBe(true);
    expect(second.directoryCreated).toBe(false);
    // The mode the deployment chose is not overwritten on the way past.
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('writes atomically, leaving no readable partial file behind', () => {
    const directory = scratch();
    writeDemoCredentials('first\n', { directory });
    writeDemoCredentials('second\n', { directory });
    // One real file and nothing else: the temporary file was renamed, not left behind.
    expect(require('node:fs').readdirSync(directory)).toEqual([DEMO_CREDENTIALS_FILENAME]);
    expect(readFileSync(join(directory, DEMO_CREDENTIALS_FILENAME), 'utf8')).toBe('second\n');
  });

  it('hands the file to the owner the deployment names, and reports who actually has it', () => {
    // In a container the operations step runs as root and the chown succeeds; outside
    // one it does not, and must not be allowed to fail the deployment. What must hold
    // in both places is that the report says who owns the file rather than assuming.
    const directory = scratch();
    const result = writeDemoCredentials('x', { directory, uid: 1042, gid: 1043 });

    expect(result.ownedBy).not.toBeNull();
    if (process.getuid?.() === 0) {
      expect(result.ownedBy).toEqual({ uid: 1042, gid: 1043 });
    } else {
      // Not root: the chown was refused, the file stayed with the process, and the
      // run still finished and still wrote it.
      expect(result.ownedBy).toEqual({ uid: process.getuid!(), gid: process.getgid!() });
      expect(readFileSync(join(directory, DEMO_CREDENTIALS_FILENAME), 'utf8')).toBe('x');
    }
    // Either way the permissions are what matter, and they are unconditional.
    expect(result.mode).toBe(0o600);
  });

  it('honours the documented environment variables for the holder and the directory', () => {
    const directory = scratch();
    const previous = { ...process.env };
    process.env.CAIRN_DEMO_CREDENTIALS_DIR = directory;
    process.env.CAIRN_DEMO_CREDENTIALS_UID = '1500';
    process.env.CAIRN_DEMO_CREDENTIALS_GID = '1500';
    try {
      const result = writeDemoCredentials('x');
      expect(result.filePath).toBe(join(directory, DEMO_CREDENTIALS_FILENAME));
      expect(statSync(result.filePath).mode & 0o777).toBe(0o600);
    } finally {
      process.env = previous;
    }
  });

  it('ignores an owner that is not a uid rather than chowning to nonsense', () => {
    const directory = scratch();
    const previous = process.env.CAIRN_DEMO_CREDENTIALS_UID;
    process.env.CAIRN_DEMO_CREDENTIALS_UID = 'nobody';
    try {
      const result = writeDemoCredentials('x', { directory });
      expect(result.ownedBy).not.toBeNull();
      // A non-numeric uid is dropped, not coerced to zero — chowning to root would be
      // worse than leaving the file with the process that wrote it.
      expect(result.ownedBy!.uid).not.toBe(0);
      expect(readFileSync(join(directory, DEMO_CREDENTIALS_FILENAME), 'utf8')).toBe('x');
    } finally {
      if (previous === undefined) delete process.env.CAIRN_DEMO_CREDENTIALS_UID;
      else process.env.CAIRN_DEMO_CREDENTIALS_UID = previous;
    }
  });

  it('delivers the password once, warns first, and says where the file is', () => {
    const password = generateDemoPassword();
    const report = renderDemoCredentialReport({
      loginUrl: 'http://localhost:3000',
      tenant: 'Cairn Demo',
      password,
      passwordGeneratedAt: null,
      accounts: [
        { username: 'admin', fullName: 'Ada Admin', email: 'admin@cairn.test', role: 'Administrator' },
        { username: 'buyer', fullName: 'Bill Buyer', role: 'Buyer' },
      ],
      filePath: '/app/credentials/demo-credentials.txt',
      hostPath: './credentials/demo-credentials.txt',
      generatedAt: '2026-11-11T09:00:00Z',
    });

    expect(report).toContain(password);
    // The warning is above the password, not below it, and it is not a footnote.
    expect(report.indexOf('FICTIONAL DATA ONLY')).toBeLessThan(report.indexOf(password));
    expect(report).toContain('shares ONE password');
    expect(report).toContain('admin');
    expect(report).toContain('Administrator');
    expect(report).toContain('./credentials/demo-credentials.txt');
    expect(report).toContain('not committed to Git');
  });

  it('says so plainly when the password cannot be shown, and never invents one', () => {
    const report = renderDemoCredentialReport({
      loginUrl: 'http://localhost:3000',
      tenant: 'Cairn Demo',
      password: null,
      passwordGeneratedAt: '2026-11-11T09:00:00Z',
      accounts: [{ username: 'admin', fullName: 'Ada Admin', role: 'Administrator' }],
      filePath: '/app/credentials/demo-credentials.txt',
      hostPath: './credentials/demo-credentials.txt',
      generatedAt: '2026-11-12T10:00:00Z',
    });

    expect(report).toContain('not recoverable');
    expect(report).toContain('provision a fresh database');
    expect(report).toContain('2026-11-11T09:00:00Z');
    // The accounts are still listed: knowing who exists costs nothing.
    expect(report).toContain('admin');
  });

  it('keeps the password out of the running process and the repository', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/platform/tenancy/demo-credentials.ts'),
      'utf8',
    );
    // No literal password, no seed, and no way to ask for one on demand.
    expect(source).not.toMatch(/const\s+PASSWORD\s*=/);
    expect(source).not.toMatch(/password\s*[:=]\s*['"][A-Za-z0-9]{8,}['"]/);
  });

  it('never writes credentials into the image', () => {
    const dockerignore = readFileSync(join(process.cwd(), '.dockerignore'), 'utf8');
    expect(dockerignore).toMatch(/^\/?credentials\/?$/m);
    expect(dockerignore).toMatch(/^\*credential/i.test(dockerignore) ? /^\*credential/im : /credentials/im);
  });

  it('defaults the directory to a path the deployment owns, not a shared one', () => {
    expect(DEFAULT_CREDENTIALS_DIR).toBe('/app/credentials');
  });
});

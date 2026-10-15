/**
 * D-034 IP lint — the applied-migration allowlist, and migration 0035, which corrects
 * the deployed key-reservation messages.
 *
 * An applied migration is a record of what happened to a database:
 * `src/platform/db/migrate.ts` stores a checksum per file and refuses to run one that
 * changed since it was applied. So trademark wording inside an already-applied
 * migration cannot be edited away. The compliant arrangement is the one these tests
 * pin: the deployed effect is corrected by a *new* migration (0035 restates the
 * function with vendor-free message text), and the historical lines are allowlisted in
 * the linter by exact content.
 *
 * The mark list is read out of `scripts/lint-ip.ts` rather than repeated here, so this
 * file stays clean under the very lint it describes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const digest = (path: string): string =>
  createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');

const LINT_IP = 'scripts/lint-ip.ts';
const M_0033 = 'drizzle/0033_chart_of_accounts_ob13.sql';
const M_0034 = 'drizzle/0034_group_coa_registry_ob13.sql';
const M_0035 = 'drizzle/0035_vendor_free_coa_key_messages.sql';

/**
 * Digests of the two applied migrations that carry historical wording. Editing either
 * one would desynchronise every database that already ran it, so the digest is pinned
 * here as well as in `cairn_migration`.
 */
const APPLIED_DIGESTS: Record<string, string> = {
  [M_0033]: '3c47420273ce4c8636a1c4dc591194106bd31c929bb40381f2796f3fb21827f8',
  [M_0034]: '385c8c1a98f855dce741eab693833dc2246298057504e4a29c3d83849caa6e04',
};

interface AllowlistEntry {
  file: string;
  text: string;
  rationale: string;
}

/** The vendor marks, as the linter itself defines them. */
function markedTerms(): string[] {
  const source = read(LINT_IP);
  const start = source.indexOf('const MARKED_TERMS');
  const block = source.slice(start, source.indexOf('];', start));
  return [...block.matchAll(/term:\s*'([^']+)'/g)].map((match) => match[1]);
}

/** Case-insensitive on purpose: stricter than the linter's per-casing entries. */
function vendorMark(): RegExp {
  const escaped = markedTerms().map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![A-Za-z])(?:${escaped.join('|')})(?![A-Za-z])`, 'i');
}

/** Reads the allowlist straight out of the linter source. */
function allowlistEntries(): AllowlistEntry[] {
  const source = read(LINT_IP);
  const start = source.indexOf('const HISTORICAL_MIGRATION_ALLOWLIST');
  const block = source.slice(start, source.indexOf('const ALLOWLIST_FILE_PATTERN', start));
  const entry =
    /\{\s*file:\s*'([^']+)',\s*text:\s*(["'])((?:\\.|(?!\2).)*)\2,\s*rationale:\s*'([^']*)',\s*\}/g;
  return [...block.matchAll(entry)].map((match) => ({
    file: match[1],
    text: match[3],
    rationale: match[4],
  }));
}

describe('IP lint — the applied-migration allowlist stays narrow', () => {
  const entries = allowlistEntries();

  it('is read back out of the linter source', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(4);
  });

  it('names only applied migration files, never application code', () => {
    for (const entry of entries) {
      expect(entry.file, entry.file).toMatch(/^drizzle\/\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it('carries a written rationale for every entry', () => {
    for (const entry of entries) {
      expect(entry.rationale.length, entry.file).toBeGreaterThan(20);
    }
  });

  it('guards its own shape before scanning', () => {
    const source = read(LINT_IP);
    expect(source).toContain('function assertAllowlistShape');
    expect(source).toContain('assertAllowlistShape();');
    expect(source).toContain('ALLOWLIST_FILE_PATTERN.test(entry.file)');
  });

  it('matches on exact line content, and reports what it allowed through', () => {
    const source = read(LINT_IP);
    expect(source).toContain('isAllowlistedHistoricalLine(rel, line.trim())');
    expect(source).toContain('historical line(s) allowlisted');
  });

  it('still finds every allowlisted line verbatim, so an edit fails the lint again', () => {
    for (const entry of entries) {
      const lines = read(entry.file)
        .split('\n')
        .map((line) => line.trim());
      expect(lines, `${entry.file} no longer contains an allowlisted line`).toContain(entry.text);
    }
  });

  it('leaves the applied migrations byte-identical', () => {
    for (const [file, expected] of Object.entries(APPLIED_DIGESTS)) {
      expect(digest(file), `${file} is applied and immutable`).toBe(expected);
    }
  });
});

describe('0035 — vendor-free key-reservation messages', () => {
  const source = read(M_0035);

  it('corrects the deployed function by restating it', () => {
    expect(source).toContain('CREATE OR REPLACE FUNCTION coa_key_registry_exclusive()');
  });

  it('is itself free of vendor marks', () => {
    expect(markedTerms().length).toBeGreaterThan(5);
    expect(vendorMark().test(source), '0035 names a vendor').toBe(false);
  });

  it('keeps both reservations, worded for a tenant', () => {
    expect(source).toContain(
      "'Chart of Accounts key % is reserved as a Group CoA in this tenant'",
    );
    expect(source).toContain(
      "'Group CoA key % is reserved as an operational Chart of Accounts in this tenant'",
    );
  });

  it('keeps the unique_violation error code callers branch on', () => {
    expect(source.match(/USING ERRCODE = 'unique_violation'/g)).toHaveLength(2);
  });

  it('keeps the trigger contract and does not touch the trigger bindings', () => {
    expect(source).toContain("tg_table_name = 'chart_of_accounts'");
    expect(source).toContain('RETURN new;');
    expect(source).not.toContain('CREATE TRIGGER');
    expect(source).not.toContain('DROP TRIGGER');
  });

  it('restates least privilege for the application role', () => {
    expect(source).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.coa_key_registry_exclusive() FROM PUBLIC',
    );
    expect(source).toContain(
      'GRANT EXECUTE ON FUNCTION public.coa_key_registry_exclusive() TO cairn_app',
    );
  });

  it('says why the historical files are not edited', () => {
    expect(source).toMatch(/checksum/i);
    expect(source).toMatch(/immutable|already ran|applied/i);
  });
});

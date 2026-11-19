/**
 * Period-close evidence pack: deterministic CSV / manifest / ZIP construction. Pure - no database, no clock.
 *
 * Same rows in, same bytes out. The only non-deterministic input is `generatedAt`, a real value the caller
 * passes in. Every file name is a fixed literal (never derived from user input), CSV follows RFC 4180
 * (CRLF, quoting of comma / quote / CR / LF), and every untrusted text cell is neutralised against
 * spreadsheet formula injection. Numbers stay numbers.
 *
 * The SHA-256 of each file permits tamper detection when it is compared with a TRUSTED copy of the
 * manifest. It is not a signature and proves nothing about who produced the pack.
 */
import { createHash } from 'node:crypto';

import { zipSync } from 'fflate';

export const PACK_SCHEMA_VERSION = 1;

/** The fixed members of the pack, in archive order. The manifest hashes every one except itself. */
export const PACK_FILES = [
  'summary.csv',
  'period-rules.csv',
  'period-rule-changes.csv',
  'close-tasks.csv',
  'close-events.csv',
  'journal-postings.csv',
  'limitations.txt',
] as const;
export const MANIFEST_FILE = 'manifest.json';

export type Cell = string | number | boolean | Date | null | undefined;

export interface CsvTable {
  columns: readonly string[];
  rows: ReadonlyArray<readonly Cell[]>;
}

/** A plain numeric literal is not a formula, so it is not touched. */
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;
/** Optional whitespace / control characters, then a formula trigger; or a leading tab / CR. */
const FORMULA_TRIGGER = /^[\s\u0000-\u001f]*[=+\-@]|^[\t\r]/u;

/** Neutralise spreadsheet formula injection in untrusted text by prefixing an apostrophe. */
export function neutraliseFormula(text: string): string {
  if (NUMERIC_LITERAL.test(text)) return text;
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/** One CSV field: RFC 4180 quoting; text neutralised; numbers verbatim. */
export function csvField(value: Cell): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    text = String(value);
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else {
    text = neutraliseFormula(String(value));
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** UTF-8 CSV bytes (no BOM), CRLF line ends, header always present. */
export function buildCsv(table: CsvTable): Buffer {
  const lines = [table.columns.map(csvField).join(',')];
  for (const row of table.rows) {
    if (row.length !== table.columns.length) throw new Error('CSV row width does not match its header.');
    lines.push(row.map(csvField).join(','));
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface ManifestFile {
  name: string;
  bytes: number;
  /** Data rows for a CSV; null for a text file. */
  rows: number | null;
  sha256: string;
}

export interface ManifestInput {
  packId: string;
  client: string;
  companyCode: string;
  fiscalYear: number;
  postingPeriod: number;
  snapshotAt: string;
  generatedAt: string;
  files: readonly ManifestFile[];
  sources: ReadonlyArray<{ file: string; source: string; basis: string }>;
  limitations: ReadonlyArray<{ code: string; statement: string }>;
}

export const HASH_NOTE =
  'The sha256 values are of each file\'s exact uncompressed bytes and let a reader detect alteration when they are '
  + 'compared with a manifest obtained from a trusted source. They are not signatures, and a hash alone does not '
  + 'prove who produced the pack or that it is authentic. This manifest does not contain its own hash.';

/** manifest.json. It lists every OTHER file; it never hashes itself. */
export function buildManifest(input: ManifestInput): Buffer {
  const manifest = {
    schemaVersion: PACK_SCHEMA_VERSION,
    packId: input.packId,
    client: input.client,
    selection: { companyCode: input.companyCode, fiscalYear: input.fiscalYear, postingPeriod: input.postingPeriod },
    snapshotAtUtc: input.snapshotAt,
    generatedAtUtc: input.generatedAt,
    hashAlgorithm: 'SHA-256',
    hashNote: HASH_NOTE,
    files: input.files.map((f) => ({ name: f.name, bytes: f.bytes, rows: f.rows, sha256: f.sha256 })),
    sources: input.sources,
    limitations: input.limitations,
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export interface BuiltPack {
  zip: Buffer;
  manifest: Buffer;
  manifestSha256: string;
  /** Uncompressed bytes of every member, for the size cap. */
  uncompressedBytes: number;
}

/**
 * Assemble the archive from the already-built members. Names are validated against the fixed list, so a
 * user-controlled string can never become a path inside the ZIP.
 */
export function buildZip(
  members: ReadonlyArray<{ name: (typeof PACK_FILES)[number]; bytes: Buffer }>,
  manifest: Buffer,
  mtime: Date,
): BuiltPack {
  const allowed = new Set<string>([...PACK_FILES, MANIFEST_FILE]);
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 6 }]> = {};
  let uncompressedBytes = 0;
  for (const m of members) {
    if (!allowed.has(m.name)) throw new Error(`Unexpected pack member ${m.name}.`);
    entries[m.name] = [m.bytes, { mtime, level: 6 }];
    uncompressedBytes += m.bytes.length;
  }
  entries[MANIFEST_FILE] = [manifest, { mtime, level: 6 }];
  uncompressedBytes += manifest.length;
  return { zip: Buffer.from(zipSync(entries)), manifest, manifestSha256: sha256Hex(manifest), uncompressedBytes };
}

/** Safe download name: fixed shape, built only from validated pieces. */
export function packFilename(companyCode: string, fiscalYear: number, postingPeriod: number, packId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9]/g, '');
  return `period-close-evidence-${safe(companyCode)}-${fiscalYear}-${String(postingPeriod).padStart(2, '0')}-${safe(packId).slice(0, 8)}.zip`;
}

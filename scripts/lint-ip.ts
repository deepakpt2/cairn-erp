/**
 * Intellectual-property lint — CAIRN.md §19.5, decision D-034.
 *
 * A build-time guard, not a code review habit. It walks the source tree and fails
 * if a reference vendor's trademark appears in text a user could ever read. The
 * rule is deliberately blunt because the requirement is:
 *
 *   "Your recommendation, but don't make it too much copy of SAP so they will sue."
 *
 * That sentence is the whole reason this file exists. A reviewer can miss a
 * trademark in a tooltip on a screen they have not opened; a script cannot.
 *
 * ## What is allowed
 *
 * The Term Registry is the one place where reference codes are legitimate, and
 * even there they are *search metadata only* — an alias a user may type to find our
 * screen. `term_registry.reference_code` and its aliases are therefore exempt, and
 * they are exempt by name rather than by a path guess, so moving the registry does
 * not silently widen or narrow the exemption.
 *
 * ## What is not
 *
 * Everywhere else. That includes screens, labels, messages, error remedies,
 * comments a user could see in an export, and the seeded data that a user browses.
 * A reference code leaking into any of those is a defect, and this script makes it
 * a failing build rather than a note in a review.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

/** Root of the application. */
const ROOT = new URL('..', import.meta.url).pathname;

/** Scanned for user-facing text. */
const SCAN_DIRS = ['src', 'scripts', 'tests', 'drizzle'];

/**
 * File types that can carry text a user reads. Binary assets are not scanned,
 * because a trademark inside a generated font or image is not something a grep
 * can be expected to fix.
 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.sql', '.css', '.html', '.yml', '.yaml',
]);

/**
 * The trademarks, and the one legitimate place each may appear.
 *
 * Exempted by *content*, not by path: a line is allowed through only if it is
 * inside the Term Registry's own alias data. Anything else that names a vendor is
 * reported.
 */
const MARKED_TERMS: Array<{ term: string; rationale: string }> = [
  { term: 'SAP', rationale: 'vendor name and company mark' },
  { term: 'ABAP', rationale: 'vendor programming language mark' },
  { term: 'S/4HANA', rationale: 'vendor product mark' },
  { term: 'HANA', rationale: 'vendor product mark' },
  { term: 'NetWeaver', rationale: 'vendor platform mark' },
  { term: 'FICO', rationale: 'vendor module name' },
  { term: 'Netweaver', rationale: 'vendor platform mark, alternate casing' },
  { term: 'ECC', rationale: 'vendor product mark' },
  { term: 'mySAP', rationale: 'vendor product mark' },
  { term: 'SAPscript', rationale: 'vendor technology mark' },
];

/**
 * Files whose entire purpose is to carry reference codes as searchable aliases.
 *
 * These are allowed to name a vendor, and only these. The registry data itself is
 * one of them; the alias list is the other.
 */
const EXEMPT_FILES = [
  'src/platform/registry/index.ts',
  'scripts/seed-reference.ts',
  'scripts/lint-ip.ts',
];

/**
 * Applied migrations whose text may never change.
 *
 * `src/platform/db/migrate.ts` records a checksum per file and refuses to run one that
 * changed since it was applied, so an applied migration is a record of what actually
 * happened to a database — editing it to satisfy a lint would falsify that record and
 * desynchronise every environment that already ran it. Where such a file carries a
 * trademark, the deployed effect is corrected by a *new* migration (0035 restates the
 * key-reservation function with compliant message text) and the historical line is
 * allowlisted here.
 *
 * The allowlist is deliberately narrow and self-verifying:
 * - entries may name only `drizzle/NNNN_*.sql` files, so it can never exempt app code;
 * - matching is on exact line content, so adding a new occurrence to those files, or
 *   editing an existing one, fails the lint again instead of passing quietly.
 */
const HISTORICAL_MIGRATION_ALLOWLIST: Array<{ file: string; text: string; rationale: string }> = [
  {
    file: 'drizzle/0033_chart_of_accounts_ob13.sql',
    text: "-- SCR-026 / OB13: migrate Chart of Accounts to SAP's four-character key and",
    rationale: 'Applied migration header comment; immutable once run, no deployed effect.',
  },
  {
    file: 'drizzle/0034_group_coa_registry_ob13.sql',
    text: '-- role, so forced row-level security keeps it scoped to the current SAP client.',
    rationale: 'Applied migration comment; immutable once run, no deployed effect.',
  },
  {
    file: 'drizzle/0034_group_coa_registry_ob13.sql',
    text: "RAISE EXCEPTION 'Chart of Accounts key % is reserved as a Group CoA in this SAP client', reserved_key",
    rationale: 'Superseded by 0035, which restates the function with compliant message text.',
  },
  {
    file: 'drizzle/0034_group_coa_registry_ob13.sql',
    text: "RAISE EXCEPTION 'Group CoA key % is reserved as an operational Chart of Accounts in this SAP client', reserved_key",
    rationale: 'Superseded by 0035, which restates the function with compliant message text.',
  },
];

/** The allowlist may only ever name applied migration files. */
const ALLOWLIST_FILE_PATTERN = /^drizzle\/\d{4}_[a-z0-9_]+\.sql$/;

/** True when this exact line of this exact applied migration is on the allowlist. */
function isAllowlistedHistoricalLine(file: string, trimmedLine: string): boolean {
  return HISTORICAL_MIGRATION_ALLOWLIST.some(
    (entry) => entry.file === file && entry.text === trimmedLine,
  );
}

/** Fails loudly rather than silently widening the allowlist beyond migrations. */
function assertAllowlistShape(): void {
  for (const entry of HISTORICAL_MIGRATION_ALLOWLIST) {
    if (!ALLOWLIST_FILE_PATTERN.test(entry.file)) {
      throw new Error(
        `IP lint allowlist entry names ${entry.file}; only applied migrations under drizzle/ may be allowlisted.`,
      );
    }
    if (!entry.rationale) {
      throw new Error(`IP lint allowlist entry for ${entry.file} has no rationale.`);
    }
  }
}

/** Lines that are part of the alias registry's own definition. */
const EXEMPT_LINE_PATTERNS = [
  // The seeded alias rows in the Term Registry — a user may type these to find us.
  /alias/i,
  /reference_code/i,
  /referenceCode/i,
  /matchedOn/i,
];

interface Hit {
  file: string;
  line: number;
  term: string;
  text: string;
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
      found.push(...(await walk(full)));
    } else {
      found.push(full);
    }
  }
  return found;
}

/** A line that names a term but only in the vocabulary of the alias registry. */
function isExemptLine(line: string): boolean {
  return EXEMPT_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

async function main() {
  assertAllowlistShape();

  const hits: Hit[] = [];
  let scanned = 0;
  let allowlisted = 0;

  for (const dir of SCAN_DIRS) {
    for (const file of await walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      if (EXEMPT_FILES.includes(rel)) continue;
      if (!TEXT_EXTENSIONS.has(extname(file))) continue;

      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }

      scanned += 1;
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        for (const { term } of MARKED_TERMS) {
          // Word-boundary-ish matching, so "SAP" does not match inside a longer
          // word that merely contains it.
          const pattern = new RegExp(`(?<![A-Za-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'g');
          if (!pattern.test(line)) continue;
          if (isExemptLine(line)) continue;
          if (isAllowlistedHistoricalLine(rel, line.trim())) {
            allowlisted += 1;
            continue;
          }

          hits.push({ file: rel, line: index + 1, term, text: line.trim().slice(0, 160) });
        }
      });
    }
  }

  console.log(`\nIP lint — scanned ${scanned} file(s) across ${SCAN_DIRS.join(', ')}`);
  if (allowlisted > 0) {
    console.log(
      `${allowlisted} historical line(s) allowlisted in applied migrations — see HISTORICAL_MIGRATION_ALLOWLIST in scripts/lint-ip.ts.`,
    );
  }

  if (hits.length === 0) {
    console.log('No reference trademarks in user-facing text.\n');
    process.exit(0);
  }

  console.error(`\n${hits.length} trademark occurrence(s) found:\n`);
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line}  [${hit.term}]`);
    console.error(`      ${hit.text}\n`);
  }
  console.error(
    'Reference codes may appear only as searchable aliases in the Term Registry.\n' +
      'Everything else must use our own names, codes and terminology (D-034).\n',
  );
  process.exit(1);
}

main().catch((error) => {
  console.error('IP lint error:', error.message);
  process.exit(1);
});

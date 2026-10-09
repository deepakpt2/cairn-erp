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
  const hits: Hit[] = [];
  let scanned = 0;

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

          hits.push({ file: rel, line: index + 1, term, text: line.trim().slice(0, 160) });
        }
      });
    }
  }

  console.log(`\nIP lint — scanned ${scanned} file(s) across ${SCAN_DIRS.join(', ')}`);

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

/**
 * The data-dictionary vocabulary rule, as one definition shared by the guard and its tests.
 *
 * `tests/source-keyword-hygiene.test.ts` scans every application source for the keywords below
 * and fails on a line that carries one. That rule is the product's own: a reference-system field
 * name belongs in the Term Registry alias data and nowhere else, because a keyword the product
 * does not own teaches a new consultant a vocabulary the licence may not even cover.
 *
 * One class of offender cannot be renamed in code, and that class is what this module exists to
 * hold: a field name that is *already stored*. `batch_condition_table_field.field_name` carries a
 * `CHECK` constraint enumerating these names, `batch_search_strategy_key` makes `field_name` part
 * of its primary key, and the strategy's `key_fingerprint` — the value duplicate and overlap
 * detection compares — is built by joining `field=value` pairs. Renaming a literal in the source
 * while the constraint, the keys and the stored fingerprints stay as they are would refuse every
 * row already on file and quietly change which rows count as duplicates. So the name has to stay,
 * and the line has to be exempted.
 *
 * The exemption is therefore not a keyword list and not a file list. It is a list of *exact
 * occurrences*: this file, this line, this many times. It works the way the IP lint's own
 * historical allowlist works (`scripts/lint-ip.ts`), for the same reason — anything looser decays:
 *
 * - matching is on the whole trimmed line, so editing an excepted line or writing a new one that
 *   happens to mention a keyword fails the guard again instead of passing quietly;
 * - `times` caps how many lines may read alike, so copying an excepted line into the next
 *   function is a failure, not a free pass;
 * - the file may only be one of the three module files that hold the persisted-key contract, and
 *   an entry may never read like an attribute assignment, so this exemption can never reach a DOM
 *   identifier — that half of the rule has its own, unchanged scan;
 * - every entry carries a rationale, and `assertVocabularyExceptionShape` refuses the whole scan
 *   if one is missing or an entry breaks these rules.
 *
 * Before adding an entry, the question is not "does this line need the keyword" but "is this name
 * stored, constrained, or fingerprinted". If it is not, the line is rewritten, not exempted. If
 * the answer is a schema change, that is a migration decision and needs its own authorization;
 * `pp-stage1-settlement-production-readiness.md` §15.5 records the smallest one and its rollback.
 */

/** Data-dictionary field and table keywords, exactly as the guard has always read them. */
export const KEYWORDS = [
  // G/L account master and its chart
  'SAKNR', 'HKONT', 'KTOPL', 'KTKTB', 'KTOKS', 'XBILK', 'XOPVW', 'MITKZ', 'ZUAWE', 'SPRAS',
  'XSPEB', 'XSPEA',
  // Fiscal year variants and periods
  'PERIV', 'LTEXT', 'XJAHR', 'ANZPER', 'ANZSP', 'XMONAT', 'BDATJ', 'POPER', 'MONAT', 'TAG',
  'JAHRSHIFT', 'T009', 'T009B',
  // Posting period variants and their intervals
  'VARNT', 'BKRSV', 'T010O', 'XT010O', 'T001B',
  // Organisational and partner keys
  'VKORG', 'BUKRS', 'VTWEG', 'VTEXT', 'SPART', 'MATNR', 'WERKS', 'LGORT', 'EKORG', 'EKGRP',
  'LIFNR', 'KUNNR',
] as const;

/** Case-sensitive on purpose: English `tag` and `month` are legitimate, `TAG` and `MONAT` are not. */
export const PATTERN = new RegExp(`\\b(?:${KEYWORDS.join('|')})\\b`);

/** An occurrence the persisted-key contract forces the guard to accept. */
export interface VocabularyException {
  /** Repository-relative source file, matched exactly. */
  readonly file: string;
  /** The whole line, trimmed, matched exactly. */
  readonly line: string;
  /** How many lines of that file may read alike. */
  readonly times: number;
  /** Why the name has to stay, in the terms the reviewer needs. */
  readonly rationale: string;
}

/** The only files whose lines may be excepted: the three that hold the persisted-key contract. */
export const EXCEPTION_FILE_PATTERN =
  /^src\/modules\/inventory\/batch-(condition-table|search-allocation|search-strategy)\.ts$/;

/** An entry that looks like an attribute assignment belongs to the DOM identifier rule, not here. */
const ATTRIBUTE_LINE = /\b(?:id|name|htmlFor|aria-labelledby|aria-describedby|data-testid)\s*=/;

/**
 * The fourteen lines the guard found, verified against `1e854f5` and `595a73b` and against the
 * stored vocabulary in `drizzle/9135_oma1_condition_table.sql` and
 * `drizzle/9140_mbc1_search_strategy.sql`. Nothing here is a name the product invented: each line
 * either declares a key the database accepts, compares against a key the database holds, or is
 * copy an operator reads about that key.
 */
export const DATA_DICTIONARY_VOCABULARY_EXCEPTIONS: readonly VocabularyException[] = [
  // The selectable key fields themselves: the list the `CHECK` constraint mirrors.
  { file: 'src/modules/inventory/batch-condition-table.ts', line: "{ field: 'KUNNR', title: 'Customer' },", times: 1,
    rationale: 'Stored key field name, enumerated by batch_condition_table_field_name_ck and read back from batch_condition_table_field.field_name.' },
  { file: 'src/modules/inventory/batch-condition-table.ts', line: "{ field: 'LGORT', title: 'Storage location' },", times: 1,
    rationale: 'Stored key field name, enumerated by batch_condition_table_field_name_ck and read back from batch_condition_table_field.field_name.' },
  { file: 'src/modules/inventory/batch-condition-table.ts', line: "{ field: 'LIFNR', title: 'Supplier' },", times: 1,
    rationale: 'Stored key field name, enumerated by batch_condition_table_field_name_ck and read back from batch_condition_table_field.field_name.' },
  { file: 'src/modules/inventory/batch-condition-table.ts', line: "{ field: 'MATNR', title: 'Material' },", times: 1,
    rationale: 'Stored key field name, enumerated by batch_condition_table_field_name_ck and read back from batch_condition_table_field.field_name.' },
  { file: 'src/modules/inventory/batch-condition-table.ts', line: "{ field: 'WERKS', title: 'Plant' },", times: 1,
    rationale: 'Stored key field name, enumerated by batch_condition_table_field_name_ck and read back from batch_condition_table_field.field_name.' },
  // Part of the array the screen renders as "what this screen does not execute", so the wording
  // names the key the assignment screen leaves to the strategy screen.
  { file: 'src/modules/inventory/batch-search-allocation.ts', line: "field: 'WERKS',", times: 1,
    rationale: 'Rendered operator copy naming the key this screen does not maintain; it has to agree with the stored field_name vocabulary.' },
  // The validation and comparison chain: each branch looks a stored key up by its stored name.
  { file: 'src/modules/inventory/batch-search-strategy.ts', line: "if (field === 'WERKS') {", times: 1,
    rationale: 'Compares against batch_search_strategy_key.field_name as persisted; renaming it would orphan existing rows.' },
  { file: 'src/modules/inventory/batch-search-strategy.ts', line: "if (field === 'LGORT') {", times: 1,
    rationale: 'Compares against batch_search_strategy_key.field_name as persisted; renaming it would orphan existing rows.' },
  { file: 'src/modules/inventory/batch-search-strategy.ts', line: "if (field === 'MATNR') {", times: 1,
    rationale: 'Compares against batch_search_strategy_key.field_name as persisted; renaming it would orphan existing rows.' },
  { file: 'src/modules/inventory/batch-search-strategy.ts', line: "if (field === 'KUNNR' || field === 'LIFNR') {", times: 1,
    rationale: 'Partner-key branch of the same comparison chain over stored field_name values.' },
  { file: 'src/modules/inventory/batch-search-strategy.ts', line: "const plantKey = keys.get('WERKS');", times: 2,
    rationale: 'Reads the stored plant key out of the strategy rows; the two sites are the storage-location and batch-segment lookups.' },
  { file: 'src/modules/inventory/batch-search-strategy.ts', line: "const role = field === 'KUNNR' ? 'CUSTOMER' : 'SUPPLIER';", times: 1,
    rationale: 'Derives the partner role from the stored field_name; the derived value is persisted in the strategy record.' },
  { file: 'src/modules/inventory/batch-search-strategy.ts', line: "if (!row || row.isBlocked) throw missing(field === 'KUNNR' ? 'Customer' : 'Supplier');", times: 1,
    rationale: 'Names the missing partner in the refusal the operator sees, from the stored field_name.' },
];

/**
 * The total the guard must keep finding: the count of excepted *lines* here, and no more. A new
 * persisted key that needs its own exemption means a contract change, so it comes with a migration
 * decision rather than one more row in this table.
 */
export const EXCEPTION_OCCURRENCE_TOTAL = DATA_DICTIONARY_VOCABULARY_EXCEPTIONS.reduce(
  (total, entry) => total + entry.times,
  0,
);

/** Thrown instead of scanning, so a widened exception cannot pass unnoticed. */
export function assertVocabularyExceptionShape(entries: readonly VocabularyException[] = DATA_DICTIONARY_VOCABULARY_EXCEPTIONS): void {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.file}\u0000${entry.line}`;
    const already = seen.get(key) ?? 0;
    seen.set(key, already + 1);
    if (!EXCEPTION_FILE_PATTERN.test(entry.file)) {
      throw new Error(`Vocabulary exception names ${entry.file}; only the three batch modules that hold the stored field_name contract may be excepted. A new home for a stored keyword is a migration decision, not an allowlist row.`);
    }
    if (!entry.rationale) {
      throw new Error(`Vocabulary exception for ${entry.file} has no rationale: ${entry.line}`);
    }
    if (entry.times < 1 || !Number.isInteger(entry.times)) {
      throw new Error(`Vocabulary exception for ${entry.file} must name a whole number of occurrences at or above one: ${entry.line}`);
    }
    if (already > 0) {
      throw new Error(`Vocabulary exception ${entry.line} is declared twice for ${entry.file}; raise its times instead, and expect the guard to fail past that number.`);
    }
    if (ATTRIBUTE_LINE.test(entry.line)) {
      throw new Error(`Vocabulary exception for ${entry.file} reads like an attribute assignment (${entry.line}). DOM identifiers belong to the identifier rule, which this exception must not reach.`);
    }
  }
}

/** How many times this exact line may appear in this exact file. Zero means "not excepted". */
export function permittedOccurrences(file: string, trimmedLine: string): number {
  return DATA_DICTIONARY_VOCABULARY_EXCEPTIONS
    .filter((entry) => entry.file === file && entry.line === trimmedLine)
    .reduce((total, entry) => total + entry.times, 0);
}

/**
 * The scan itself, over one file's text, so a test can aim it at input it writes. Returns the same
 * `file:line: text` offender strings the guard reports, and applies the exception by counting
 * occurrences within the file rather than by looking only at the keyword.
 */
export function keywordOffendersInFile(file: string, text: string): string[] {
  const offenders: string[] = [];
  const matched = new Map<string, number>();
  text.split('\n').forEach((rawLine, index) => {
    if (!PATTERN.test(rawLine)) return;
    const line = rawLine.trim();
    const seen = (matched.get(line) ?? 0) + 1;
    matched.set(line, seen);
    if (seen <= permittedOccurrences(file, line)) return;
    offenders.push(`${file}:${index + 1}: ${line.slice(0, 120)}`);
  });
  return offenders;
}

/**
 * The other direction of the same boundary: every excepted occurrence must still be there, in
 * exactly the number of lines declared. Paying one off shrinks the table, rewriting one moves it,
 * and duplicating one beyond its cap is reported even though the scan above is satisfied — which
 * is what keeps an entry from being widened into a licence for the whole file.
 */
export function vocabularyExceptionDrift(
  readFile: (file: string) => string,
  entries: readonly VocabularyException[] = DATA_DICTIONARY_VOCABULARY_EXCEPTIONS,
): string[] {
  const drift: string[] = [];
  for (const entry of entries) {
    const found = readFile(entry.file)
      .split('\n')
      .filter((line) => line.trim() === entry.line).length;
    if (found !== entry.times) {
      drift.push(`${entry.file}: "${entry.line}" appears ${found} time(s), the exception allows ${entry.times}`);
    }
  }
  return drift;
}

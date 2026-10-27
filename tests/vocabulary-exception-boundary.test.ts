/**
 * The boundary of the one exception `source-keyword-hygiene` makes to the data-dictionary rule.
 *
 * Pass 31 stopped at a line: fourteen source lines name a field key that is already stored —
 * behind `batch_condition_table_field_name_ck`, inside the primary key of
 * `batch_condition_table_field` and of `batch_search_strategy_key`, and folded into the
 * `key_fingerprint` that duplicate and overlap detection compares. Those names cannot be renamed
 * from application code without a migration, and a migration is not what this round is authorized
 * to do. The owner authorized a narrow exception instead, so the guard now tolerates exactly those
 * occurrences and nothing else.
 *
 * A narrow exception is only worth having if the narrowness is tested, so every case below runs
 * the real scanner from `./hygiene-vocabulary` — the same function the guard calls — over input
 * this file writes. Nothing here copies the rule; if the rule changes, these assertions move with
 * it, which is the point.
 *
 * What is proved: the approved occurrences pass (1); an unapproved occurrence elsewhere is still
 * found (2); a second occurrence in an approved file, whether it looks like the excepted line or
 * not, is still found (3); every other keyword stays prohibited everywhere, including in an
 * approved file (4); the exception cannot reach a DOM identifier and cannot name a file outside
 * the three that hold the stored-key contract (5); and the stored vocabulary, the validation that
 * refuses a field outside it, and the fingerprint shape are untouched (6).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DATA_DICTIONARY_VOCABULARY_EXCEPTIONS,
  EXCEPTION_FILE_PATTERN,
  EXCEPTION_OCCURRENCE_TOTAL,
  KEYWORDS,
  assertVocabularyExceptionShape,
  keywordOffendersInFile,
  permittedOccurrences,
  vocabularyExceptionDrift,
  type VocabularyException,
} from './hygiene-vocabulary';

const read = (file: string): string => readFileSync(file, 'utf8');

/** A well-formed entry, changed only where a case needs to break the rules. */
function entry(overrides: Partial<VocabularyException> = {}): VocabularyException {
  return {
    file: 'src/modules/inventory/batch-condition-table.ts',
    line: "{ field: 'MATNR', title: 'Material' },",
    times: 1,
    rationale: 'test input for the shape assertion',
    ...overrides,
  };
}

const OFFENDER_FILE = 'src/modules/finance/journal-entry.ts';
const APPROVED_FILE = 'src/modules/inventory/batch-condition-table.ts';
const STRATEGY_FILE = 'src/modules/inventory/batch-search-strategy.ts';

describe('data-dictionary vocabulary exception boundary', () => {
  it('lets every approved occurrence through, and only what is listed', () => {
    expect(DATA_DICTIONARY_VOCABULARY_EXCEPTIONS.length).toBe(13);
    expect(EXCEPTION_OCCURRENCE_TOTAL).toBe(14);

    // Each entry must describe a line that is really in the file it names, exactly `times` over.
    for (const item of DATA_DICTIONARY_VOCABULARY_EXCEPTIONS) {
      const text = read(item.file);
      const found = text.split('\n').filter((line) => line.trim() === item.line).length;
      expect(found, `${item.file}: ${item.line}`).toBe(item.times);
      expect(keywordOffendersInFile(item.file, `${item.line}\n`)).toEqual([]);
    }

    // The three files that carry the exception hold no other offender, and the exception covers
    // the whole of their debt: one occurrence listed for each occurrence found.
    for (const file of [APPROVED_FILE, STRATEGY_FILE, 'src/modules/inventory/batch-search-allocation.ts']) {
      expect(keywordOffendersInFile(file, read(file)), file).toEqual([]);
    }
    expect(vocabularyExceptionDrift(read)).toEqual([]);
  });

  it('still finds a keyword in application source the exception does not name', () => {
    const offenders = keywordOffendersInFile(OFFENDER_FILE, "export const KEY_FIELD = 'MATNR';\n");
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain(`${OFFENDER_FILE}:1:`);

    // The *same line* an approved file may hold is an offender anywhere else. The exception is
    // file-and-occurrence scoped, not a keyword exemption.
    const approvedLine = DATA_DICTIONARY_VOCABULARY_EXCEPTIONS[0].line;
    expect(keywordOffendersInFile(OFFENDER_FILE, `${approvedLine}\n`)).toHaveLength(1);
    expect(permittedOccurrences(OFFENDER_FILE, approvedLine)).toBe(0);
  });

  it('still finds a second occurrence in an approved file, in any shape', () => {
    // A new line in an approved file, mentioning an approved keyword.
    expect(keywordOffendersInFile(APPROVED_FILE, "const extraKey = 'MATNR';\n")).toHaveLength(1);
    // A copy of an excepted line, one past its cap of one.
    const once = "{ field: 'MATNR', title: 'Material' },";
    expect(keywordOffendersInFile(APPROVED_FILE, `${once}\n`)).toEqual([]);
    expect(keywordOffendersInFile(APPROVED_FILE, `${once}\n${once}\n`)).toHaveLength(1);
    // The two-line exception in the strategy module allows its two sites and no third.
    const twice = "const plantKey = keys.get('WERKS');";
    expect(permittedOccurrences(STRATEGY_FILE, twice)).toBe(2);
    expect(keywordOffendersInFile(STRATEGY_FILE, `${twice}\n${twice}\n`)).toEqual([]);
    expect(keywordOffendersInFile(STRATEGY_FILE, `${twice}\n${twice}\n${twice}\n`)).toHaveLength(1);
    // Widening `times` is not a way out either: the same drift check the guard runs reports the
    // mismatch for any table it is aimed at, so an over-declared cap fails on its own.
    expect(vocabularyExceptionDrift(read)).toEqual([]);
    const padded = DATA_DICTIONARY_VOCABULARY_EXCEPTIONS.map((item) => ({ ...item, times: item.times + 1 }));
    expect(vocabularyExceptionDrift(read, padded)).toHaveLength(padded.length);
    const missing = DATA_DICTIONARY_VOCABULARY_EXCEPTIONS.slice(0, -1);
    expect(vocabularyExceptionDrift(read, missing)).toEqual([]);
    // The two checks are independent, and that is what makes the pair safe: the scan consults the
    // shipped table, so editing a local copy cannot grant or revoke anything, and the drift check
    // is what forces the shipped table to keep describing the real lines. A guard test that
    // redeclared the table with one entry removed would therefore prove nothing about the scan —
    // which is why the guard itself runs both assertions in one case.
  });

  it('keeps every other keyword prohibited, including inside an approved file', () => {
    const unrelated = ['SAKNR', 'HKONT', 'KTOPL', 'VKORG', 'BUKRS', 'T009B', 'POPER'];
    for (const keyword of unrelated) {
      expect(keywordOffendersInFile(OFFENDER_FILE, `const value = '${keyword}';`), keyword).toHaveLength(1);
      expect(keywordOffendersInFile(APPROVED_FILE, `const value = '${keyword}';`), keyword).toHaveLength(1);
      expect(permittedOccurrences(APPROVED_FILE, `const value = '${keyword}';`), keyword).toBe(0);
    }
    // Case-sensitivity is part of the rule: ordinary English survives, and not because the
    // exception let it through.
    expect(keywordOffendersInFile('src/modules/finance/period.ts', "const tagMonth = 'tag month';")).toEqual([]);
    expect(keywordOffendersInFile('src/modules/finance/period.ts', "const tagMonth = 'TAG MONAT';")).toHaveLength(1);
  });

  it('cannot reach a DOM identifier or a file outside the stored-key contract', () => {
    // No entry may name a component file, where identifiers live, and no entry does.
    expect(EXCEPTION_FILE_PATTERN.test('src/app/config/batch-condition-tables/page.tsx')).toBe(false);
    expect(EXCEPTION_FILE_PATTERN.test('src/modules/inventory')).toBe(false);
    expect(EXCEPTION_FILE_PATTERN.test('src/modules/inventory/anything-else.ts')).toBe(false);
    expect(DATA_DICTIONARY_VOCABULARY_EXCEPTIONS.some((item) => item.file.endsWith('.tsx'))).toBe(false);
    expect(assertVocabularyExceptionShape).not.toThrow();

    // An entry naming a fourth file, a directory, or no rationale is refused before any scan runs.
    expect(() => assertVocabularyExceptionShape([entry({ file: 'src/modules/finance/journal-entry.ts' })]))
      .toThrow(/only the three batch modules/);
    expect(() => assertVocabularyExceptionShape([entry({ file: 'src/modules/inventory/**' })]))
      .toThrow(/only the three batch modules/);
    expect(() => assertVocabularyExceptionShape([entry({ rationale: '' })])).toThrow(/no rationale/);
    expect(() => assertVocabularyExceptionShape([entry({ times: 0 })])).toThrow(/whole number/);
    expect(() => assertVocabularyExceptionShape([entry(), entry()])).toThrow(/declared twice/);
    // An attribute assignment is the identifier rule business, and this table may not cover one:
    // not as a declaration, and not as a tolerated line inside an approved file either.
    expect(() => assertVocabularyExceptionShape([entry({ line: 'id="MATNR-FIELD"' })]))
      .toThrow(/attribute assignment/);
    expect(keywordOffendersInFile(APPROVED_FILE, 'id="MATNR-FIELD"\n')).toHaveLength(1);
    // A lower-case coded identifier is not this rule to grant, so it never appears here as a
    // permitted occurrence; the identifier case in the guard still owns it.
    expect(permittedOccurrences(APPROVED_FILE, 'id="matnr-field"')).toBe(0);
  });

  it('leaves the stored vocabulary, the validation list and the fingerprint shape alone', () => {
    // The names the exception tolerates are exactly the names the constraint accepts.
    const ddl = read('drizzle/9135_oma1_condition_table.sql');
    const constraint = /batch_condition_table_field_name_ck CHECK \(field_name in \(([^)]*)\)\)/.exec(ddl);
    expect(constraint).not.toBeNull();
    const permitted = constraint![1].match(/'([A-Z]+)'/g)!.map((value) => value.replaceAll("'", ''));
    expect(permitted).toEqual(['BWART', 'KUNNR', 'LGORT', 'LIFNR', 'MATKL', 'MATNR', 'MTART', 'SOBKZ', 'WERKS']);

    // The module list the screens offer and the validation read is the same nine, in the same
    // order, so nothing was renamed to make the guard green.
    const moduleText = read(APPROVED_FILE);
    const declared = [...moduleText.matchAll(/  \{ field: '([A-Z]+)', title: '/g)].map((match) => match[1]);
    expect(declared).toEqual(permitted);

    // Every keyword the exception tolerates is one of those nine: nothing outside the stored set
    // slips in under cover of the file being approved.
    const listed = new RegExp(`\\b(?:${KEYWORDS.join('|')})\\b`);
    const granted = new Set<string>();
    for (const item of DATA_DICTIONARY_VOCABULARY_EXCEPTIONS) {
      for (const match of item.line.matchAll(new RegExp(listed.source, 'g'))) granted.add(match[0]);
    }
    expect([...granted].sort()).toEqual(['KUNNR', 'LGORT', 'LIFNR', 'MATNR', 'WERKS']);
    for (const keyword of granted) expect(permitted, keyword).toContain(keyword);

    // The strategy key table still keys on field_name, the fingerprint column is still the stored
    // width, and the fingerprint is still `field=value` pairs ordered by position.
    const strategyDdl = read('drizzle/9140_mbc1_search_strategy.sql');
    expect(strategyDdl).toMatch(/batch_search_strategy_key \([\s\S]*?PRIMARY KEY \(client, record_number, field_name\)/);
    const schema = read('src/modules/inventory/schema.ts');
    expect(schema).toMatch(/keyFingerprint: varchar\('key_fingerprint', \{ length: 500 \}\)/);
    const strategy = read(STRATEGY_FILE);
    expect(strategy).toContain('function fingerprintOf(keys: StrategyKeyValue[]): string');
    expect(strategy).toContain('`${key.field}=${key.value}`');
    expect(strategy).toContain(".join('|')");
    expect(strategy).toMatch(/sort\(\(left, right\) => left\.position - right\.position\)/);

    // The copy the operator reads still names the plant key it always named.
    expect(read('src/modules/inventory/batch-search-allocation.ts')).toMatch(/field: 'WERKS',\n\s+title: /);
  });
});

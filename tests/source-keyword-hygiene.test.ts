/**
 * Source-system keywords stay out of the application, and aliases stay in the registry.
 *
 * The rule: a source-system keyword is allowed in exactly one place — the Term Registry alias
 * data, where it exists so a consultant can search for the transaction code they already know
 * and land on the Cairn screen. It is never allowed in an identifier, a table or column name,
 * a user-facing string, or a comment, because a code the product does not own teaches a new
 * consultant the wrong vocabulary and ties the reading of the codebase to a licence nobody
 * reading it may hold.
 *
 * Two older scans (SCR-021, SCR-022) already forbade a handful of these keywords in the sales
 * and distribution sources; this one covers every application source, so a new screen cannot
 * reintroduce what those two never watched. Matching is case-sensitive on purpose: the
 * keywords are uppercase in the source system, and a case-insensitive scan would flag ordinary
 * English words such as "tag" and "month" that the period schema legitimately uses.
 *
 * Transaction codes get their own rule, because they are the half the case-sensitive scan
 * cannot reach: a DOM identifier is written in lower case, so `oby7-variant` sails through a
 * list of uppercase keywords while teaching exactly the vocabulary the rule exists to keep
 * out. Identifiers are matched case-insensitively and only where an identifier can appear —
 * the value of an id, name, htmlFor, aria-labelledby, aria-describedby or data-testid — so
 * the scan cannot reach into prose, where "tag" and "month" live.
 *
 * The vocabulary is the registry's own alias data rather than a second list: a rule that
 * repeated the codes would go stale the moment a screen registered a new one, which is how
 * the identifiers in the allowlist below went unnoticed for five screens.
 *
 * The keyword scan makes exactly one exception, and it is not a keyword exception: fourteen lines
 * in three `src/modules/inventory/batch-*.ts` files name a field key that is *already stored* —
 * behind a `CHECK` constraint, inside two primary keys, and folded into the fingerprint duplicate
 * detection compares. `tests/hygiene-vocabulary.ts` holds them as exact file-and-line occurrences
 * with a cap on repetitions and a rationale each, and `assertVocabularyExceptionShape` stops the
 * scan if the table is widened. Renaming the names is a migration decision; it is not a way to
 * make this test green.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The keyword list, the scan, and the one exception the guard makes all live in
 * `./hygiene-vocabulary`, so this file and `tests/vocabulary-exception-boundary.test.ts` aim at
 * the same logic rather than at a copy of it. Transaction codes (FS00, OB13, OBY7, OB29) stay out
 * of the keyword list on purpose: those are the aliases the registry is for, and the identifier
 * scan below is the rule that watches them.
 */
import {
  assertVocabularyExceptionShape,
  keywordOffendersInFile,
  PATTERN,
  vocabularyExceptionDrift,
} from './hygiene-vocabulary';

/** Where a DOM identifier can appear. Values only, so prose is never scanned. */
const DOM_IDENTIFIER =
  /\b(?:id|name|htmlFor|aria-labelledby|aria-describedby|data-testid)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\})/g;

/** The transaction codes the registry holds as aliases, read from the seed itself. */
function registeredAliases(): string[] {
  const seed = readFileSync('scripts/seed.ts', 'utf8');
  const aliases = new Set<string>();
  for (const block of seed.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
    for (const alias of block[1].matchAll(/'([^']+)'/g)) aliases.add(alias[1]);
  }
  return [...aliases];
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every identifier value a component renders, and the subset built from a transaction code.
 * A template literal is read as written, `${...}` included: the prefix is the part that
 * carries the code, and the suffix is a record key.
 */
function domIdentifiers(): { all: Set<string>; offenders: Set<string> } {
  const aliases = registeredAliases();
  const all = new Set<string>();
  const offenders = new Set<string>();

  for (const path of applicationSources('src')) {
    if (!path.endsWith('.tsx')) continue;
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(DOM_IDENTIFIER)) {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
      if (!value) continue;
      all.add(value);
      const coded = aliases.some((alias) =>
        new RegExp(`(^|[^A-Za-z0-9])${escaped(alias)}([^A-Za-z0-9]|$)`, 'i').test(value),
      );
      if (coded) offenders.add(value);
    }
  }

  return { all, offenders };
}

/**
 * The attribute scan reads what a component renders as written. A prefix held in a variable
 * never reaches an attribute, so `const idPrefix = 'ob13-create'` kept five coded identifiers
 * out of the inventory below while the suite stayed green: ob13-create, ob13-change-,
 * fs00-block-, fs00-delete- and the three fs00-group- prefixes. Every literal on a line that
 * assigns an identifier prefix is read here too, so the class of hole is closed rather than
 * the five instances merely fixed.
 */
function codedPrefixLiterals(): string[] {
  const aliases = registeredAliases();
  const found: string[] = [];

  for (const path of applicationSources('src')) {
    if (!path.endsWith('.tsx')) continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (!/Prefix\s*=/.test(line)) return;
      for (const literal of line.matchAll(/[`'"]([^`'"]*)[`'"]/g)) {
        const value = literal[1] ?? '';
        const coded = aliases.some((alias) =>
          new RegExp(`(^|[^A-Za-z0-9])${escaped(alias)}([^A-Za-z0-9]|$)`, 'i').test(value),
        );
        if (coded) found.push(`${path}:${index + 1}: ${value}`);
      }
    });
  }

  return found;
}

/**
 * The identifiers that were already there when this rule was written: 59 of them across 16
 * component files, left by FS00, OB13, OBY7, OVXA, OVXG, OVXK and by the OB29 and OB37
 * screens. They were inventoried rather than fixed on the spot because every one of them is
 * also a selector in the browser harness, and renaming a selector nobody can execute is how a
 * round breaks silently: the suite stays green and the failure surfaces three screens later.
 *
 * The browser acceptance round has since run, and each screen was renamed while it was open
 * and its selectors could still be clicked. Forty-one of the 59 are paid: FS00, OB13, OBY7,
 * OB29 and OB37 carry house names now. The 18 that remain all belong to OVXA, OVXG and OVXK,
 * whose screens were accepted before the round and are not scheduled in it. The list must
 * keep shrinking as they go — the assertion below fails on an entry that no longer exists in
 * the sources, so paid-down debt cannot linger here as cover for new debt.
 *
 * One limit, stated rather than left implied: the inventory is keyed by identifier value, not
 * by file, so a new component that reused one of these exact values would pass. A new prefix
 * is caught, a copied one is not. The round checked, and none of the remaining values appears
 * in more than one component, so keying it by file would still cost length and buy nothing.
 */
const HISTORICAL_DOM_IDENTIFIERS = [
  'ovxa-assignment-list-title',
  'ovxa-division',
  'ovxa-form-title',
  'ovxa-sales-org',
  'ovxa-value-help-search',
  'ovxa-value-help-title',
  'ovxg-distribution-channel',
  'ovxg-division',
  'ovxg-name',
  'ovxg-sales-org',
  'ovxg-value-help-search',
  'ovxg-value-help-title',
  'ovxk-assignment-list-title',
  'ovxk-distribution-channel',
  'ovxk-form-title',
  'ovxk-sales-org',
  'ovxk-value-help-search',
  'ovxk-value-help-title'];

function applicationSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      applicationSources(path, found);
      continue;
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) found.push(path);
  }
  return found;
}

describe('source-system keyword hygiene', () => {
  it('keeps data-dictionary keywords out of every application source', () => {
    // Refuse to scan at all if the exception has been widened past the persisted-key contract.
    assertVocabularyExceptionShape();
    const offenders: string[] = [];
    for (const path of applicationSources('src')) {
      offenders.push(...keywordOffendersInFile(path, readFileSync(path, 'utf8')));
    }
    // The exception is the debt and nothing else: every excepted occurrence must still be there,
    // in exactly the number of lines declared. Retiring one by migration shrinks the table, and
    // duplicating one past its cap fails even though the scan above would let it through.
    expect(vocabularyExceptionDrift((file) => readFileSync(file, 'utf8'))).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it('keeps the transaction codes where they belong: the registry alias data', () => {
    const seed = readFileSync('scripts/seed.ts', 'utf8');
    // The aliases a consultant searches by. Every one is a transaction code, and none of them
    // is a data-dictionary keyword, which is the distinction this suite exists to hold.
    for (const alias of ['OB13', 'FS00', 'FSP0', 'FSS0', 'OBY7', 'OB29', 'OB37', 'OBBO']) {
      expect(seed).toContain(`'${alias}'`);
    }
    expect(seed).not.toMatch(PATTERN);
  });

  it('keeps transaction codes out of DOM identifiers, except the ones already inventoried', () => {
    const { offenders } = domIdentifiers();
    const historical = new Set(HISTORICAL_DOM_IDENTIFIERS);
    const newOffenders = [...offenders].filter((value) => !historical.has(value)).sort();
    expect(newOffenders).toEqual([]);
  });

  it('holds the inventory to what is still there, so it shrinks as the debt is paid', () => {
    const { all } = domIdentifiers();
    const stale = HISTORICAL_DOM_IDENTIFIERS.filter((value) => !all.has(value)).sort();
    expect(stale).toEqual([]);
  });

  it('keeps transaction codes out of the prefixes identifiers are built from', () => {
    expect(codedPrefixLiterals()).toEqual([]);
  });

  it('keeps user-facing labels free of the keywords the two older scans watch', () => {
    const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');
    expect(i18n).not.toMatch(/\b(?:VKORG|BUKRS|VTWEG|VTEXT|SPART)\b/i);
    // A label is what a user reads, so it names the field and nothing else.
    expect(i18n).toContain("'glAccount.sortKey': 'Sort Key'");
    expect(i18n).toContain("'glAccount.accountGroup': 'Account Group'");
  });
});

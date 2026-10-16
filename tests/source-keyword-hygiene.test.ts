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
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Data-dictionary field and table keywords. Transaction codes (FS00, OB13, OBY7, OB29) are
 * deliberately absent: those are the aliases the registry is for.
 */
const KEYWORDS = [
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

const PATTERN = new RegExp(`\\b(?:${KEYWORDS.join('|')})\\b`);

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
    const offenders: string[] = [];
    for (const path of applicationSources('src')) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (PATTERN.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
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

  it('keeps user-facing labels free of the keywords the two older scans watch', () => {
    const i18n = readFileSync('src/platform/i18n/index.ts', 'utf8');
    expect(i18n).not.toMatch(/\b(?:VKORG|BUKRS|VTWEG|VTEXT|SPART)\b/i);
    // A label is what a user reads, so it names the field and nothing else.
    expect(i18n).toContain("'glAccount.sortKey': 'Sort Key'");
    expect(i18n).toContain("'glAccount.accountGroup': 'Account Group'");
  });
});

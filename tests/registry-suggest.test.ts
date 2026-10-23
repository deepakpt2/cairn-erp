import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { equallyNear, exactOwnIdentifier, rankRegistry, rankSuggestions, type SuggestionSource } from '@/platform/registry/suggest';

function term(partial: Partial<SuggestionSource> & { id: string; title: string; routePath?: string | null }): SuggestionSource & { id: string; routePath?: string | null } {
  return {
    id: partial.id,
    ourCode: partial.ourCode ?? null,
    ourTable: partial.ourTable ?? null,
    title: partial.title,
    description: partial.description ?? null,
    aliases: partial.aliases ?? [],
    isSearchable: partial.isSearchable,
    routePath: partial.routePath,
  };
}

describe('registry suggestions', () => {
  it('ranks an exact tcode before a name that contains the same word', () => {
    const hits = rankSuggestions([
      term({ id: 'name', title: 'OMSK overview', ourCode: 'OTHER' }),
      term({ id: 'tcode', title: 'Define valuation classes', ourCode: 'CFG.INV.VALCLASS.DEFINE', aliases: ['OMSK'] }),
    ], 'OMSK', 8);
    expect(hits[0].item.id).toBe('tcode');
    expect(hits[0].field).toBe('ALIAS');
    expect(hits[0].kind).toBe('EXACT');
    expect(hits[0].matchedText).toBe('OMSK');
  });

  it('ranks an exact custom code before a name', () => {
    const hits = rankSuggestions([
      term({ id: 'name', title: 'Plant', ourCode: 'ORG.SITE' }),
      term({ id: 'code', title: 'Something else', ourCode: 'CFG.ORG.PLANT.DEFINE' }),
    ], 'plant', 8);
    expect(hits[0].item.id).toBe('code');
    expect(hits[0].field).toBe('CODE');
    expect(hits[0].kind).toBe('EXACT');
  });

  it('ranks a name before an explanation', () => {
    const hits = rankSuggestions([
      term({ id: 'explain', title: 'Other screen', description: 'Run an inventory count' }),
      term({ id: 'name', title: 'Inventory count', description: 'Something else' }),
    ], 'inventory count', 8);
    expect(hits.map((hit) => hit.item.id)).toEqual(['name', 'explain']);
    expect(hits[0].field).toBe('TITLE');
    expect(hits[1].field).toBe('DESCRIPTION');
    expect(hits.every((hit) => hit.kind === 'EXACT')).toBe(true);
  });

  it('ranks a phrase above the same words in a different order', () => {
    const hits = rankSuggestions([
      term({ id: 'reversed', title: 'Company plant assignment' }),
      term({ id: 'order', title: 'Plant company assignment' }),
    ], 'plant company', 8);
    expect(hits.map((hit) => hit.item.id)).toEqual(['order', 'reversed']);
    expect(hits.every((hit) => hit.kind === 'EXACT' && hit.field === 'TITLE')).toBe(true);
  });

  it('prefers the tighter name when both contain the word', () => {
    const hits = rankSuggestions([
      term({ id: 'long', title: 'The plant master' }),
      term({ id: 'short', title: 'The plant' }),
    ], 'plant', 8);
    expect(hits.map((hit) => hit.item.id)).toEqual(['short', 'long']);
  });

  it('ignores a word shorter than two letters', () => {
    const hits = rankSuggestions([term({ id: 'plant', title: 'Plant' })], 'a plant', 8);
    expect(hits[0].kind).toBe('EXACT');
    expect(rankSuggestions([term({ id: 'plant', title: 'Plant' })], 'a', 8)).toEqual([]);
  });

  it('treats G/L as one word and F-28 as the alias', () => {
    const gl = rankSuggestions([
      term({ id: 'gl', title: 'G/L account master create', ourCode: 'FIN.GL.CREATE' }),
      term({ id: 'other', title: 'Plant', ourCode: 'ORG.PLANT' }),
    ], 'g/l account', 8);
    expect(gl[0].item.id).toBe('gl');
    expect(gl[0].kind).toBe('EXACT');
    expect(gl[0].field).toBe('TITLE');

    const clearing = rankSuggestions([
      term({ id: 'clear', title: 'Clear customer items', ourCode: 'FIN.AR.CLEAR', aliases: ['F-28'] }),
    ], 'F-28', 8);
    expect(clearing[0].field).toBe('ALIAS');
    expect(clearing[0].kind).toBe('EXACT');
  });

  it('uses a changed spelling only when nothing matches exactly', () => {
    const nearest = rankSuggestions([
      term({ id: 'val', title: 'Define valuation classes', aliases: ['OMSK'], ourCode: 'CFG.INV.VALCLASS.DEFINE' }),
      term({ id: 'classes', title: 'Define classes', ourCode: 'CFG.PROC.CLASS.DEFINE' }),
    ], 'valution class', 8);
    expect(nearest[0].item.id).toBe('val');
    expect(nearest[0].kind).toBe('NEAREST');
    expect(nearest[0].field).toBe('TITLE');
    expect(nearest.some((hit) => hit.item.id === 'classes')).toBe(false);

    const hidden = rankSuggestions([
      term({ id: 'exact', title: 'Valuation classes' }),
      term({ id: 'typo', title: 'Other', aliases: ['VALUTION'] }),
    ], 'valuation', 8);
    expect(hidden.map((hit) => hit.item.id)).toEqual(['exact']);
  });

  it('treats a misspelt tcode as the nearest alias, not a new code', () => {
    const hits = rankSuggestions([
      term({ id: 'omjj', title: 'Configure movement types', aliases: ['OMJJ'], ourCode: 'CFG.INV.MOVETYPE.CONFIG' }),
      term({ id: 'omsk', title: 'Define valuation classes', aliases: ['OMSK'], ourCode: 'CFG.INV.VALCLASS.DEFINE' }),
      term({ id: 'oms2', title: 'Define material types', aliases: ['OMS2'], ourCode: 'CFG.INV.MATERIALTYPE.DEFINE' }),
    ], 'OMSJ', 8);
    expect(hits.every((hit) => hit.field === 'ALIAS' && hit.kind === 'NEAREST')).toBe(true);
    expect(hits.map((hit) => hit.item.id)).toEqual(['oms2', 'omsk', 'omjj']);
    expect(equallyNear(hits[0], hits[1], 'OMSJ')).toBe(true);
    expect(equallyNear(hits[0], hits[2], 'OMSJ')).toBe(false);
  });

  it('allows one extra word when nothing matches exactly', () => {
    const hits = rankSuggestions([
      term({ id: 'val', title: 'Valuation classes' }),
    ], 'valuation class extra', 8);
    expect(hits[0].kind).toBe('NEAREST');
    expect(hits[0].field).toBe('TITLE');
  });

  it('finds credit control area only in an existing explanation', () => {
    const hits = rankSuggestions([
      term({
        id: 'credit',
        ourCode: 'CFG.FIN.CREDIT.DEFINE',
        title: 'Customer credit management',
        description: 'Maintain customer credit for a credit control area. This screen does not create one.',
        routePath: '/finance/credit',
      }),
    ], 'credit control area', 8);
    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe('DESCRIPTION');
    expect(hits[0].kind).toBe('EXACT');
    expect(hits[0].item.routePath).toBe('/finance/credit');
  });

  it('does not invent a credit-control-area screen', () => {
    const hits = rankSuggestions([
      term({
        id: 'credit',
        ourCode: 'FIN.CREDIT.MAINTAIN',
        title: 'Customer credit management',
        description: 'Maintain a customer credit limit',
        routePath: '/finance/credit',
      }),
    ], 'credit control area', 8);
    expect(hits).toEqual([]);
  });

  it('does not match an unrelated spelling', () => {
    expect(rankSuggestions([
      term({ id: 'x', title: 'Plant', aliases: ['OMSK'] }),
    ], 'XXXX', 8)).toEqual([]);
  });

  it('keeps an exact custom code ahead of an alias that looks the same', () => {
    const items = [
      term({ id: 'alias', title: 'Other', aliases: ['CFG.INV.VALCLASS.DEFINE'] }),
      term({ id: 'code', title: 'Valuation', ourCode: 'CFG.INV.VALCLASS.DEFINE' }),
    ];
    expect(exactOwnIdentifier(items, 'cfg.inv.valclass.define')?.item.id).toBe('code');
    expect(exactOwnIdentifier(items, 'OMSK')).toBeNull();
    expect(rankRegistry(items, 'CFG.INV.VALCLASS.DEFINE', 8)[0].item.id).toBe('code');
  });

  it('limits the list', () => {
    const items = Array.from({ length: 5 }, (_, index) => term({ id: `t${index}`, title: `Plant ${index}` }));
    expect(rankSuggestions(items, 'plant', 2)).toHaveLength(2);
  });

  it('wires the registry page to the suggestion list without giving up the form', () => {
    const page = readFileSync('src/app/registry/page.tsx', 'utf8');
    const search = readFileSync('src/app/registry/RegistrySearch.tsx', 'utf8');
    const action = readFileSync('src/app/registry/actions.ts', 'utf8');
    const command = readFileSync('src/app/command.ts', 'utf8');
    const index = readFileSync('src/platform/registry/index.ts', 'utf8');
    expect(page).toContain('RegistrySearch');
    expect(page).toContain('key={query}');
    expect(search).toContain('method="get"');
    expect(search).toContain('name="q"');
    expect(search).toContain('suggestRegistryTerms');
    expect(action).toContain('suggestRegistry');
    expect(command).toContain('resolveTerm');
    expect(command).toContain('matchUnique');
    expect(index).toContain('rankRegistry');
    expect(index).not.toContain('pg_trgm');
  });
});

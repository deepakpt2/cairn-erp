import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MIGO_ACTIONS, MIGO_REFERENCES, migoMatrix, resolveMigoCell } from '../src/modules/inventory/migo';

/**
 * SCR-139 / MIGO contract: one screen carries the whole action/reference vocabulary, and
 * every cell resolves to exactly one answer — posts here, delivered elsewhere with a link,
 * or refused by name with the capability that would deliver it.
 */
const page = readFileSync('src/app/inventory/migo/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/migo/MigoShell.tsx', 'utf8');
const actions = readFileSync('src/app/inventory/migo/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/goods-issue.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-139 MIGO action/reference matrix', () => {
  it('carries SAP’s action list and reference list on one screen', () => {
    expect(MIGO_ACTIONS.map((a) => a.value)).toEqual(['A01', 'A02', 'A03', 'A04', 'A07']);
    expect(MIGO_REFERENCES.map((r) => r.value)).toEqual(['R01', 'R04', 'R05', 'R08', 'R10']);
    expect(shell).toContain('data-migo-action={migoAction}');
    expect(shell).toContain('data-migo-reference={reference}');
    expect(page).toContain('INV.MIGO.POST');
  });

  it('resolves every cell to exactly one of the three answers', () => {
    const cells = migoMatrix();
    expect(cells).toHaveLength(25);
    for (const cell of cells) {
      expect(['POST_HERE', 'ELSEWHERE', 'REFUSED']).toContain(cell.resolution.kind);
      if (cell.resolution.kind === 'ELSEWHERE') {
        expect(cell.resolution.route.startsWith('/')).toBe(true);
        expect(cell.resolution.capability).toMatch(/^INV\./);
      }
      if (cell.resolution.kind === 'REFUSED') {
        expect(cell.resolution.reason.length).toBeGreaterThan(20);
      }
    }
  });

  it('posts exactly four cells — the order’s two movements, the transfer and the cancellation', () => {
    const posting = migoMatrix().filter((c) => c.resolution.kind === 'POST_HERE');
    expect(posting).toHaveLength(4);
    expect(posting.map((c) => `${c.action.value}+${c.reference.value}`))
      .toEqual(['A01+R08', 'A03+R05', 'A04+R10', 'A07+R08']);
    expect(posting.map((c) => c.resolution.kind === 'POST_HERE' && c.resolution.form))
      .toEqual(['RECEIPT', 'REVERSE', 'TRANSFER', 'ISSUE']);
    expect(resolveMigoCell('A07', 'R08')).toMatchObject({ kind: 'POST_HERE', movement: '261' });
    expect(resolveMigoCell('A01', 'R08')).toMatchObject({ kind: 'POST_HERE', movement: '101' });
    expect(resolveMigoCell('A04', 'R10')).toMatchObject({ kind: 'POST_HERE', movement: '311/301/321' });
  });

  it('links the delivered movements rather than reimplementing them', () => {
    expect(resolveMigoCell('A01', 'R01')).toMatchObject({ kind: 'ELSEWHERE', capability: 'INV.GR.POST' });
    expect(resolveMigoCell('A07', 'R04')).toMatchObject({ kind: 'ELSEWHERE', capability: 'INV.GI.POST' });
    expect(resolveMigoCell('A04', 'R05')).toMatchObject({ kind: 'REFUSED', deliveredBy: 'R10' });
    expect(resolveMigoCell('A03', 'R01')).toMatchObject({ kind: 'REFUSED', deliveredBy: 'R05' });
    expect(resolveMigoCell('A07', 'R04')).toMatchObject({ kind: 'ELSEWHERE', capability: 'INV.GI.POST' });
    expect(shell).toContain('href={cell.route}');
  });

  it('refuses the rest by name, naming the capability that would deliver it', () => {
    expect(resolveMigoCell('A02', 'R01')).toMatchObject({ kind: 'REFUSED', deliveredBy: null });
    expect(resolveMigoCell('A01', 'R04')).toMatchObject({ kind: 'REFUSED', deliveredBy: null });
    expect(shell).toContain('cell.deliveredBy');
  });

  it('returns no cell until both selectors are chosen', () => {
    expect(resolveMigoCell('', '')).toBeNull();
    expect(resolveMigoCell('A07', '')).toBeNull();
    expect(resolveMigoCell('', 'R08')).toBeNull();
  });

  it('posts only its own cell on the server, whatever the form sends', () => {
    expect(actions).toContain('resolveMigoCell(action, reference)');
    expect(actions).toContain("if (cell.kind !== 'POST_HERE')");
    expect(actions).toContain("}, 'MIGO')");
    // The service, not the form, decides the screen a movement is judged against; 'SALES' is the delivery's
    // own context, so a 601 typed into MIGO or the goods issue screen is refused by name there too.
    expect(service).toContain("screen: 'MB1A' | 'MIGO' | 'SALES' = 'MB1A'");
  });

  it('offers 261 on MIGO alone, with MB1A keeping its own two movements', () => {
    expect(service).toContain("export const MB1A_SCENARIOS = GOODS_ISSUE_SCENARIOS.filter((s) => s.screen === 'MB1A')");
    expect(service).toContain("export const MIGO_ISSUE_SCENARIOS = GOODS_ISSUE_SCENARIOS.filter((s) => s.screen === 'MIGO')");
    const mb1aPage = readFileSync('src/app/inventory/goods-issue/page.tsx', 'utf8');
    expect(mb1aPage).toContain('MB1A_SCENARIOS');
  });

  it('drills the posted document to MB03 and its journal to FB03', () => {
    expect(shell).toContain('/inventory/material-documents?document=');
    expect(shell).toContain('/finance/journal/document?document=');
    expect(messages).toContain("'migo.title'");
    expect(messages).toContain("'migo.itemsHeader'");
  });

  it('carries a receipt form of its own for A01 + R08, and posts through the receipt service', () => {
    expect(shell).toContain("cell.form === 'RECEIPT'");
    expect(shell).toContain("cell.form === 'ISSUE'");
    expect(shell).toContain('data-receipt-document');
    expect(shell).toContain('name="storageLocation"');
    expect(shell).toContain("name=\"quantity\"");
    expect(actions).toContain('postProductionReceipt');
    expect(actions).toContain("cell.movement !== '101'");
    expect(messages).toContain("'migo.receiptHeader'");
  });

  it('carries a transfer form of its own for A04 + R10, and posts through the transfer service', () => {
    expect(shell).toContain("cell.form === 'TRANSFER'");
    expect(shell).toContain('data-transfer-document');
    expect(shell).toContain('name="movementTypeCode"');
    expect(shell).toContain('name="issuingStorageLocation"');
    expect(shell).toContain('name="receivingStorageLocation"');
    expect(shell).toContain('cell.movements');
    expect(actions).toContain('postTransfer(');
    expect(actions).toContain("cell.form !== 'TRANSFER'");
    expect(messages).toContain("'migo.transferHeader'");
  });

  it('registers INV.MIGO.POST on its route with MIGO as the alias', () => {
    expect(registry).toContain("'INV.MIGO.POST'");
    expect(registry).toContain("route: '/inventory/migo'");
    expect(registry).toMatch(/INV\.MIGO\.POST[\s\S]{0,600}aliases: \['MIGO'\]/);
  });
});

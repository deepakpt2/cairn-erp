import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-125 / MB51 UI contract: the list is gated on INV.MATERIALDOC.LIST, takes
 * its tenant scope from the session, requires the posting-date range, carries
 * every selection and row field the package names, and its drill-down lands on
 * a read-only document display on the same capability.
 */
const capability = 'INV.MATERIALDOC.LIST';
const page = readFileSync('src/app/inventory/material-document-list/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/material-document-list/MaterialDocumentListShell.tsx', 'utf8');
const display = readFileSync('src/app/inventory/material-documents/page.tsx', 'utf8');
const service = readFileSync('src/modules/inventory/material-document-list.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-125 material document list UI contract', () => {
  it('gates both screens on the exact capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const MATERIAL_DOC_LIST_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, MATERIAL_DOC_LIST_CAPABILITY)');
    expect(display).toContain('can(session, MATERIAL_DOC_LIST_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(shell).toContain('mdList.capabilityMissing');
  });

  it('requires the posting-date range on screen and in the service', () => {
    expect(shell).toContain('name="postingDateFrom" type="date" required');
    expect(shell).toContain('name="postingDateTo" type="date" required');
    expect(service).toContain('A posting date range is required.');
  });

  it('carries every selection the package names', () => {
    for (const name of [
      'materialFrom', 'materialTo', 'plantFrom', 'plantTo',
      'storageLocationFrom', 'storageLocationTo', 'movementTypeFrom', 'movementTypeTo',
      'postingDateFrom', 'postingDateTo', 'documentDateFrom', 'documentDateTo',
      'stockType', 'purchaseOrderFrom', 'purchaseOrderTo', 'userName', 'maxHits',
    ]) {
      expect(shell, name).toContain(`name="${name}"`);
    }
  });

  it('shows every row field the package names', () => {
    for (const key of [
      'mdList.document', 'mdList.item', 'mdList.movementType', 'mdList.direction',
      'mdList.material', 'mdList.description', 'mdList.entryQuantity', 'mdList.baseQuantity',
      'mdList.unit', 'mdList.value', 'mdList.currency', 'mdList.plant', 'mdList.storageLocation',
      'mdList.stockType', 'mdList.postingDate', 'mdList.documentDate', 'mdList.headerText',
      'mdList.status', 'mdList.purchaseOrder', 'mdList.itemText', 'mdList.user', 'mdList.journal',
    ]) {
      expect(shell, key).toContain(key);
    }
  });

  it('drills to a read-only document display that reads the ledger', () => {
    expect(service).toContain('`/inventory/material-documents?document=${encodeURIComponent');
    expect(shell).toContain('href={row.drillDown}');
    expect(display).toContain('getMaterialDocument(session.user.client');
    expect(display).toContain('mdDoc.lines');
    expect(display).not.toMatch(/\bpostGoodsReceipt\b|\breverseGoodsReceipt\b/);
  });

  it('never hides a reversed document', () => {
    expect(service).not.toMatch(/status\s*=\s*'POSTED'/);
    expect(shell).toContain('mdList.status');
    expect(service).toContain('Documents that stand reversed are listed with that status');
  });

  it('is registered in the catalogue with the MB51 alias', () => {
    expect(registry).toContain(`code: '${capability}'`);
    expect(registry).toContain(`ourCode: '${capability}', termType: 'TRANSACTION'`);
    expect(registry).toContain("aliases: ['MB51']");
    expect(registry).toContain("route: '/inventory/material-document-list'");
    expect(messages).toContain("'mdList.title'");
    expect(messages).toContain("'mdDoc.title'");
  });

  it('adds no state: the service only reads the ledger', () => {
    expect(service).not.toMatch(/\binsert into\b/i);
    expect(service).not.toMatch(/\bupdate .* set\b/i);
    expect(service).not.toMatch(/\bdelete from\b/i);
    expect(service).toContain('from material_document_line l');
    expect(service).toContain('join material_document d');
  });
});

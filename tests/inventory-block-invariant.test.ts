import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PHYSICAL_INVENTORY_ROUTE } from '../src/modules/inventory/physical-inventory';

/**
 * SCR-143 / MI01 hardening — the block is an invariant, not a fact about today's files.
 *
 * Every module that writes stock must consult the posting block. Before this round two of them
 * did not — the reversal engine and the goods-receipt reversal — and a control with a known
 * bypass is worse than no control, because the book then claims a block it cannot enforce.
 */
const MODULE_DIR = 'src/modules/inventory';

/** Modules that write stock quantities. Anything appearing here must also guard. */
const stockWriters = (): string[] => readdirSync(MODULE_DIR)
  .filter((file) => file.endsWith('.ts') && file !== 'schema.ts')
  .filter((file) => {
    const source = readFileSync(`${MODULE_DIR}/${file}`, 'utf8');
    // Reads and displays may mention the table; only these shapes write it.
    return /insert\s+into\s+stock_quantity|tx\.update\(stockQuantity\)|do update set quantity\s*=/.test(source);
  });

/**
 * One module writes `stock_quantity` and is deliberately not asked about the block: the count's own
 * difference posting (MI07). `assertInventoryCountOpen` carries no exemption for the document that
 * set the block, so requiring it there would refuse the posting of the very differences the count
 * exists to produce, and a blocked document could never be finished. The half of the invariant that
 * does belong to it is the exclusive scope lock over the materials it moves, and the case below
 * insists on it, so the exemption cannot quietly become the bypass SCR-143 closed.
 */
const COUNT_OWN_POSTING = 'physical-inventory-posting.ts';

describe('SCR-143 the posting block reaches every stock-writing module', () => {
  it('finds the stock writers at all, so an empty pass cannot be mistaken for a green one', () => {
    const writers = stockWriters();
    expect(writers.length).toBeGreaterThanOrEqual(5);
    expect(writers).toContain('goods-issue.ts');
    expect(writers).toContain('material-document-reversal.ts');
  });

  it('has every one of them consulting the guard', () => {
    const unguarded = stockWriters()
      .filter((file) => file !== COUNT_OWN_POSTING)
      .filter((file) => !readFileSync(`${MODULE_DIR}/${file}`, 'utf8').includes('assertInventoryCountOpen'));
    expect(unguarded).toEqual([]);
    expect(readFileSync(`${MODULE_DIR}/${COUNT_OWN_POSTING}`, 'utf8'))
      .toMatch(/lockStockScope\(tx, input\.client, items\.map\(\(item\) => item\.material_number\), 'EXCLUSIVE'\)/);
  });

  it('covers both reversal paths, which were the real bypass', () => {
    const reversal = readFileSync(`${MODULE_DIR}/material-document-reversal.ts`, 'utf8');
    const receipt = readFileSync(`${MODULE_DIR}/goods-receipt.ts`, 'utf8');
    expect(reversal).toContain('assertInventoryCountOpen');
    expect(receipt).toContain('assertInventoryCountOpen');
    // The receipt guards both the posting and its reversal, not just the posting.
    expect((receipt.match(/assertInventoryCountOpen/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('locks the material scope shared on postings and exclusive on creation', () => {
    const service = readFileSync(`${MODULE_DIR}/physical-inventory.ts`, 'utf8');
    expect(service).toContain("mode: 'SHARED' | 'EXCLUSIVE'");
    expect(service).toContain('pg_advisory_xact_lock_shared');
    expect(service).toContain('pg_advisory_xact_lock(');
    // Sorted, so two postings over the same pair cannot deadlock.
    expect(service).toContain('.sort()');
    // The guard takes the shared lock itself: no caller can forget it.
    expect(service).toMatch(/assertInventoryCountOpen[\s\S]{0,400}lockStockScope\(tx, client, \[movement\.materialNumber\], 'SHARED'\)/);
    // Creation takes the exclusive lock on its own materials. SCR-147 moved creation into the
    // writer that creation and the recount share, so the call names that writer's `spec`.
    expect(service).toMatch(/lockStockScope\(tx, spec\.client, materials, 'EXCLUSIVE'\)/);
  });

  it('bumps the version and records the block release as its own fact', () => {
    const service = readFileSync(`${MODULE_DIR}/physical-inventory.ts`, 'utf8');
    expect(service).toContain('version: header.version + 1');
    expect(service).toContain('blockReleased: header.postingBlock');
  });

  it('registers the route the invariant belongs to', () => {
    expect(PHYSICAL_INVENTORY_ROUTE).toBe('/inventory/physical-inventory');
  });
});

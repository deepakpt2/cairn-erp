import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  PHYSICAL_INVENTORY_CANCEL_CAPABILITY,
  PHYSICAL_INVENTORY_CREATE_CAPABILITY,
  PHYSICAL_INVENTORY_ROUTE,
} from '../src/modules/inventory/physical-inventory';

/**
 * SCR-142 / MI01 screen contract: the count is created from a plant, an optional location, a
 * date and a material grid; the block is a checkbox that means something; and the page says
 * plainly that it posts nothing.
 */
const page = readFileSync('src/app/inventory/physical-inventory/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/physical-inventory/PhysicalInventoryShell.tsx', 'utf8');
const actions = readFileSync('src/app/inventory/physical-inventory/actions.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-142 physical inventory screen', () => {
  it('gates the page on both capabilities and its own route', () => {
    expect(PHYSICAL_INVENTORY_CREATE_CAPABILITY).toBe('INV.PHYINV.CREATE');
    expect(PHYSICAL_INVENTORY_CANCEL_CAPABILITY).toBe('INV.PHYINV.CANCEL');
    expect(PHYSICAL_INVENTORY_ROUTE).toBe('/inventory/physical-inventory');
    expect(page).toContain('INV.PHYINV.CREATE');
    expect(page).toContain('PHYSICAL_INVENTORY_CANCEL_CAPABILITY');
    expect(actions).toContain('requireSession(PHYSICAL_INVENTORY_ROUTE)');
  });

  it('carries the package’s fields and none of the refused ones', () => {
    for (const field of ['plant', 'storageLocation', 'plannedCountDate', 'postingBlock']) {
      expect(shell).toContain(`name="${field}"`);
    }
    expect(shell).toContain('name={`material-${n}`}');
    expect(shell).not.toContain('name="companyCode"');
    // The year is never typed; it is carried hidden, and only to identify a document for cancelling.
    expect(shell).toContain('<input type="hidden" name="fiscalYear"');
    expect(shell).not.toContain('name="batch"');
    expect(shell).not.toContain('name="specialStock"');
    expect(shell).not.toContain('cycleCount');
  });

  it('derives the company code and the fiscal year instead of asking for them', () => {
    expect(messages).toContain("'mi01.headerHint'");
    expect(shell).toContain('createState.document.companyCode');
    expect(shell).toContain('createState.document.fiscalYear');
  });

  it('says that a count posts nothing, and offers the cancellation that lifts a block', () => {
    expect(shell).toContain("t('mi01.countDeferred')");
    expect(shell).toContain('cancelPhysicalInventoryAction');
    expect(shell).toContain('data-posting-block');
    expect(actions).toContain('PHYSICAL_INVENTORY_CANCEL_CAPABILITY');
  });

  it('names the block in the screen’s own words', () => {
    expect(messages).toMatch(/'mi01.postingBlockHint': '.*cannot be received, issued or transferred/);
    expect(messages).toContain("'mi01.blocked'");
  });

  it('registers the capability with MI01 and MI02 as aliases only', () => {
    expect(registry).toContain("'INV.PHYINV.CREATE'");
    expect(registry).toContain("'INV.PHYINV.CANCEL'");
    expect(registry).toContain("route: '/inventory/physical-inventory'");
    expect(registry).toMatch(/INV\.PHYINV\.CREATE[\s\S]{0,400}aliases: \['MI01', 'MI02'\]/);
  });
});

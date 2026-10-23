import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The catalogue must not deny a batch master that already stands.
 * These sentences describe the procurement and transfer path. They do not add a screen.
 */
const registry = readFileSync('scripts/seed.ts', 'utf8');

function entry(code: string): string {
  const at = registry.indexOf(`ourCode: '${code}'`);
  expect(at, code).toBeGreaterThan(-1);
  return registry.slice(at, registry.indexOf('ourCode:', at + 10));
}

describe('catalogue sentences for a standing batch', () => {
  it('does not say the batch master is missing', () => {
    expect(registry).not.toMatch(/no batch master/);
    expect(registry).not.toMatch(/batch is deferred by name/);
    expect(registry).not.toMatch(/later batch master/);
    expect(registry).not.toMatch(/do not yet carry a batch/);
    expect(registry).not.toMatch(/because stock has no batch/);
  });

  it('says the stock overview reads a named batch and does not create one', () => {
    const text = entry('INV.STOCK.VIEW');
    expect(text).toMatch(/A named batch is shown under the stock type/);
    expect(text).toMatch(/does not create a batch/);
    expect(text).toMatch(/In-transit stock is deferred by name/);
  });

  it('says a goods issue, a receipt and a transfer use a standing batch', () => {
    expect(entry('INV.GI.POST')).toMatch(/uses the batch already entered and does not create a batch/);
    expect(entry('INV.GR.POST')).toMatch(/This posting does not create a batch/);
    expect(entry('INV.TRANSFER.POST')).toMatch(/does not create a batch/);
  });

  it('says display shows the stored batch and does not type one', () => {
    expect(entry('PROC.PO.DISPLAY')).toMatch(/This screen has no batch input/);
  });
});

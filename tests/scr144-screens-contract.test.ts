import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-144 stage 4 — the three surfaces, pinned by source.
 *
 * The engine could convert before this round; nothing could reach it. These assertions are about
 * reachability rather than behaviour: that every posting form on MIGO accepts a unit, that a
 * conversion can be maintained and removed from a screen, and that a drifted dimension can be
 * repaired from the screen that found it.
 */
const read = (path: string): string => readFileSync(path, 'utf8');

const MIGO = 'src/app/inventory/migo/MigoShell.tsx';
const MIGO_ACTIONS = 'src/app/inventory/migo/actions.ts';
const UOM_PAGE = 'src/app/inventory/uom-conversion/page.tsx';
const UOM_SHELL = 'src/app/inventory/uom-conversion/UomShell.tsx';
const UOM_ACTIONS = 'src/app/inventory/uom-conversion/actions.ts';
const RECON_PAGE = 'src/app/inventory/stock-reconcile/page.tsx';
const RECON_SHELL = 'src/app/inventory/stock-reconcile/ReconcileShell.tsx';

describe('SCR-144 the screens reach the engine', () => {
  it('gives all three MIGO posting forms an entry unit', () => {
    const shell = read(MIGO);
    // Issue is per line, receipt and transfer are one unit for the document.
    expect(shell).toContain('name={`unit-${n}`}');
    expect((shell.match(/name="unit"/g) ?? []).length).toBe(2);
    expect(shell).toContain("t('migo.entryUnit')");
  });

  it('passes the entry unit through every MIGO action into its service', () => {
    const actions = read(MIGO_ACTIONS);
    expect(actions).toContain('entryUnit: text(form, `unit-${n}`) || undefined');
    expect((actions.match(/entryUnit: text\(form, 'unit'\)/g) ?? []).length).toBe(2);
  });

  it('maintains and removes a conversion from its own screen', () => {
    const shell = read(UOM_SHELL);
    expect(shell).toContain('name="alternativeUnit"');
    expect(shell).toContain('name="numerator"');
    expect(shell).toContain('name="denominator"');
    expect(shell).toContain('data-remove-conversion');
    // The ratio is shown as it was stated, not as a computed decimal.
    expect(shell).toContain('{row.numerator}/{row.denominator}');
    expect(read(UOM_PAGE)).toContain('INV.STOCK.UOM');
    expect(read(UOM_ACTIONS)).toContain('defineUomConversion');
  });

  it('reconciles a plant and rebuilds a drifted dimension from the report', () => {
    const shell = read(RECON_SHELL);
    expect(shell).toContain('data-reconcile-verdict');
    expect(shell).toContain('data-drift={key}');
    expect(shell).toContain('data-rebuild');
    // Every dimension is carried on the rebuild form, so the button repairs its own row.
    for (const field of ['materialNumber', 'plant', 'storageLocation', 'stockType']) {
      expect(shell).toContain(`name="${field}"`);
    }
    expect(read(RECON_PAGE)).toContain('INV.STOCK.RECONCILE');
    expect(read(RECON_PAGE)).toContain('reconcileStock');
  });

  it('refuses a rebuild without the capability, in the server action and not only the screen', () => {
    const actions = read('src/app/inventory/stock-reconcile/actions.ts');
    expect(actions).toContain('can(session, RECONCILE_CAPABILITY)');
    expect(read('src/app/inventory/uom-conversion/actions.ts')).toContain('can(session, UOM_CAPABILITY)');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-145 stage 4 — the MBRL surface, pinned by source.
 *
 * These assertions are about what the screen refuses to offer as much as what it offers: no field
 * to invent a material, plant or location; no shipping switch; and every ineligible item shown
 * with its reason rather than dropped from the grid.
 */
const read = (path: string): string => readFileSync(path, 'utf8');
const SHELL = 'src/app/inventory/return-delivery/ReturnDeliveryShell.tsx';
const ACTIONS = 'src/app/inventory/return-delivery/actions.ts';
const PAGE = 'src/app/inventory/return-delivery/page.tsx';

describe('SCR-145 the return screen', () => {
  it('selects by the canonical document key, never by number alone', () => {
    const shell = read(SHELL);
    expect(shell).toContain('name="documentNumber"');
    expect(shell).toContain('name="documentYear"');
    expect(read(PAGE)).toContain('MBRL');
  });

  it('offers a return quantity and nothing that could invent a stock dimension', () => {
    const shell = read(SHELL);
    expect(shell).toContain('name={`quantity-${item.lineNumber}`}');
    // Material, plant and location are printed from the receipt line, not entered.
    expect(shell).not.toContain('name={`material-');
    expect(shell).not.toContain('name={`plant-');
    expect(shell).not.toContain('name={`sloc-');
    expect(shell).toContain('{item.materialNumber}');
    expect(shell).toContain('item.batch');
    expect(shell).not.toContain('name="batch"');
    expect(shell).not.toContain('name={`batch-');
  });

  it('disables the quantity of an item that cannot be returned and prints its reason', () => {
    const shell = read(SHELL);
    expect(shell).toContain('data-eligible={item.eligible');
    expect(shell).toContain('disabled={!item.eligible || !canPost}');
    expect(shell).toContain('data-refusal={i.lineNumber}');
    expect(shell).toContain('{i.refusal}');
  });

  it('offers no shipping switch and says why', () => {
    const shell = read(SHELL);
    expect(shell).not.toContain('createDelivery');
    expect(shell).not.toContain('shippingPoint');
    expect(shell).toContain("t('mbrl.noDelivery')");
  });

  it('posts through the service, and guards the capability on the server', () => {
    const actions = read(ACTIONS);
    expect(actions).toContain('postReturnDelivery');
    expect(actions).toContain('can(session, RETURN_CAPABILITY)');
    expect(actions).toContain('getReturnableDocument');
    // The idempotency key travels with the form, and moves once a posting succeeds: a key fixed
    // for the life of the page made a second return replay the first and post nothing.
    const shell = read(SHELL);
    expect(shell).toContain('name="requestKey"');
    expect(shell).toContain('setRound');
    expect(shell).toMatch(/requestKey = `\$\{seed\}-\$\{round\}`/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-150 stage 4 — the recount screen's contract.
 *
 * The browser acceptance is the next stage. This proves the screen cannot drift away from the
 * service: a selected item, a check that writes nothing, no quantity and no posting date, and
 * the search alias kept out of the identifiers.
 */
describe('SCR-150 recount screen contract', () => {
  const page = read('src/app/inventory/physical-inventory-recount/page.tsx');
  const shell = read('src/app/inventory/physical-inventory-recount/RecountWorkbench.tsx');
  const actions = read('src/app/inventory/physical-inventory-recount/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/inventory/physical-inventory-recount.ts');
  const seed = read('scripts/seed.ts');
  const list = read('src/app/inventory/physical-inventory-differences/DifferenceList.tsx');

  it('loads a document by number and year, and says so when it finds none', () => {
    expect(page).toContain('getRecountSource(');
    expect(shell).toContain('name="doc"');
    expect(shell).toContain('name="year"');
    expect(shell).toContain("t('recount.notFound'");
  });

  it('selects items and does not take a quantity, a posting date, a batch, or a threshold', () => {
    expect(shell).toContain('name="item"');
    expect(shell).toContain('data-recount-line');
    expect(shell).toContain('name="plannedRecountDate"');
    expect(shell).not.toContain('name="quantity"');
    expect(shell).not.toContain('name="postingDate"');
    expect(shell).not.toContain('name="batch"');
    expect(shell).not.toContain('name="varianceThreshold"');
    expect(shell).not.toContain('maxLength={40}');
    expect(actions).toContain('The recount quantity is entered on the count');
    expect(actions).toContain('A planned recount date is not a posting date');
    expect(actions).toContain('varianceThreshold');
    expect(actions).toContain("raw(form, 'reason')");
  });

  it('checks without writing, and creates through the service', () => {
    expect(shell).toContain('data-recount-check');
    expect(shell).toContain('formAction={checkAction}');
    expect(actions).toContain('validateRecount(');
    expect(actions).toContain('createRecount(');
    expect(actions).not.toContain('postDifferences');
    expect(actions).not.toContain('postJournalEntry');
    expect(shell).toContain('data-recount-preview');
    expect(shell).toContain('data-recount-preview-book');
    expect(messages).toContain("'recount.previewNote'");
  });

  it('rotates the request key after a create, so the key is not the life of the page', () => {
    expect(shell).toContain('if (createState.ok) setRequestKey(newRequestKey());');
    expect(shell).not.toContain('const [requestKey] = useState(newRequestKey);');
  });

  it('cancels through the service and does not reverse', () => {
    expect(shell).toContain('data-recount-cancel');
    expect(actions).toContain('cancelRecount(');
    expect(actions).toContain('Cancellation is not a reversal');
    expect(actions).not.toContain('reverseDifferencePosting');
    expect(actions).not.toContain('reverseMaterialDocument');
  });

  it('keeps the search alias out of identifiers and seeds the capability as not posting', () => {
    const identifiers = `${page}\n${shell}\n${actions}`;
    expect(identifiers).not.toMatch(/id="[^"]*MI11/);
    expect(identifiers).not.toMatch(/data-[a-z-]*mi11/);
    expect(messages).toContain("'recount.code': 'INV.PHYINV.RECOUNT · MI11'");
    expect(seed).toContain("code: 'INV.PHYINV.RECOUNT'");
    expect(seed).toContain("posting: false");
    expect(seed).toContain("aliases: ['MI11']");
    expect(service).toContain("PHYSICAL_INVENTORY_RECOUNT_ROUTE = '/inventory/physical-inventory-recount'");
    expect(page).toContain('PHYSICAL_INVENTORY_RECOUNT_CAPABILITY');
  });

  it('links from the difference list and still refuses to recount there', () => {
    expect(list).toContain('data-difference-recount-link');
    expect(list).toContain('/inventory/physical-inventory-recount?');
    expect(list).toContain('data-recount-comparison');
    expect(list).not.toContain('createRecount');
    expect(list).not.toContain('>Recount<');
    const differences = read('src/modules/inventory/physical-inventory-differences.ts');
    expect(differences).toContain('does not create a recount');
  });
});

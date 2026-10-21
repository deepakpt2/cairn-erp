import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-149 stage 4 — the posting screen's contract.
 *
 * The browser acceptance is the next stage. This proves the screen cannot drift away from the
 * service: selection rather than a typed quantity, a check that writes nothing, reversal on its
 * own capability, and the search alias kept out of the identifiers.
 */
describe('SCR-149 posting screen contract', () => {
  const page = read('src/app/inventory/physical-inventory-posting/page.tsx');
  const shell = read('src/app/inventory/physical-inventory-posting/PostingWorkbench.tsx');
  const actions = read('src/app/inventory/physical-inventory-posting/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/inventory/physical-inventory-posting.ts');
  const seed = read('scripts/seed.ts');

  it('loads a document by number and year, and says so when it finds none', () => {
    expect(page).toContain('getDifferencePosting(');
    expect(page).toContain('getPostingHistory(');
    expect(shell).toContain('name="doc"');
    expect(shell).toContain('name="year"');
    expect(shell).toContain("t('diffpost.notFound'");
  });

  it('selects items and does not offer a quantity, an amount, an account, or a status', () => {
    expect(shell).toContain('name="item"');
    expect(shell).toContain('data-posting-line');
    expect(shell).toContain("t('diffpost.wholeDifference')");
    expect(shell).not.toContain('name="quantity"');
    expect(shell).not.toContain('name="amount"');
    expect(shell).not.toContain('name="glAccount"');
    expect(shell).not.toContain('name="postingStatus"');
    expect(shell).not.toContain('name="maximumDifferenceValue"');
    expect(actions).toContain('A fraction of one item');
    expect(actions).toContain('The amount is not taken from the request');
    expect(actions).toContain('maximumDifferenceValue');
  });

  it('refuses a long header text instead of shortening it', () => {
    expect(shell).toContain('name="headerText"');
    expect(shell).toContain('name="externalReference"');
    expect(shell).not.toContain('maxLength={25}');
    expect(shell).not.toContain('maxLength={40}');
    expect(shell).not.toContain('.slice(0, 25)');
    expect(actions).toContain('raw(form, \'headerText\')');
    expect(service).toContain('longer than 25 characters');
  });

  it('checks without writing, and posts through the service', () => {
    expect(shell).toContain('data-posting-check');
    expect(shell).toContain('formAction={checkAction}');
    expect(actions).toContain('validateDifferencePosting(');
    expect(actions).toContain('postDifferences(');
    expect(actions).not.toContain('postJournalEntry');
    expect(shell).toContain('data-posting-preview');
    expect(shell).toContain('data-posting-period');
    expect(shell).toContain('data-posting-amount');
    expect(messages).toContain("'diffpost.estimateNote'");
    expect(messages).toContain("'diffpost.journalNo'");
  });

  it('rotates the request key after a post, so the key is not the life of the page', () => {
    expect(shell).toContain('if (postState.ok) setRequestKey(newRequestKey());');
    expect(shell).not.toContain('const [requestKey] = useState(newRequestKey);');
  });

  it('reverses only with the reversal capability', () => {
    expect(page).toContain('canReverse={can(session, REVERSE_CAPABILITY)}');
    expect(actions).toContain('REVERSE_CAPABILITY');
    expect(actions).toContain('A posting permission does not reverse');
    expect(actions).toContain('reverseDifferencePosting(');
    expect(shell).toContain('canReverse');
    expect(shell).toContain('data-posting-reversal');
    const reverse = actions.slice(actions.indexOf('export async function reversePostingAction'));
    expect(reverse).not.toContain('PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY');
    expect(reverse).not.toContain('postDifferences(');
  });

  it('is registered under its own route, with the search alias only in the catalogue', () => {
    expect(service).toContain("PHYSICAL_INVENTORY_DIFF_POST_ROUTE = '/inventory/physical-inventory-posting'");
    expect(service).toContain("PHYSICAL_INVENTORY_DIFF_POST_ALIASES = ['MI07']");
    expect(seed).toContain("aliases: ['MI07']");
    expect(seed).toContain("code: 'INV.PHYINV.DIFF.POST'");
    expect(messages).toContain("'diffpost.code': 'INV.PHYINV.DIFF.POST · MI07'");
    expect(page).toContain('PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY');
    const identifiers = [...shell.matchAll(/\b(?:id|name|htmlFor|data-testid)=["'{][^"'}]*/g)].map((match) => match[0]);
    expect(identifiers.join('\n').toLowerCase()).not.toContain('mi07');
  });

  it('lets the difference list navigate here without posting', () => {
    const list = read('src/app/inventory/physical-inventory-differences/DifferenceList.tsx');
    const listActions = read('src/app/inventory/physical-inventory-differences/actions.ts');
    expect(list).toContain('/inventory/physical-inventory-posting?');
    expect(list).not.toContain('postDifferences');
    expect(listActions).toContain("workflow !== 'DISPLAY' && workflow !== 'POST' && workflow !== 'RECOUNT'");
    expect(listActions).not.toContain('postDifferences');
  });
});

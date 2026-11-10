import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * §5.5a screen and wiring contract: which batch a pick takes, and who says so.
 *
 * Most of what batch determination promises is proved against a database in
 * `sales-batch-determination.test.ts`. What is pinned here is what a service test cannot hold:
 * the shape of the wiring.
 *
 * The negative assertions are the ones that earn their place.
 *
 * **The client component must not import the module that reads stock.** It did, and the screen
 * answered 500, because `batch-determination.ts` imports its tables and a browser component that
 * imports it takes the whole of the `postgres` driver with it. The fix was to move the four orders
 * into their own file; this test is why that fix does not quietly come undone.
 *
 * **The pick must not determine over the top of a clerk.** Determination runs where the pick names no
 * batch and the quantity is going up — and nowhere else. A test that only checked the positive case
 * would pass on a version that overwrote whatever the picker typed.
 *
 * **One submission may now write several rows, and the idempotency key is unique per row.** The key
 * was unique per row before determination could split an item; a second row with the same key was
 * refused by the database. A version that dropped the suffix would pass every positive assertion and
 * fail the first time goods came off two shelves.
 */
describe('batch determination contract (§5.5a)', () => {
  const page = readFileSync('src/app/config/batch-determination/page.tsx', 'utf8');
  const shell = readFileSync('src/app/config/batch-determination/BatchDetermination.tsx', 'utf8');
  const actions = readFileSync('src/app/config/batch-determination/actions.ts', 'utf8');
  const module_ = readFileSync('src/modules/sales/batch-determination.ts', 'utf8');
  const sortRules = readFileSync('src/modules/sales/batch-sort-rules.ts', 'utf8');
  const delivery = readFileSync('src/modules/sales/delivery.ts', 'utf8');
  const catalog = readFileSync('src/ui/shell/screen-catalog.ts', 'utf8');

  it('the screen that maintains a rule does not pull the database driver into the browser', () => {
    // The reason this file of four constants exists at all. `BatchDetermination.tsx` is a client
    // component, and a value import from a module that imports its tables drags `postgres` into the
    // bundle and answers 500. Types are erased, so `import type` from the module is fine; the
    // choices and their meanings are not.
    expect(shell).toContain("from '@/modules/sales/batch-sort-rules'");
    expect(shell).toContain("import type { BatchRule } from '@/modules/sales/batch-determination'");
    expect(shell).not.toMatch(/import\s*\{\s*SORT_RULES[^}]*\}\s*from\s*'@\/modules\/sales\/batch-determination'/);
    // And the file the component does import must not import a table or a client of its own, or the
    // whole exercise was for nothing.
    expect(sortRules).not.toContain("from '../inventory/schema'");
    expect(sortRules).not.toContain("from '../../platform/db/client'");
    expect(sortRules).not.toContain('import {');
  });

  it('offers the four orders, and says what each of them means', () => {
    for (const rule of ['FIFO', 'LIFO', 'EXPIRY', 'BATCH_NUMBER']) {
      expect(sortRules, rule).toContain(`'${rule}'`);
    }
    // FEFO is the one a perishable store wants, and it is the one whose name you would guess wrong:
    // EXPIRY is not "the batch that has stood longest", and the screen has to say so.
    expect(sortRules).toContain('FEFO');
    // The meaning is rendered, not merely held: a tenant picking FIFO from a bare list is guessing.
    expect(shell).toContain('SORT_RULE_MEANING[rule.sortRule]');
    // The module reads them from the shared file rather than keeping a second copy that could drift.
    expect(module_).toContain("from './batch-sort-rules'");
  });

  it('the screen is registered, and maintenance is its own capability', () => {
    expect(catalog).toContain('id: "/config/batch-determination"');
    expect(catalog).toContain('code: "CFG.SALES.BATCHDETERMINATION.DEFINE"');
    // Configuration is a separate act from using the rule, as it is everywhere else in the package.
    expect(actions).toContain('BATCH_DETERMINATION_CAPABILITY');
    expect(actions).toContain('can(session, BATCH_DETERMINATION_CAPABILITY)');
    // And a reader without it is told what to ask for, rather than being shown a form that refuses.
    expect(page).toContain('Read-only');
  });

  it('maintains a rule by number, so a save changes one answer rather than appending another', () => {
    expect(module_).toContain('ruleNumber');
    expect(module_).toContain('created');
    // A tenant with three rules does not think of them as a list to append to but as three answers to
    // three questions, so the number is the identity and the screen says which happened.
    expect(actions).toContain('created');
  });

  it('determines where the pick names no batch, and never over the top of one', () => {
    expect(delivery).toContain("from './batch-determination'");
    expect(delivery).toContain('determineBatchesOn(tx, parsed.client');
    // The two guards, and the reason for each: a clerk who knows better than the rule is not
    // overruled by it, and a correction takes goods back off a pick that already states its batch.
    expect(delivery).toContain('named || delta < 0');
    // The customer the rule may name is read from the order the delivery was raised against.
    expect(delivery).toContain('order?.customerNumber');
  });

  it('writes one pick row per batch, numbered on from the last', () => {
    expect(delivery).toContain('for (const [index, entry] of picks.entries())');
    expect(delivery).toContain('coalesce(max(pick_number), 0) + 1');
    // The request key is unique per row, so where one submission takes goods from two shelves the
    // pick number goes after it — and a single row keeps the key exactly as it was submitted.
    expect(delivery).toContain('`${parsed.requestKey}#${index + 1}`');
    expect(delivery).toContain('picks.length === 1 ? parsed.requestKey');
    // And the guard that stops a resubmission has to recognise both shapes, or a retry of a split
    // pick would append the whole submission a second time.
    expect(delivery).toContain('`${parsed.requestKey}#%`');
  });

  it('a rule that answers names the shelf as well as the batch', () => {
    // Determination reads the stock the batch stands in, so it can say where as well as what. Where
    // it cannot, nothing has changed and the location is still demanded of the picker, as it always
    // was — which is why the fallback is conditional rather than simply gone.
    expect(delivery).toContain('determined.every((row) => row.storageLocation)');
    expect(delivery).toContain('await resolvePickLocation(');
  });

  it('proposes only stock the books will release, and says how short it is', () => {
    expect(module_).toContain("'UNRESTRICTED'");
    expect(module_).toContain('restrictedUse');
    expect(module_).toContain('shortfall');
    expect(module_).toContain('skipped');
  });
});

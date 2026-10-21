import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-154 stage 4 — the quota screen's contract.
 *
 * The browser acceptance is the next stage. This proves the screen cannot drift
 * away from the service: one screen, a check that writes nothing, the maintained
 * fields only, and the search alias kept out of the identifiers.
 */
describe('SCR-154 quota arrangement screen contract', () => {
  const page = read('src/app/purchasing/quota-arrangement/page.tsx');
  const shell = read('src/app/purchasing/quota-arrangement/QuotaArrangement.tsx');
  const actions = read('src/app/purchasing/quota-arrangement/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/purchasing/quota-arrangement.ts');
  const seed = read('scripts/seed.ts');
  const schema = read('src/modules/purchasing/schema.ts');
  const identifiers = `${page}\n${shell}\n${actions}`;

  it('opens an arrangement by number, and by material and plant', () => {
    expect(page).toContain('getQuotaArrangement(');
    expect(page).toContain('listQuotaArrangements(');
    expect(page).toContain("QUOTA_ROUTE");
    expect(shell).toContain('name="quota"');
    expect(shell).toContain('name="material"');
    expect(shell).toContain('name="plant"');
    expect(shell).toContain("t('quotaArrangement.notFound'");
    expect(shell).toContain("t('quotaArrangement.noArrangement'");
    expect(shell).toContain('data-quota-open');
    expect(shell).toContain('kind="material-info"');
    expect(shell).toContain('kind="supplier-purchasing"');
    expect(shell).toContain('kind="plant"');
    expect(shell).toContain('kind="purchasing-org"');
  });

  it('does not offer an allocated quantity, a lot, a unit, a plant source or a price', () => {
    expect(shell).not.toContain('name="allocatedQuantity"');
    expect(shell).not.toContain('name="supplyingPlant"');
    expect(shell).not.toContain('name="minSplitQuantity"');
    expect(shell).not.toContain('name="maxLotSize"');
    expect(shell).not.toContain('name="unit"');
    expect(shell).not.toContain('name="status"');
    expect(shell).not.toContain('name="agreementNumber"');
    expect(shell).not.toContain('name="price"');
    expect(shell).not.toContain('name="ranking"');
    expect(shell).not.toContain('name="percentage"');
    expect(shell).not.toContain('name="companyCode"');
    expect(shell).not.toContain('name="requestKey"');
    expect(shell).not.toContain('name="requisitionNumber"');
    expect(shell).not.toContain('name="orderNumber"');
    const change = shell.slice(shell.indexOf('id="quota-change"'), shell.indexOf('id="quota-rate"'));
    expect(change).not.toContain('name="materialNumber"');
    expect(change).not.toContain('name="plant"');
    expect(actions).toContain('supplyingPlant');
    expect(actions).toContain('allocatedQuantity');
    expect(actions).toContain('minSplitQuantity');
    expect(actions).toContain('maxLotSize');
    expect(actions).toContain('requestKey');
    expect(actions).toContain('does not create or change a requisition');
    expect(actions).toContain('does not create a purchase order');
    expect(actions).toContain('does not post a goods movement');
  });

  it('checks without writing, rates without allocating, and saves through the service', () => {
    expect(shell).toContain('data-quota-check');
    expect(shell).toContain('formAction={checkAction}');
    expect(shell).toContain('data-quota-change-check');
    expect(shell).toContain('formAction={changeCheckAction}');
    expect(shell).toContain('data-quota-change-preview');
    expect(shell).toContain('data-quota-nothing-allocated');
    expect(shell).toContain('data-quota-rate');
    expect(actions).toContain('previewQuotaArrangement(');
    expect(actions).toContain('previewQuotaChange(');
    expect(actions).toContain('previewQuotaSelection(');
    const check = actions.slice(
      actions.indexOf('export async function checkQuotaAction'),
      actions.indexOf('export async function createQuotaAction'),
    );
    expect(check).toContain('previewQuotaArrangement(');
    expect(check).not.toContain('createQuotaArrangement(');
    expect(check).not.toContain('revalidatePath');
    expect(check).not.toContain('allocateNumber');
    const rate = actions.slice(actions.indexOf('export async function rateQuotaAction'));
    expect(rate).toContain('previewQuotaSelection(');
    expect(rate).not.toContain('createQuotaArrangement(');
    expect(rate).not.toContain('changeQuotaArrangement(');
    expect(rate).not.toContain('allocatedByItem:');
    expect(actions).toContain('createQuotaArrangement(');
    expect(actions).toContain('changeQuotaArrangement(');
    expect(actions).not.toContain('allocateNumber');
    expect(actions).not.toContain('postJournalEntry');
    expect(actions).not.toContain('postMaterialDocument');
    expect(actions).not.toContain('createOrder(');
    expect(actions).not.toContain('createRequisition(');
    expect(service).not.toContain('createOrder(');
    expect(service).not.toContain('createRequisition(');
    expect(messages).toContain("'quotaArrangement.previewNote'");
    expect(messages).toContain("'quotaArrangement.nothingAllocated': 'Nothing has been allocated.'");
  });

  it('keeps the search alias out of identifiers and seeds the capability as not posting', () => {
    expect(identifiers).not.toMatch(/id="[^"]*MEQ1/);
    expect(identifiers).not.toMatch(/data-[a-z-]*meq1/);
    expect(identifiers).not.toMatch(/name="[^"]*MEQ1/);
    expect(schema).not.toMatch(/meq1/i);
    expect(service).not.toMatch(/table\([^)]*meq1/i);
    expect(messages).toContain("'quotaArrangement.code': 'PROC.QUOTA.MAINTAIN · MEQ1'");
    expect(seed).toMatch(/code: 'PROC\.QUOTA\.MAINTAIN'[\s\S]{0,280}posting: false/);
    expect(seed).toContain("aliases: ['MEQ1']");
    expect(service).toContain("QUOTA_ROUTE = '/purchasing/quota-arrangement'");
    expect(page).toContain('QUOTA_CAPABILITY');
    expect(page).not.toContain('ME56');
    expect(page).not.toContain('MD01');
    expect(page).not.toContain('MD02');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-157 — the quotation screen's contract.
 *
 * One screen maintains a quotation against one request. A check writes nothing.
 * The search alias stays out of the identifiers. The browser acceptance is the
 * next stage.
 */
describe('SCR-157 quotation screen contract', () => {
  const page = read('src/app/purchasing/quotation/page.tsx');
  const shell = read('src/app/purchasing/quotation/Quotation.tsx');
  const actions = read('src/app/purchasing/quotation/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/purchasing/quotation.ts');
  const seed = read('scripts/seed.ts');
  const schema = read('src/modules/purchasing/schema.ts');
  const requestPage = read('src/app/purchasing/rfq/page.tsx');
  const requestShell = read('src/app/purchasing/rfq/RequestForQuotation.tsx');
  const identifiers = `${page}\n${shell}\n${actions}`;

  it('opens a request by number and offers the save cuts as suggestions', () => {
    expect(page).toContain('openQuotation(');
    expect(page).toContain('listRecentQuotationRequests(');
    expect(page).toContain('QUOTATION_ROUTE');
    expect(shell).toContain('kind="quotation-request"');
    expect(shell).toContain('kind="unit"');
    expect(shell).toContain('askedUnit: line.unit');
    expect(shell).toContain('materialNumber: line.materialNumber');
    expect(shell).toContain("t('quotation.notFound'");
    expect(shell).toContain('data-quotation-open');
    expect(requestShell).not.toContain('name="price"');
    expect(requestPage).not.toContain('name="netPrice"');
  });

  it('does not offer a status, a currency, a rejection, an award or a company code', () => {
    expect(shell).not.toContain('name="price"');
    expect(shell).not.toContain('name="status"');
    expect(shell).not.toContain('name="currency"');
    expect(shell).not.toContain('name="companyCode"');
    expect(shell).not.toContain('name="requestKey"');
    expect(shell).not.toContain('name="revision"');
    expect(shell).not.toContain('name="award"');
    expect(shell).not.toContain('name="rejection"');
    expect(shell).not.toContain('name="condition"');
    expect(shell).not.toContain('name="comparison"');
    expect(shell).toContain('name={`line${index}NetPrice`}');
    expect(actions).toContain('price');
    expect(actions).toContain('status');
    expect(actions).toContain('currency');
    expect(actions).toContain('requestKey');
    expect(actions).toContain('award');
    expect(actions).toContain('revision');
    expect(actions).toContain('does not post a goods movement');
    expect(service).toContain('A stored price is not a field. The net price is the price named.');
  });

  it('checks without writing and saves through the service', () => {
    expect(shell).toContain('data-quotation-check');
    expect(shell).toContain('formAction={checkAction}');
    expect(shell).toContain('data-quotation-nothing-written');
    expect(shell).toContain('data-quotation-no-comparison');
    expect(shell).toContain('data-quotation-per-unit');
    expect(actions).toContain('previewQuotation(');
    expect(actions).toContain('previewQuotationChange(');
    const check = actions.slice(
      actions.indexOf('export async function checkQuotationAction'),
      actions.indexOf('export async function saveQuotationAction'),
    );
    expect(check).toContain('previewQuotation(');
    expect(check).toContain('previewQuotationChange(');
    expect(check).not.toContain('createQuotation(');
    expect(check).not.toContain('changeQuotation(');
    expect(check).not.toContain('revalidatePath');
    expect(check).not.toContain('allocateNumber');
    expect(actions).toContain('createQuotation(');
    expect(actions).toContain('changeQuotation(');
    expect(actions).not.toContain('allocateNumber');
    expect(actions).not.toContain('postJournalEntry');
    expect(actions).not.toContain('postMaterialDocument');
    expect(actions).not.toContain('createOrder(');
    expect(service).not.toContain('createOrder(');
    expect(service).not.toContain('createRequisition(');
    expect(messages).toContain("'quotation.nothingWritten': 'Nothing has been written.'");
    expect(messages).toContain("'quotation.noComparison': 'This screen does not compare, and it does not award or buy.'");
  });

  it('keeps the search alias out of identifiers and seeds the capability as not posting', () => {
    expect(identifiers).not.toMatch(/id="[^"]*ME47/);
    expect(identifiers).not.toMatch(/data-[a-z-]*me47/);
    expect(identifiers).not.toMatch(/name="[^"]*ME47/);
    expect(schema).not.toMatch(/me47/i);
    expect(service).not.toMatch(/table\([^)]*me47/i);
    expect(messages).toContain("'quotation.code': 'PROC.RFQ.QUOTATION · ME47'");
    expect(seed).toMatch(/code: 'PROC\.RFQ\.QUOTATION'[\s\S]{0,360}posting: false/);
    expect(seed).toContain("aliases: ['ME47']");
    expect(seed).toContain("route: '/purchasing/quotation'");
    expect(service).toContain("QUOTATION_ROUTE = '/purchasing/quotation'");
    expect(page).toContain('QUOTATION_CAPABILITY');
    expect(identifiers).not.toMatch(/ME48/);
    expect(identifiers).not.toMatch(/ME49/);
    expect(requestPage).not.toContain('ME47');
  });
});

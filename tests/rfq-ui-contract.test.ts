import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-155 / SCR-156 — the request-for-quotation screen's contract.
 *
 * One screen creates and changes. A check writes nothing. The search aliases
 * stay out of the identifiers. The browser acceptance is the next stage.
 */
describe('SCR-155 request for quotation screen contract', () => {
  const page = read('src/app/purchasing/rfq/page.tsx');
  const shell = read('src/app/purchasing/rfq/RequestForQuotation.tsx');
  const actions = read('src/app/purchasing/rfq/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/purchasing/rfq.ts');
  const seed = read('scripts/seed.ts');
  const schema = read('src/modules/purchasing/schema.ts');
  const identifiers = `${page}\n${shell}\n${actions}`;

  it('opens an event by number and offers the save cuts as suggestions', () => {
    expect(page).toContain('getRequestForQuotation(');
    expect(page).toContain('resolveRequestForQuotation(');
    expect(page).toContain('listRecentRequestsForQuotation(');
    expect(page).toContain('RFQ_ROUTE');
    expect(shell).toContain('name="event"');
    expect(shell).toContain("t('requestForQuotation.notFound'");
    expect(shell).toContain('data-rfq-open');
    expect(shell).toContain('kind="material-rfq"');
    expect(shell).toContain('kind="supplier-purchasing"');
    expect(shell).toContain('kind="plant"');
    expect(shell).toContain('kind="purchasing-org"');
    expect(shell).toContain('kind="purchasing-group"');
    expect(shell).toContain('kind="unit"');
    expect(shell).toContain('kind="storage-location"');
    expect(shell).toContain('materialNumber: line.material');
  });

  it('does not offer a price, a status, a channel, a currency or a company code', () => {
    expect(shell).not.toContain('name="price"');
    expect(shell).not.toContain('name="status"');
    expect(shell).not.toContain('name="deliveryChannel"');
    expect(shell).not.toContain('name="companyCode"');
    expect(shell).not.toContain('name="requestKey"');
    expect(shell).not.toContain('name="currency"');
    expect(shell).not.toContain('name="eventNumber"');
    expect(shell).not.toContain('name="revision"');
    expect(shell).not.toContain('name="notification"');
    const createForm = shell.slice(shell.indexOf('id="rfq-create"'));
    expect(createForm).not.toContain('name="rfqNumber"');
    expect(shell.slice(0, shell.indexOf('id="rfq-create"'))).toContain('name="rfqNumber"');
    expect(shell).not.toContain('name="requisitionNumber"');
    expect(shell).not.toContain('name="orderNumber"');
    expect(shell).not.toContain('name="quotationNumber"');
    expect(actions).toContain('price');
    expect(actions).toContain('status');
    expect(actions).toContain('deliveryChannel');
    expect(actions).toContain('requestKey');
    expect(actions).toContain('does not post a goods movement');
  });

  it('checks without writing and saves through the service', () => {
    expect(shell).toContain('data-rfq-check');
    expect(shell).toContain('formAction={checkAction}');
    expect(shell).toContain('data-rfq-nothing-created');
    expect(shell).toContain('data-rfq-change');
    expect(shell).toContain('data-rfq-change-check');
    expect(shell).toContain('data-rfq-header-shared');
    expect(actions).toContain('previewRequestForQuotation(');
    const check = actions.slice(
      actions.indexOf('export async function checkRfqAction'),
      actions.indexOf('export async function createRfqAction'),
    );
    expect(check).toContain('previewRequestForQuotation(');
    expect(check).not.toContain('createRequestForQuotation(');
    expect(check).not.toContain('revalidatePath');
    expect(check).not.toContain('allocateNumber');
    expect(actions).toContain('createRequestForQuotation(');
    const changeCheck = actions.slice(
      actions.indexOf('export async function checkChangeRfqAction'),
      actions.indexOf('export async function changeRfqAction'),
    );
    expect(changeCheck).toContain('previewRequestForQuotationChange(');
    expect(changeCheck).not.toContain('changeRequestForQuotation(');
    expect(changeCheck).not.toContain('revalidatePath');
    expect(actions).toContain('changeRequestForQuotation(');
    expect(actions).toContain('notification');
    expect(actions).toContain('revision');
    expect(actions).not.toContain('allocateNumber');
    expect(actions).not.toContain('postJournalEntry');
    expect(actions).not.toContain('postMaterialDocument');
    expect(actions).not.toContain('createOrder(');
    expect(actions).not.toContain('createRequisition(');
    expect(service).not.toContain('createOrder(');
    expect(service).not.toContain('createRequisition(');
    expect(messages).toContain("'requestForQuotation.previewNote'");
    expect(messages).toContain("'requestForQuotation.nothingCreated': 'Nothing has been created.'");
  });

  it('keeps the search alias out of identifiers and seeds the capability as not posting', () => {
    expect(identifiers).not.toMatch(/id="[^"]*ME41/);
    expect(identifiers).not.toMatch(/data-[a-z-]*me41/);
    expect(identifiers).not.toMatch(/name="[^"]*ME41/);
    expect(schema).not.toMatch(/me41/i);
    expect(service).not.toMatch(/table\([^)]*me41/i);
    expect(messages).toContain("'requestForQuotation.code': 'PROC.RFQ.CREATE · ME41 · ME42'");
    expect(seed).toMatch(/code: 'PROC\.RFQ\.CREATE'[\s\S]{0,320}posting: false/);
    expect(seed).toContain("aliases: ['ME41', 'ME42']");
    expect(service).toContain("RFQ_ROUTE = '/purchasing/rfq'");
    expect(page).toContain('RFQ_CAPABILITY');
    expect(identifiers).not.toMatch(/ME42/);
    expect(page).not.toContain('ME47');
    expect(page).not.toContain('ME48');
    expect(page).not.toContain('ME49');
  });
});

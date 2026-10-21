import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-151 stage 4 — the info-record screen's contract.
 *
 * The browser acceptance is the next stage. This proves the screen cannot drift away from the
 * service: one screen, a check that writes nothing, the category shown as Standard, and the
 * search aliases kept out of the identifiers.
 */
describe('SCR-151 info record screen contract', () => {
  const page = read('src/app/purchasing/info-record/page.tsx');
  const shell = read('src/app/purchasing/info-record/InfoRecord.tsx');
  const actions = read('src/app/purchasing/info-record/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/purchasing/info-record.ts');
  const seed = read('scripts/seed.ts');
  const identifiers = `${page}\n${shell}\n${actions}`;

  it('opens a record by number, and by supplier and material names the standing number', () => {
    expect(page).toContain('getPurchasingInfoRecord(');
    expect(page).toContain('findPurchasingInfoRecord(');
    expect(shell).toContain('name="record"');
    expect(shell).toContain('name="supplier"');
    expect(shell).toContain('name="material"');
    expect(shell).toContain("t('infoRecord.notFound'");
    expect(shell).toContain("t('infoRecord.namedExisting'");
    expect(shell).toContain('data-info-record-open');
  });

  it('shows Standard as text, and does not offer a category, a material group, or a company code', () => {
    expect(shell).toContain('data-info-record-category="STANDARD"');
    expect(shell).not.toContain('name="category"');
    expect(shell).not.toContain('name="materialGroup"');
    expect(shell).not.toContain('name="companyCode"');
    expect(shell).not.toContain('name="taxCode"');
    expect(shell).not.toContain('name="incoterms"');
    expect(shell).not.toContain('<select');
    expect(actions).toContain('materialGroup');
    expect(actions).toContain('The company code is not a field of the info record');
    expect(actions).toContain('does not create or change a requisition');
    expect(actions).toContain('does not create a purchase order');
  });

  it('checks without writing, and creates and changes through the service', () => {
    expect(shell).toContain('data-info-record-check');
    expect(shell).toContain('formAction={checkAction}');
    expect(shell).toContain('data-info-record-change-check');
    expect(shell).toContain('formAction={changeCheckAction}');
    expect(shell).toContain('data-info-record-change-preview');
    expect(shell).toContain('data-info-record-scope-missing');
    expect(actions).toContain('previewPurchasingInfoRecord(');
    expect(actions).toContain('previewPurchasingInfoRecordChange(');
    const changeCheck = actions.slice(
      actions.indexOf('export async function checkChangeInfoRecordAction'),
      actions.indexOf('export async function createInfoRecordAction'),
    );
    expect(changeCheck).toContain('previewPurchasingInfoRecordChange(');
    expect(changeCheck).not.toContain('changePurchasingInfoRecord(');
    expect(changeCheck).not.toContain('revalidatePath');
    const maintained = shell.slice(shell.indexOf('data-info-record-segment'), shell.indexOf('info-record-create'));
    expect(maintained).not.toContain('name="purchasingOrg"');
    expect(maintained).not.toContain('name="plant"');
    expect(actions).toContain('createPurchasingInfoRecord(');
    expect(actions).toContain('changePurchasingInfoRecord(');
    expect(actions).not.toContain('allocateNumber');
    expect(actions).not.toContain('postJournalEntry');
    expect(actions).not.toContain('postMaterialDocument');
    expect(actions).not.toContain('createOrder');
    expect(actions).not.toContain('createRequisition');
    expect(shell).toContain('data-info-record-preview');
    expect(shell).toContain('data-info-record-change');
    expect(messages).toContain("'infoRecord.previewNote'");
  });

  it('keeps the search aliases out of identifiers and seeds the capability as not posting', () => {
    expect(identifiers).not.toMatch(/id="[^"]*ME1[12]/);
    expect(identifiers).not.toMatch(/data-[a-z-]*me1[12]/);
    expect(identifiers).not.toMatch(/name="[^"]*ME1[12]/);
    expect(messages).toContain("'infoRecord.code': 'PROC.INFO.RECORD.MAINTAIN · ME11 / ME12'");
    expect(seed).toMatch(/code: 'PROC\.INFO\.RECORD\.MAINTAIN'[\s\S]{0,220}posting: false/);
    expect(seed).toContain("aliases: ['ME11', 'ME12']");
    expect(service).toContain("INFO_RECORD_ROUTE = '/purchasing/info-record'");
    expect(page).toContain('INFO_RECORD_CAPABILITY');
  });
});

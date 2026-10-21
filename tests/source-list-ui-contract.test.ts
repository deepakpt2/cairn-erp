import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-153 stage 4 — the source-list screen's contract.
 *
 * The browser acceptance is the next stage. This proves the screen cannot drift
 * away from the service: one screen, a check that writes nothing, the maintained
 * fields only, and the search alias kept out of the identifiers.
 */
describe('SCR-153 source list screen contract', () => {
  const page = read('src/app/purchasing/source-list/page.tsx');
  const shell = read('src/app/purchasing/source-list/SourceList.tsx');
  const actions = read('src/app/purchasing/source-list/actions.ts');
  const messages = read('src/platform/i18n/index.ts');
  const service = read('src/modules/purchasing/source-list.ts');
  const seed = read('scripts/seed.ts');
  const identifiers = `${page}\n${shell}\n${actions}`;

  it('opens a list by source number, and by material and plant', () => {
    expect(page).toContain('getSourceListEntry(');
    expect(page).toContain('getSourceList(');
    expect(shell).toContain('name="source"');
    expect(shell).toContain('name="material"');
    expect(shell).toContain('name="plant"');
    expect(shell).toContain("t('sourceList.notFound'");
    expect(shell).toContain("t('sourceList.noList'");
    expect(shell).toContain('data-source-list-open');
    expect(shell).toContain('kind="material-info"');
    expect(shell).toContain('kind="supplier-purchasing"');
    expect(shell).toContain('kind="plant"');
    expect(shell).toContain('kind="purchasing-org"');
  });

  it('does not offer an agreement, a price, a quota, a ranking or a company code', () => {
    expect(shell).not.toContain('name="agreementNumber"');
    expect(shell).not.toContain('name="price"');
    expect(shell).not.toContain('name="quota"');
    expect(shell).not.toContain('name="ranking"');
    expect(shell).not.toContain('name="companyCode"');
    expect(shell).not.toContain('name="requestKey"');
    expect(shell).toContain('data-source-list-required=');
    const change = shell.slice(shell.indexOf('source-list-change'), shell.indexOf('source-list-create'));
    expect(change).not.toContain('name="materialNumber"');
    expect(change).not.toContain('name="partnerNumber"');
    expect(change).not.toContain('name="purchasingOrg"');
    expect(actions).toContain('agreementNumber');
    expect(actions).toContain('companyCode');
    expect(actions).toContain('does not create or change a requisition');
    expect(actions).toContain('does not create a purchase order');
  });

  it('checks without writing, and creates and changes through the service', () => {
    expect(shell).toContain('data-source-list-check');
    expect(shell).toContain('formAction={checkAction}');
    expect(shell).toContain('data-source-list-change-check');
    expect(shell).toContain('formAction={changeCheckAction}');
    expect(shell).toContain('data-source-list-change-preview');
    expect(actions).toContain('previewSourceListEntry(');
    expect(actions).toContain('previewSourceListChange(');
    const changeCheck = actions.slice(
      actions.indexOf('export async function checkChangeSourceListAction'),
      actions.indexOf('export async function createSourceListAction'),
    );
    expect(changeCheck).toContain('previewSourceListChange(');
    expect(changeCheck).not.toContain('changeSourceListEntry(');
    expect(changeCheck).not.toContain('revalidatePath');
    expect(actions).toContain('createSourceListEntry(');
    expect(actions).toContain('changeSourceListEntry(');
    expect(actions).not.toContain('allocateNumber');
    expect(actions).not.toContain('postJournalEntry');
    expect(actions).not.toContain('postMaterialDocument');
    expect(actions).not.toContain('createOrder');
    expect(actions).not.toContain('createRequisition');
    expect(shell).toContain('data-source-list-preview');
    expect(shell).toContain('data-source-list-change');
    expect(messages).toContain("'sourceList.previewNote'");
  });

  it('keeps the search alias out of identifiers and seeds the capability as not posting', () => {
    expect(identifiers).not.toMatch(/id="[^"]*ME01/);
    expect(identifiers).not.toMatch(/data-[a-z-]*me01/);
    expect(identifiers).not.toMatch(/name="[^"]*ME01/);
    expect(messages).toContain("'sourceList.code': 'PROC.SOURCE.LIST.MAINTAIN · ME01'");
    expect(seed).toMatch(/code: 'PROC\.SOURCE\.LIST\.MAINTAIN'[\s\S]{0,240}posting: false/);
    expect(seed).toContain("aliases: ['ME01']");
    expect(service).toContain("SOURCE_LIST_ROUTE = '/purchasing/source-list'");
    expect(page).toContain('SOURCE_LIST_CAPABILITY');
  });
});

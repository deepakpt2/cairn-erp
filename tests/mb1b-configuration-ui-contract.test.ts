import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/**
 * SCR-146 stage 4 — the screen names what the configuration decided.
 *
 * §16 asks for three things at the front door: a `validate` that posts nothing, an external
 * reference that travels with the document, and a display of what will happen. The screen is a
 * source contract here, the way the other UI contracts are: the browser acceptance target T845
 * proves the behaviour, and this proves the wiring cannot drift from it.
 */
describe('SCR-146 transfer screen contract', () => {
  const shell = read('src/app/inventory/transfer-posting/TransferPosting.tsx');
  const actions = read('src/app/inventory/transfer-posting/actions.ts');
  const messages = read('src/platform/i18n/index.ts');

  it('offers the two-step movements so choosing one is answered, not hidden', () => {
    expect(shell).toContain('MOVEMENT_CHOICES');
    const catalogue = read('src/modules/inventory/transfer-scenarios.ts');
    for (const code of ["'303'", "'313'", "'315'"]) {
      expect(catalogue).toContain(`code: ${code}`);
    }
    expect(catalogue).toContain('not carried');
    // The counters are posted by a reversal, so they are never offered for entry.
    expect(catalogue).not.toMatch(/code: '312'/);
  });

  it('offers a check that posts nothing, beside the posting', () => {
    expect(shell).toContain('checkTransferAction');
    expect(shell).toContain('formAction={checkAction}');
    expect(shell).toContain('data-transfer-check');
    expect(actions).toContain('validateTransfer({');
    // The check and the posting read the item fields through one function, so a check can never
    // answer about a different request than the one that posts.
    expect(actions).toContain('function itemOf(form: FormData)');
    expect(actions).toContain('...itemOf(form)');
    expect(actions).not.toContain('postTransfer({ ...itemOf(form) }); // check');
  });

  it('shows what the movement is configured to do', () => {
    expect(shell).toContain('data-transfer-preview');
    expect(shell).toContain('data-preview-movement');
    expect(shell).toContain('data-preview-base');
    expect(shell).toContain('data-preview-from');
    expect(shell).toContain('data-preview-to');
    expect(shell).toContain('data-preview-stock');
    expect(shell).toContain('data-preview-value');
    expect(shell).toContain('data-preview-journal');
    expect(shell).not.toContain("'311 moves inside one plant'");
    expect(messages).toContain("'mb1b.movementHint': 'Each movement carries its own configuration");
  });

  it('carries the external reference to the posting', () => {
    expect(shell).toContain('name="externalReference"');
    expect(actions).toContain("externalReference: text(form, 'externalReference') || undefined");
    expect(messages).toContain("'mb1b.externalReference'");
    // And the document shows it back, so the reference a person typed is visible on the posting.
    expect(shell).toContain('{document.externalReference ?');
  });

  it('moves the request key on after a posting, so the next transfer is not a replay', () => {
    expect(shell).toContain('useEffect(');
    expect(shell).toContain('if (postState.ok) setPostKey(newRequestKey());');
    expect(shell).toContain('if (reverseState.ok) setReverseKey(newRequestKey());');
    expect(shell).not.toContain('const [postKey] = useState(newRequestKey);');
  });

  it('keeps the screen create-only, with no editing of a posted document', () => {
    expect(shell).not.toContain('name="update"');
    expect(actions).not.toContain('updateTransfer');
    expect(actions).not.toContain('draftTransfer');
  });

  it('names the check in the language file, not in the component', () => {
    for (const key of [
      'mb1b.check', 'mb1b.checking', 'mb1b.previewTitle', 'mb1b.previewBase',
      'mb1b.previewStock', 'mb1b.previewJournal', 'mb1b.noValuation',
    ]) {
      expect(messages).toContain(`'${key}'`);
    }
    expect(shell).not.toContain('>Check<');
  });
});

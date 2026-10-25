import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-132 / MBST UI contract: the screen is gated on INV.REVERSE (the frozen
 * roadmap capability), takes its tenant scope from the session, looks a document
 * up by number and fiscal year, shows every line with the quantity already
 * reversed and the quantity still open, offers the line selection and the whole
 * document, and refuses a reversal of a reversal or of a closed document.
 */
const capability = 'INV.REVERSE';
const page = readFileSync('src/app/inventory/reversal/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/reversal/Reversal.tsx', 'utf8');
const actions = readFileSync('src/app/inventory/reversal/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/material-document-reversal.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-132 material document reversal UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const REVERSE_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, REVERSE_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(actions).toContain('You do not hold the material document reversal capability.');
  });

  it('looks a document up by its number and fiscal year', () => {
    expect(shell).toMatch(/name="doc"[^>]*required/);
    expect(shell).toMatch(/name="fiscalYear"/);
    expect(page).toContain('getReversalDocument(session.user.client, params.doc)');
    expect(service).toContain('stands in fiscal year');
  });

  it('shows each line with what is reversed and what still stands open', () => {
    expect(shell).toContain('data-remaining={line.remainingQuantity}');
    expect(shell).toContain('data-side={line.lineDirection}');
    expect(shell).toContain('mbst.columnReversed');
    expect(shell).toContain('mbst.columnOpen');
    expect(shell).toContain('data-batch={line.batch}');
    expect(shell).toContain('mbst.columnBatch');
    expect(shell).not.toMatch(/name="batch"/);
    expect(service).toContain('reversedQuantity');
    expect(service).toContain('remainingQuantity');
  });

  it('offers the line selection and the whole document, whole lines only', () => {
    expect(shell).toContain('name="lines"');
    expect(shell).toContain('defaultChecked={Number(line.remainingQuantity) > 0}');
    expect(shell).toContain('disabled={Number(line.remainingQuantity) <= 0}');
    expect(service).toContain('input.lines');
    expect(service).toContain('is already reversed in full');
  });

  it('requires both dates and caps the header text at 25', () => {
    expect(shell).toMatch(/name="postingDate"[^>]*required/);
    expect(shell).toMatch(/name="documentDate"[^>]*required/);
    expect(shell).toMatch(/name="headerText"[^>]*maxLength=\{25\}/);
  });

  it('refuses a reversal of a reversal and a document with nothing open', () => {
    expect(shell).toContain('mbst.isReversal');
    expect(shell).toContain('mbst.nothingOpen');
    expect(shell).toContain("document.status !== 'REVERSED' && !document.reversalOf");
    expect(service).toContain('is itself a reversal of');
    expect(service).toContain('has already been cancelled');
  });

  it('reads the cancellation state off the document and never edits a posted row', () => {
    expect(shell).toContain('data-status={document.status}');
    expect(service).toContain("status: allDone ? 'REVERSED' : 'PARTIALLY_REVERSED'");
    expect(service).not.toContain('delete(materialDocumentLine)');
    expect(actions).not.toContain('deleteMaterialDocument');
  });

  it('is registered in the catalogue with MBST as its search alias only', () => {
    expect(registry).toContain("code: 'INV.REVERSE'");
    expect(registry).toContain("route: '/inventory/reversal'");
    expect(registry).toContain("aliases: ['MBST']");
  });

  it('renders every caption from the message catalogue', () => {
    for (const key of ['mbst.title', 'mbst.subtitle', 'mbst.reverse', 'mbst.lookup', 'mbst.columnOpen', 'mbst.columnBatch']) {
      expect(shell + page).toContain(key);
      expect(messages).toContain(`'${key}'`);
    }
  });

  it('does not call accounting reversed before the journal reversal is posted', () => {
    expect(messages).toContain('Accounting is not reversed before that journal reversal is posted.');
    expect(messages).not.toContain('the stock, the value, the journal and the order\'s open quantity all return');
    for (const key of [
      'mbst.accountingNone', 'mbst.accountingPosted', 'mbst.accountingPartial',
      'mbst.accountingComplete', 'mbst.accountingMissing', 'mbst.accountingMismatch',
      'mbst.accountingDeferred', 'mbst.accountingAbsent',
    ]) {
      expect(shell).toContain(key.replace('mbst.accounting', ''));
      expect(messages).toContain(`'${key}'`);
    }
    expect(shell).toContain('data-accounting={document.journalAccounting.state}');
    expect(shell).toContain("document.journalAccounting.state === 'NONE'");
    expect(actions).toContain('The journal is still posted.');
    expect(actions).toContain('The journal reversal is posted.');
    expect(actions).toContain('Accounting is not reversed.');
    expect(service).toContain('cannot be marked reversed');
  });
});

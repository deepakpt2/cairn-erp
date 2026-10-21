import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-131 / MB1B UI contract: the screen is gated on INV.TRANSFER.POST (the
 * frozen roadmap capability), takes its tenant scope from the session, offers
 * the three movement numbers the package names, requires material, quantity,
 * both plants and both storage locations, shows the two-sided document with
 * the issuing line signed, and exposes the reversal and nothing else.
 */
const capability = 'INV.TRANSFER.POST';
const page = readFileSync('src/app/inventory/transfer-posting/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/transfer-posting/TransferPosting.tsx', 'utf8');
const actions = readFileSync('src/app/inventory/transfer-posting/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/transfer-posting.ts', 'utf8')
  + readFileSync('src/modules/inventory/transfer-scenarios.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-131 transfer posting UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const TRANSFER_POST_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, TRANSFER_POST_CAPABILITY)');
    expect(page).toContain('session.user.client');
    expect(page).not.toContain('params.client');
    expect(actions).toContain('can(session, TRANSFER_POST_CAPABILITY)');
    expect(actions).toContain('You do not hold the transfer posting capability.');
  });

  it('offers the three movement numbers the package names and none typed by hand', () => {
    expect(service).toContain("code: '311'");
    expect(service).toContain("code: '301'");
    expect(service).toContain("code: '321'");
    expect(shell).toContain('TRANSFER_SCENARIOS.map');
    expect(shell).toContain('{s.code} · {s.description}');
  });

  it('requires the material, the quantity, both plants and both storage locations', () => {
    for (const name of [
      'materialNumber', 'quantity', 'issuingPlant', 'issuingStorageLocation',
      'receivingPlant', 'receivingStorageLocation',
    ]) {
      expect(shell, name).toMatch(new RegExp(`name="${name}"[^>]*required`));
    }
    expect(shell).toMatch(/name="postingDate"[^>]*required/);
    expect(shell).toMatch(/name="documentDate"[^>]*required/);
    expect(shell).toMatch(/name="headerText"[^>]*maxLength=\{25\}/);
  });

  it('shows the two-sided document, signs the issuing line and names the journal state', () => {
    expect(shell).toContain("line.lineDirection === 'ISSUE' ? '−' : ''");
    expect(shell).toContain('mb1b.noJournal');
    expect(shell).toContain('data-side={line.lineDirection}');
    expect(messages).toContain("'mb1b.issue'");
    expect(messages).toContain("'mb1b.receipt'");
    expect(messages).toContain("'mb1b.noJournal': 'no journal — the stock moves inside one valuation area'");
  });

  it('offers the counter movement reversal and nothing that edits a posted document', () => {
    expect(shell).toContain('reverseTransferAction');
    expect(shell).toContain("document.status === 'POSTED' && !document.reversalOf");
    expect(actions).toContain('reverseTransfer({');
    expect(service).toContain('reversalMovementType');
    expect(service).toContain('A reversal document cannot itself be reversed.');
    expect(shell).not.toContain('name="update"');
    expect(actions).not.toContain('updateTransfer');
  });

  it('carries the refusals the package names, in the service', () => {
    expect(service).toContain('is not a transfer');
    // SCR-146: the organizational refusals now quote the configuration that decided them.
    expect(service).toContain('moves between plants, and the configuration says so');
    expect(service).toContain('moves inside one plant, and the configuration says so');
    expect(service).toContain('moves between storage locations, and the configuration says so');
    expect(service).toContain('moves inside one storage location, and the configuration says so');
    expect(service).toContain('blocked for postings');
    expect(service).toContain('cross-company stock transfer needs intercompany clearing');
    expect(service).toContain('The material posting period');
    expect(service).toContain('short of the');
  });

  it('names the configured negative exactly where the storage location carries the flag', () => {
    expect(service).toContain('allowNegativeStock');
    expect(service).toContain('release negative stock on the');
  });

  it('is registered in the catalogue with MB1B as its search alias only', () => {
    expect(registry).toContain("code: 'INV.TRANSFER.POST'");
    expect(registry).toContain("route: '/inventory/transfer-posting'");
    expect(registry).toContain("aliases: ['MB1B']");
    expect(registry).not.toContain("movementType: 'MB1B'");
  });

  it('renders every caption from the message catalogue, not from literals', () => {
    for (const key of ['mb1b.title', 'mb1b.subtitle', 'mb1b.post', 'mb1b.reverse', 'mb1b.stockOnHand']) {
      expect(shell + page).toContain(key);
      expect(messages).toContain(`'${key}'`);
    }
  });
});

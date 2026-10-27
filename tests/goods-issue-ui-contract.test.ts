import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SCR-136 / MB1A UI contract: the screen is gated on INV.GI.POST, takes its tenant
 * scope from the session, offers the movement with both dates and the header text,
 * four item lines with material, plant, location, quantity, cost centre and
 * reservation, disables the cost centre where the movement charges none, and shows
 * the posted document with its journal and the reservation's remaining open
 * quantity.
 */
const capability = 'INV.GI.POST';
const page = readFileSync('src/app/inventory/goods-issue/page.tsx', 'utf8');
const shell = readFileSync('src/app/inventory/goods-issue/GoodsIssue.tsx', 'utf8');
const actions = readFileSync('src/app/inventory/goods-issue/actions.ts', 'utf8');
const service = readFileSync('src/modules/inventory/goods-issue.ts', 'utf8');
const messages = readFileSync('src/platform/i18n/index.ts', 'utf8');
const registry = readFileSync('scripts/seed.ts', 'utf8');

describe('SCR-136 goods issue UI contract', () => {
  it('gates the screen on the roadmap capability and takes tenant scope from the session', () => {
    expect(service).toContain(`export const GOODS_ISSUE_CAPABILITY = '${capability}'`);
    expect(page).toContain('can(session, GOODS_ISSUE_CAPABILITY)');
    expect(actions).toContain('session.user.client');
    expect(actions).not.toContain('params.client');
    expect(actions).toContain('You do not hold the goods issue capability.');
  });

  it('takes the movement, both dates and the header text', () => {
    expect(shell).toMatch(/name="movementTypeCode"/);
    expect(shell).toMatch(/name="postingDate"[^>]*required/);
    expect(shell).toMatch(/name="documentDate"[^>]*required/);
    expect(shell).toMatch(/name="headerText"[^>]*maxLength=\{25\}/);
    // SCR-139: MB1A offers its own two movements; 261 lives on the MIGO matrix.
    expect(page).toContain('MB1A_SCENARIOS.map');
  });

  it('offers item lines with material, plant, location, quantity, cost centre and reservation', () => {
    expect(shell).toContain('name={`material-${n}`}');
    expect(shell).toContain('name={`plant-${n}`}');
    expect(shell).toContain('name={`sloc-${n}`}');
    expect(shell).toContain('name={`quantity-${n}`}');
    expect(shell).toContain('name={`costCenter-${n}`}');
    expect(shell).toContain('name={`reservation-${n}`}');
    expect(shell).toContain('name={`reservationItem-${n}`}');
  });

  it('disables the cost centre where the movement charges none', () => {
    expect(shell).toContain('chargesCostCentre');
    expect(shell).toContain('disabled={!chargesCostCentre}');
    expect(service).toContain('charges a cost centre, and none was named');
  });

  it('shows the posted document with its journal, company, value and lines', () => {
    expect(shell).toContain('state.document.journalDocumentNumber');
    expect(shell).toContain('state.document.companyCode');
    expect(shell).toContain('data-line={line.lineNumber}');
    expect(shell).toContain('data-reservation-open={line.reservationOpenAfter');
  });

  it('replays a submitted request key instead of posting the issue twice', () => {
    expect(shell).toContain('name="requestKey"');
    expect(service).toContain('existingByRequestKey');
  });

  it('says what it refuses rather than hiding it: 261, counters and batch', () => {
    // SCR-139 moved 261 from a refusal to a MIGO movement, so the header no longer points at a
    // capability that would unlock it. What it must keep saying, in the service and not only in
    // the screen copy, is which screen posts a 261 and why this one will not.
    expect(service).toContain('Movement ${found.code} is posted from');
    expect(service).toContain('Open MIGO, choose Goods issue with an order reference');
    expect(service).toContain('MBST');
    expect(service).toContain('A batch-managed material posts only against a batch that already stands.');
    expect(messages).toContain("'mb1a.hint'");
  });

  it('registers the capability with its route and alias', () => {
    expect(registry).toContain(`'${capability}'`);
    expect(registry).toContain("aliases: ['MB1A']");
    expect(registry).toContain("route: '/inventory/goods-issue'");
    expect(messages).toContain("'mb1a.title': 'Post Goods Issue'");
  });
});

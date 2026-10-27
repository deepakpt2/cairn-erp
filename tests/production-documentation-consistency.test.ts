/**
 * The production documentation is a build-stop for the next round: `docs/production-tcode-order.md` says what is
 * already wired so nobody wires it twice, and `implemented-functions.md` says which function opens which screen.
 * Both had drifted into denying shipped behaviour — the 261 component issue, technical completion, the finished-good
 * receipt, the BOM explosion, the production order on MD04 — and one status file counted a built screen as unbuilt.
 *
 * These cases do not review prose. They pin each corrected sentence to the code that makes it true, so a sentence
 * cannot survive the removal of the thing it describes, and so a screen can join the tree without joining the table
 * that is supposed to list every one of them.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
/** Prose wraps. A sentence must be compared to the sentence, not to one of its lines, or a stale claim slips
 * through the assertion simply because the editor broke the line inside it. */
const flat = (text: string) => text.replace(/\s+/g, ' ');

const goodsIssue = read('src/modules/inventory/goods-issue.ts');
const orderMaster = read('src/modules/inventory/production-orders.ts');
const orderChange = read('src/modules/production/production-order-change.ts');
const orderReceipt = read('src/modules/inventory/production-receipt.ts');
const orderAvailability = read('src/modules/production/order-availability.ts');
const stockRequirements = read('src/modules/production/stock-requirements.ts');
const mrpRun = read('src/modules/production/mrp-run.ts');
const wiring = read('docs/production-tcode-order.md');
const functions = read('implemented-functions.md');
const status = read('implementation-status.md');
const deferred = read('docs/DEFERRED_ISSUES.md');
const seed = read('scripts/seed.ts');

/** The `GOODS_ISSUE_SCENARIOS` entry for one movement code, as far as its own object literal. */
function scenarioBlock(source: string, code: string): string {
  const start = source.indexOf(`code: '${code}'`);
  expect(start, `movement ${code} is not in the catalogue this service builds`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('},', start));
}

describe('the goods-issue header states the 261 that ships', () => {
  it('delivers the component issue and names the screen that offers it', () => {
    const block = scenarioBlock(goodsIssue, '261');
    expect(block).toContain("screen: 'MIGO'");
    expect(block).toContain('PROD_ISSUE_ORDER');
    expect(goodsIssue).toContain('Movement ${found.code} is posted from');
    expect(goodsIssue).toContain('Open MIGO, choose Goods issue with an order reference');
  });

  it('keeps the header off the claim that canon has no order master', () => {
    expect(flat(goodsIssue)).not.toContain('261 is refused by name');
    expect(flat(goodsIssue)).not.toContain('canon has no order master');
    expect(flat(goodsIssue)).not.toContain('stays on MIGO until PROD.ORDER.CREATE names it');
  });

  it('still refuses the counter movement posted directly', () => {
    // The corrected header must not talk the next round into posting a reversal code by hand.
    expect(goodsIssue).toMatch(/262/);
    expect(flat(goodsIssue)).toContain('posts no counter movement of its own');
  });
});

describe('the order module defers what is deferred and not what is delivered', () => {
  it('takes technical completion off the deferral list, and points at the service that has it', () => {
    expect(flat(orderMaster)).not.toMatch(/Deferred by name: TECO/);
    expect(orderMaster).toContain('technicallyCompleteProductionOrder');
    expect(orderMaster).toContain('revokeTechnicalCompletion');
    expect(orderChange).toContain("export async function technicallyCompleteProductionOrder");
    expect(orderChange).toContain("export async function revokeTechnicalCompletion");
    expect(orderChange).toContain("'TECO'");
  });

  it('records the receipt as delivered without claiming a settlement', () => {
    expect(flat(orderMaster)).not.toContain('the finished-goods receipt (PROD.ORDER.GR), settlement');
    expect(orderReceipt).toContain("PRODUCTION_RECEIPT_CAPABILITY = 'PROD.ORDER.GR'");
    // Settlement is the opposite case: registered, inert, and still written as such.
    expect(flat(orderMaster)).toContain('PROD.ORDER.SETTLE');
    expect(flat(orderMaster)).toContain('settles nothing');
    expect(seed).toContain("{ code: 'PROD.ORDER.SETTLE'");
    expect(flat(orderMaster)).toContain('DI-012');
  });
});

describe('the wiring doc describes the application that exists', () => {
  it('does not deny a shipped act', () => {
    for (const stale of [
      'no change and no technical completion',
      'Quantity, dates, and components cannot be changed',
      'does not list a production order',
      'does not explode a bill of material',
      'does not turn a planned order',
    ]) {
      expect(flat(wiring), `the wiring doc still says: ${stale}`).not.toContain(stale);
    }
  });

  it('holds each claim to the source that proves it', () => {
    expect(flat(wiring)).toContain('**does** explode a bill of material');
    expect(mrpRun).toContain('explodePlannedSupply');
    expect(flat(wiring)).toContain('**and the production order**');
    expect(stockRequirements).toContain('production_order_component');
    expect(stockRequirements).toMatch(/from production_order o\b/);
    expect(flat(wiring)).toContain('`CO15` confirms the order header and posts no movement');
    expect(flat(wiring)).toContain('co11n-movement');
    expect(flat(wiring)).toContain('a batch is not');
  });

  it('keeps step 12 unstarted, and sends the reason to the ledger', () => {
    expect(flat(wiring)).toMatch(/`CO88` — settle the production order\. \*\*Not started\.\*\*/);
    expect(flat(wiring)).toContain('DI-012');
  });

  it('describes CO09 as the read-only overview it is, with the refusals the module makes', () => {
    expect(flat(wiring)).toContain('writes no commitment, no reservation and no re-check on release');
    expect(orderAvailability).toContain('No reset and no collective check over a worklist');
    expect(orderAvailability).toContain('One order is checked per run');
    expect(flat(wiring)).toContain('docs/co09-availability-audit.md');
  });
});

describe('the function table lists every production screen', () => {
  const routes = readdirSync('src/app/production')
    .filter((dir) => existsSync(`src/app/production/${dir}/page.tsx`))
    .map((dir) => `/production/${dir}`)
    .sort();

  it('knows about all of them', () => {
    expect(routes.length).toBeGreaterThanOrEqual(25);
    for (const route of routes) {
      expect(functions, `${route} has a page but no row`).toContain(route);
    }
  });

  it('counts its own rows in its heading', () => {
    const heading = functions.match(/^## Production \((\d+)\)$/m);
    expect(heading, 'the Production heading lost its count').not.toBeNull();
    const section = functions.slice(
      functions.indexOf(heading![0]),
      functions.indexOf('\n## ', functions.indexOf(heading![0]) + 1),
    );
    const rows = section.split('\n').filter((line) => line.startsWith('| `PROD.')).length;
    expect(Number(heading![1])).toBe(rows);
  });

  it('does not offer a route for the function that has no screen', () => {
    const row = functions.split('\n').find((line) => line.includes('`PROD.ORDER.SETTLE`'));
    expect(row).toBeDefined();
    expect(row).toContain('Registered, no screen');
    expect(functions).not.toMatch(/`PROD\.ORDER\.SETTLE`[^|]*\|[^|]*\|[^|]*\| `\/production/);
  });
});

describe('the status file does not call a built screen unbuilt', () => {
  const unbuilt = status.slice(status.indexOf('## Workbench entries that are not built'));

  it('has taken work centres off the list, because they are built', () => {
    expect(flat(unbuilt)).not.toMatch(/condition records, work centres,/);
    expect(existsSync('src/app/production/work-centers/page.tsx')).toBe(true);
    expect(existsSync('src/app/production/work-center-display/page.tsx')).toBe(true);
  });

  it('replaced its unreproducible counts with the guard that holds the same ground', () => {
    expect(flat(status)).not.toContain('169 command-bar codes');
    expect(flat(status)).not.toContain('166 pages exist');
    expect(flat(status)).toContain('tests/screen-links.test.ts');
    expect(flat(status)).toContain('242 entries');
  });
});

describe('the ledger carries what this round could not close', () => {
  it('records the correction and the decision it left alone', () => {
    expect(deferred).toContain('DI-013');
    expect(deferred).toContain('DI-014');
    expect(deferred).toMatch(/DI-012/);
    expect(flat(deferred)).toContain('PROD.ORDER.SETTLE');
  });

  it('holds the unregistered-gate finding until the registry says otherwise', () => {
    const registered = /code: 'PROD\.(CONFIRM\.CANCEL|WORKCENTER\.(CREATE|CHANGE|DISPLAY))'/.test(seed);
    if (registered) {
      // Someone registered the gates. The finding is closed and DI-014 must say so, not stay open. The marker has
      // to sit on DI-014's own entry: the file holds other closed entries, and `toContain('CLOSED')` would pass on
      // one of them.
      expect(deferred, 'DI-014 is stale: the codes are registered now').toMatch(
        /^\| DI-014 \|.*CLOSED/m,
      );
    } else {
      // The row says the gate is still open, which is the fact this case exists to protect, and the
      // status file must not claim the registry is complete while it is not.
      expect(deferred).toMatch(/^\| DI-014 \|.*OPEN/m);
      expect(status).not.toContain('every production gate is registered');
    }
  });
});

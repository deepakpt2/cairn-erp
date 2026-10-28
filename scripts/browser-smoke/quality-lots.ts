import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { hashPassword } from '../../src/platform/auth/password';
import { defineRange } from '../../src/platform/numbering';
import { createBatch } from '../../src/modules/inventory/batch-master';
import { saveBatchLevel } from '../../src/modules/inventory/batch-level';
import { initializeMaterialPeriodControl } from '../../src/modules/inventory/material-period-control';
import { createOrder } from '../../src/modules/purchasing/orders';
import { openLot } from '../../src/modules/quality/lot';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const LOTS = '/quality/lots';
const RECEIPT = '/inventory/goods-receipt';
const MATERIAL_DOCS = '/inventory/material-documents';
const CODE = 'QM.LOT.CREATE';

const MATERIAL = 'MAT-10001';
const BATCH = '000Q1';
const UNIT = 'PC';
const STORE = '0001';
const ADMIN_USER = 'browser.admin';
// The harness's own fixture password, written out here because `checks.ts` keeps its copy private and this
// journey signs the administrator back in after reading the screen as a session without the code.
const ADMIN_PASSWORD = 'browser-check-2026';
const AUDIT_USER = 'quality.viewer';
const AUDIT_PASSWORD = 'browser-audit-2026';
const AUDIT_ROLE = 'AUDITOR';

function quote(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

async function lotRows(client: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select lot_number, inspection_note, created_by as opened_by,
             material_document_number as source_document, material_document_line as source_line
        from quality_lot where client = ${client}
       order by lot_number
    `);
    return rows as unknown as Array<{
      lot_number: string; inspection_note: string; opened_by: string; source_document: string; source_line: number;
    }>;
  });
}

/**
 * Everything a lot must not touch, read in one pass so the run can compare the whole of it across every quality
 * act — the same set `tests/quality-lot.test.ts` holds the service to, taken here from the tenant the browser
 * is posting into. Stock rows are what the stock overview and CO09 read, so their equality is that criterion.
 */
async function goodsState(client: string, materialDocumentNumber: string) {
  return withTenant(client, async (tx) => {
    const stock = await tx.execute(sql`
      select stock_type, batch_number, storage_location, quantity::text as quantity from stock_quantity
       where client = ${client} and material_number = ${MATERIAL} and plant = '1000'
       order by stock_type, batch_number, storage_location
    `) as unknown as Array<Record<string, string>>;
    const valuation = await tx.execute(sql`
      select total_stock_quantity::text as total, stock_value::text as value, moving_average_price::text as map
        from material_valuation where client = ${client} and material_number = ${MATERIAL} and valuation_area = '1000'
    `) as unknown as Array<Record<string, string>>;
    const batch = await tx.execute(sql`
      select batch_number, restricted_use, version, coalesce(changed_at::text, '') as changed_at
        from batch where client = ${client} and material_number = ${MATERIAL} order by batch_number
    `) as unknown as Array<Record<string, string>>;
    const documents = await tx.execute(sql`
      select count(*)::int as documents,
             (select count(*) from material_document_line where client = ${client})::int as lines
        from material_document where client = ${client}
    `) as unknown as Array<{ documents: number; lines: number }>;
    const journal = await tx.execute(sql`
      select count(*)::int as lines from journal_entry_line jl
        join material_document md on md.client = jl.client and md.journal_document_number = jl.document_number
       where md.client = ${client} and md.material_document_number = ${materialDocumentNumber}
    `) as unknown as Array<{ lines: number }>;
    return {
      stock, valuation: valuation[0] ?? null, batch,
      documents: documents[0]!.documents, documentLines: documents[0]!.lines,
      journalLines: journal[0]!.lines,
    };
  });
}

/**
 * QM slice 1 browser acceptance: inspection lots, taken through the screens.
 *
 * The eight criteria of §6 of `docs/operational-readiness.md`, in the order a user does them. Two of them are
 * named where they cannot be reached by a browser at all, rather than being quietly claimed: a repeated
 * submission (criterion 4) and the refusal an unauthorized save earns (criterion 7). The first because the
 * picker excludes a line the moment a lot covers it and the form generates its request key per render, so no
 * screen path re-sends a key — replay is then taken through the service against the same rows the browser is
 * showing; the second because the action's `can()` answer arrives before any form exists to press.
 */
export async function qualityLotReceipt(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('QM9192: open, read, refuse and flip the standing of an inspection lot in the browser');

  // ── The masters two receipts post against ─────────────────────────────────────────────────────────────
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Browser purchasing organization', '1000', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Browser Supplier', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', 'BROWSER_SMOKE') on conflict do nothing
    `);
    // Batch-managed on purpose: the lot detail must name a batch, and a lot that names no batch proves nothing
    // about the batch row it must leave alone.
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, batch_managed, created_by)
      values (${client}, ${MATERIAL}, 'Inspected steel plate', 'RAW', ${UNIT}, true, 'BROWSER_SMOKE')
      on conflict (client, material_number) do update set batch_managed = excluded.batch_managed
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
      values (${client}, ${MATERIAL}, '1000', 0, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, created_by
      )
      values (${client}, ${MATERIAL}, '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', 'BROWSER_SMOKE'),
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', 'BROWSER_SMOKE')
      on conflict do nothing
    `);
  });
  // The journal interval the receipt screen draws its own document number from: tenant creation deliberately
  // supplies no accounting intervals, so every target that posts a movement defines this one first — as
  // `goods-receipt.ts` and `sales-order-to-invoice.ts` do. Without it the receipt screen answers
  // `No number range is defined for RF_BELEG / 1000 / GENERAL` before the form can be reached.
  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL',
      fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999, createdBy: 'BROWSER_SMOKE',
    });
  });
  await initializeMaterialPeriodControl({
    client, changedBy: 'BROWSER_SMOKE', companyCode: '1000',
    fiscalYear: 2026, period: 10, reason: 'QM slice 1 acceptance run',
  });
  await saveBatchLevel({ client, changedBy: 'BROWSER_SMOKE', batchLevel: '1', version: 0, reason: 'Material level' });
  await createBatch({
    client, changedBy: 'BROWSER_SMOKE', materialNumber: MATERIAL, batchNumber: BATCH, reason: 'Receipt batch',
  });
  // Criterion 8 comes first, before anything can succeed: the standard package gives every tenant an INSPLOT
  // interval, so this run removes it, takes the refusal, then applies the remedy the refusal names.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`delete from number_range where client = ${client} and object_code = 'INSPLOT'`);
  });
  console.log('  · masters, batch and open period stand; no INSPLOT interval does, which is criterion 8\'s case');

  // ── 1. The screen opens, and offers what the receipts left standing ───────────────────────────────────
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('#command-input').fill(LOTS);
  await page.locator('#command-input').press('Enter');
  await page.waitForURL(/\/quality\/lots|\/registry/, { waitUntil: 'commit', timeout: 30_000 });
  assert.match(
    page.url(), /\/quality\/lots/,
    'The handle the migration registered must open the screen; landing on the registry search instead means '
    + 'the screen has no resolvable handle, which is the gap DI-025 records.',
  );
  await page.getByRole('heading', { level: 1, name: 'Inspection lots', exact: true }).waitFor();
  await page.getByText(/No inspection lot has been opened in this tenant yet/).waitFor();
  console.log('  ✓ 1. the registered handle opens the screen, and an empty tenant is reported as empty');

  /**
   * One order, then its goods receipt **through the receipt screen**. The order itself is created by the
   * purchasing service rather than by the grid: `scripts/browser-smoke/goods-receipt.ts` still drives
   * `form > div select` against `section[aria-labelledby="po-create"]`, and the grid has since wrapped its
   * fields in a `fieldset` with the supplier in a `ConstrainedField` — a harness sentence that has gone stale
   * beside the screen, reported in the run log rather than fixed here. The receipt, which is what this slice
   * posts against, stays in the browser.
   */
  async function receive(quantity: number): Promise<{ order: string; document: string }> {
    const created = await createOrder({
      client, changedBy: 'BROWSER_SMOKE',
      supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: '',
      items: [{
        materialNumber: MATERIAL, shortText: 'Inspected steel plate', quantity, unit: UNIT,
        netPrice: 100, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: STORE, batch: BATCH,
        markedForDeletion: false,
        scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
        assignments: [] as never[],
      }],
    });
    const order = created.orderNumber;

    await page.goto(`${base}${RECEIPT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    const operation = page.locator('section[aria-labelledby="gr-operation"]');
    await operation.locator('input[name="order"]').fill(order);
    await operation.getByRole('button', { name: 'Load reference', exact: true }).click();
    await page.waitForLoadState('networkidle');
    const items = page.locator('section[aria-labelledby="gr-items"]');
    await items.getByText(`Goods receipt for order ${order}`).waitFor();
    await items.locator('input[name="sloc-10"]').fill(STORE);
    await items.getByRole('button', { name: 'Post goods receipt', exact: true }).click();
    const posted = items.getByText(/Goods receipt posted as material document \S+\./);
    await posted.waitFor();
    const documentNumber = (await posted.textContent())?.match(/material document (\S+)\./)?.[1] ?? '';
    assert.ok(documentNumber, 'the material document number is shown');
    return { order, document: documentNumber };
  }

  const first = await receive(5);
  await page.goto(`${base}${LOTS}?document=${first.document}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const form = page.locator('form[aria-label="Open inspection lot"]');
  await form.waitFor();
  const candidate = form.locator('label').filter({ hasText: `${first.document} / 1` });
  assert.equal(await candidate.count(), 1, 'the standing receipt line the posting wrote is offered once');
  const candidateText = (await candidate.innerText()).replace(/\s+/g, ' ');
  for (const named of [MATERIAL, '1000', BATCH, `5.000 ${UNIT}`, 'UNRESTRICTED', 'GOODS_RECEIPT_PO']) {
    assert.match(candidateText, quote(named), `the offered row names ${named}`);
  }
  console.log(`  ✓ 1. the picker offers exactly the open receipt line, named: ${candidateText}`);

  // Criterion 8, taken through the form: refused by name, pointed at the screen that fixes it, nothing written.
  await candidate.locator('input[type="radio"]').check();
  await form.locator('[name="inspectionNote"]').fill('Visual check of the pallets, certificates with the delivery note');
  await form.getByRole('button', { name: 'Open lot', exact: true }).click();
  const noRange = page.locator('[role="status"]').filter({ hasText: /No active INSPLOT number range/ }).first();
  await noRange.waitFor();
  const noRangeText = (await noRange.innerText()).replace(/\s+/g, ' ');
  assert.match(noRangeText, /INSPLOT/, 'the refusal names the object code by which it is defined');
  assert.match(noRangeText, /\/config\/number-ranges/, 'and points at the screen that defines it');
  assert.equal((await lotRows(client)).length, 0, 'a refusal leaves no row behind');
  console.log(`  ✓ 8. with no INSPLOT interval the save answers ${noRangeText}`);

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'INSPLOT', subObject: '*', prefix: 'QL', numberLength: 7, createdBy: 'BROWSER_SMOKE',
    });
  });
  await page.goto(`${base}${LOTS}?document=${first.document}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const openForm = page.locator('form[aria-label="Open inspection lot"]');
  const openRow = openForm.locator('label').filter({ hasText: `${first.document} / 1` });
  await openRow.locator('input[type="radio"]').check();
  await openForm.locator('[name="inspectionNote"]').fill('Visual check of the pallets, certificates with the delivery note');
  await openForm.getByRole('button', { name: 'Open lot', exact: true }).click();
  const opened = page.locator('[role="status"]').filter({ hasText: /QL-\d+/ }).first();
  await opened.waitFor();
  const openedText = (await opened.innerText()).replace(/\s+/g, ' ');
  const lotNumber = (await opened.textContent())?.match(/QL-\d+/)?.[0] ?? '';
  assert.match(lotNumber, /^QL-\d{7}$/, 'the number the screen shows was drawn from the interval, in its own shape');
  assert.match(openedText, quote(`opened against ${first.document} line 1`), 'the confirmation names the line it covers');
  console.log(`  ✓ 1. choosing that line opened ${lotNumber} (${openedText})`);

  // ── 2. The detail, read back, and the link that leaves it ──────────────────────────────────────────────
  await page.goto(`${base}${LOTS}?lot=${lotNumber}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const detail = page.locator(`section[aria-label="Lot ${lotNumber}"]`);
  await detail.waitFor();
  const detailText = (await detail.innerText()).replace(/\s+/g, ' ');
  for (const named of [
    first.document, MATERIAL, BATCH, '1000', '0001', `5.000 ${UNIT}`, 'UNRESTRICTED', 'GOODS_RECEIPT_PO', first.order,
    'Visual check of the pallets',
  ]) {
    assert.match(detailText, quote(named), `the lot detail names ${named}`);
  }
  await detail.getByRole('link', { name: quote(`${first.document} / 1`) }).click();
  await page.waitForURL(quote(`${MATERIAL_DOCS}?document=${first.document}`), { waitUntil: 'commit', timeout: 30_000 });
  assert.match(page.url(), new RegExp(`${MATERIAL_DOCS}\\?document=${first.document}`), 'its link opens the document screen on that document');
  console.log(`  ✓ 2. ${lotNumber} reads the receipt back — document, line, movement, material, plant, storage location, batch, both quantity pairs, the segment and the order — and its link opens ${MATERIAL_DOCS}`);

  // ── 3. A line a lot covers leaves the list, and a second lot on it is refused ──────────────────────────
  await page.goto(`${base}${LOTS}?document=${first.document}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const afterOpen = page.locator('form[aria-label="Open inspection lot"]');
  assert.equal(
    await afterOpen.locator('label').filter({ hasText: `${first.document} / 1` }).count(), 0,
    'a covered line is not offered again: the screen cannot be asked to double it',
  );
  await afterOpen.getByText(/No received line stands open to inspection right now/).waitFor();
  const second = await receive(3);
  let duplicate: Error | null = null;
  try {
    await openLot({
      client, changedBy: ADMIN_USER, materialDocumentNumber: first.document, lineNumber: 1,
      requestKey: `QL-${randomUUID()}`,
    });
  } catch (error) {
    duplicate = error as Error;
  }
  assert.ok(duplicate, 'a second attempt on the covered line is refused');
  assert.match(duplicate!.message, quote(`Lot ${lotNumber} already stands against ${first.document} line 1`));
  const covered = await lotRows(client);
  assert.equal(covered.filter((r) => r.source_document === first.document).length, 1, 'and the line still carries one lot');
  console.log(`  ✓ 3. the covered line left the picker; the service refuses a second lot with: ${duplicate!.message}`);

  // ── 4 and 5. The row, its actor, its note, and a key that replays. ──────────────────────────────────────
  const [stored] = covered;
  assert.equal(
    (stored?.opened_by ?? '').toUpperCase(), ADMIN_USER.toUpperCase(),
    'the row names the session that opened it, never a typed actor (the audit columns hold the platform\'s uppercased actor, as everywhere)',
  );
  assert.match(stored?.inspection_note ?? '', /Visual check of the pallets/, 'the note is kept as it was typed');
  const replayKey = `QL-${randomUUID()}`;
  const serviceLot = await openLot({
    client, changedBy: ADMIN_USER, materialDocumentNumber: second.document, lineNumber: 1,
    inspectionNote: 'Dimensional check at the goods-in table', requestKey: replayKey,
  });
  const replay = await openLot({
    client, changedBy: ADMIN_USER, materialDocumentNumber: second.document, lineNumber: 1,
    inspectionNote: 'Dimensional check at the goods-in table', requestKey: replayKey,
  });
  assert.equal(replay.lotNumber, serviceLot.lotNumber, 'the same key returns the lot the first submission drew');
  assert.equal(replay.replayed, true, 'and says it replayed, which is the sentence the screen turns into its own');
  const replayed2 = await lotRows(client);
  assert.equal(replayed2.length, 2, 'two receipts, two lots: the replay added no row');
  await page.goto(`${base}${LOTS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const list = page.locator('section[aria-label="Inspection lots"]');
  await list.getByText(lotNumber).waitFor();
  await list.getByText(serviceLot.lotNumber).waitFor();
  console.log(`  ✓ 4 and 5. one row per receipt line, drawn number ${serviceLot.lotNumber} replayed under the same key with no second row (${replay.replayed ? 'replayed' : 'NOT marked'})`);

  // ── 6. Nothing the inventory engine owns moved. ────────────────────────────────────────────────────────
  const before = await goodsState(client, first.document);

  // ── 7. A session that does not hold the code. ── The role is the platform's own AUDITOR, and the code is
  // granted and revoked through the table the screens write, so the affordance and its absence are both the
  // authorization surface answering, not a fixture invented for the run.
  const auditUserId = randomUUID();
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into app_user (id, client, username, full_name, email, password_hash, is_active, must_change_password, created_by)
      values (${auditUserId}, ${client}, ${AUDIT_USER}, 'Quality viewer', ${'quality.viewer@cairn.invalid'},
              ${await hashPassword(AUDIT_PASSWORD)}, true, false, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into user_role (client, user_id, role_code, created_by)
      values (${client}, ${auditUserId}, ${AUDIT_ROLE}, 'BROWSER_SMOKE') on conflict do nothing
    `);
  });
  const held = async () => withTenant(client, async (tx) => tx.execute(sql`
    select count(*)::int as n from role_capability
     where client = ${client} and role_code = ${AUDIT_ROLE} and capability_code = ${CODE}
  `)) as unknown as Promise<Array<{ n: number }>>;
  assert.equal(Number((await held())[0]!.n), 0, 'the auditor role holds no lot code before this run grants one');

  const signOutSignIn = async (username: string, password: string) => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.goto(`${base}/signin`, { waitUntil: 'domcontentloaded' });
    await page.locator('[name="client"]').fill(client);
    await page.locator('[name="username"]').fill(username);
    await page.locator('[name="password"]').fill(password);
    const settled = page.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit', timeout: 30_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await settled;
  };
  await signOutSignIn(AUDIT_USER, AUDIT_PASSWORD);
  await page.goto(`${base}${LOTS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Inspection lots', exact: true }).waitFor();
  await page.getByText(/Lots are read-only for this session/).waitFor();
  assert.equal(
    await page.locator('form[aria-label="Open inspection lot"]').count(), 0,
    'a session without the code is offered no opening form at all',
  );
  await page.locator('section[aria-label="Inspection lots"]').getByText(lotNumber).waitFor();
  console.log(`  ✓ 7. without ${CODE} the session reads both lots and is offered no control to open a third`);

  // The save the criterion asks about cannot be reached from that render, because no form is rendered. The
  // half that can be reached is the grant: hand the role the code and the same session's next render answers
  // with the form. The refusal on save is then taken the only way the platform allows it — `can()` inside
  // the action, with no form to press — and is recorded as not browser-executed.
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into role_capability (client, role_code, capability_code, created_by)
      values (${client}, ${AUDIT_ROLE}, ${CODE}, 'BROWSER_SMOKE') on conflict do nothing
    `);
  });
  await page.goto(`${base}${LOTS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('form[aria-label="Open inspection lot"]').waitFor();
  assert.equal(
    await page.getByText(/Lots are read-only for this session/).count(), 0,
    'the grant, not the run, is what opened the form',
  );
  console.log('  ✓ 7. granting the code to that role opens the form on the next read — the affordance follows the authorization surface');
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      delete from role_capability where client = ${client} and role_code = ${AUDIT_ROLE} and capability_code = ${CODE}
    `);
  });

  await signOutSignIn(ADMIN_USER, ADMIN_PASSWORD);
  const afterActs = await goodsState(client, first.document);
  assert.deepEqual(afterActs, before, 'no quality act moved stock, valuation, the batch row, the documents or the journal');
  console.log('  ✓ 6. stock, valuation, the batch row, the document counts and the journal are identical across every quality act');

  // ── 6's other half: the standing that a reversal gives, not a status the lot keeps ─────────────────────
  await page.goto(`${base}${RECEIPT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const operation = page.locator('section[aria-labelledby="gr-operation"]');
  await operation.locator('input[name="doc"]').fill(first.document);
  await operation.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const documentSection = page.locator('section[aria-labelledby="gr-document"]');
  await documentSection.getByRole('button', { name: 'Reverse document', exact: true }).click();
  const reversedNotice = documentSection.getByText(/Reversal posted as material document \S+\./);
  await reversedNotice.waitFor();
  const reversalNumber = (await reversedNotice.textContent())?.match(/material document (\S+)\./)?.[1] ?? '';
  assert.ok(reversalNumber, 'the reversal names itself');

  await page.goto(`${base}${LOTS}?lot=${lotNumber}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const flipped = page.locator(`section[aria-label="Lot ${lotNumber}"]`);
  await flipped.waitFor();
  const flippedText = (await flipped.innerText()).replace(/\s+/g, ' ');
  assert.match(flippedText, /Source reversed/, 'the lot displays the standing it read from the receipt');
  assert.match(flippedText, quote(`Line 1 of ${first.document} was reversed by ${reversalNumber}`), 'and names the document that undid the goods');
  const afterReversal = await lotRows(client);
  assert.equal(afterReversal.length, 2, 'the reversal neither deleted the lot nor added one');
  assert.deepEqual(
    afterReversal.find((r) => r.lot_number === lotNumber), stored,
    'the lot row is untouched: the standing is read, not written back',
  );
  await page.goto(`${base}${LOTS}?document=${reversalNumber}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const reversalForm = page.locator('form[aria-label="Open inspection lot"]');
  await reversalForm.waitFor();
  // The candidate rows are the radios; the form also carries its own note label, which is not a line.
  assert.equal(
    await reversalForm.locator('input[type="radio"]').count(), 0,
    'the reversal line records goods going back, so it is not offered for inspection',
  );
  await reversalForm.getByText(/No received line stands open to inspection right now/).waitFor();
  let reversedOut: Error | null = null;
  try {
    await openLot({
      client, changedBy: ADMIN_USER, materialDocumentNumber: reversalNumber, lineNumber: 1,
      requestKey: `QL-${randomUUID()}`,
    });
  } catch (error) {
    reversedOut = error as Error;
  }
  assert.ok(reversedOut, 'and the service refuses that line on the way in');
  assert.match(reversedOut!.message, /it records goods going back/);
  console.log(`  ✓ 6. reversing ${first.document} as ${reversalNumber} flipped the displayed standing, left the row alone, and took the line out of the picker (${reversedOut!.message})`);
}

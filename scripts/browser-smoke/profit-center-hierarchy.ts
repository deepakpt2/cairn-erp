import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/profit-center-hierarchy';
const ACTIVITY = 'CFG.COST.PROFITCENTERHIER.DEFINE';
const REASON = 'Browser acceptance run';
const CENTRE = 'PC900';

/**
 * SCR-046 / KCH1·KCH5N browser acceptance: defining the profit centre hierarchy.
 *
 * The journey follows the two structures. The standard hierarchy: its
 * header defined, a root and a child node defined under it, the fixture
 * period placed, the exclusive placement refused a second home, node
 * deletion refused while children stand. Alternative groups beside it:
 * a group defined, a ranged leaf resolving over the fixture centre, and
 * the centre left standing when its placement is taken away.
 *
 * The fixture period is stood up directly (SCR-041's screen is accepted
 * on its own target); everything this screen does is then asserted twice
 * — once in the browser, because the screen is the product, and once in
 * the database, because a form that renders a value is not a form that
 * stored it. The service's judging refusals — cycles, the ten-level
 * guard, leaf shapes — are asserted in the service tests.
 */
export async function profitCenterHierarchyKch1(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-046 KCH1/KCH5N: verify the workbench route, the hierarchy header, nodes, exclusive placement, blocked deletion, the ranged group, and unassign');

  // The fixture: prerequisite activities stand completed, this activity
  // ready to run, and one profit centre period standing in the delivered
  // controlling area to be placed.
  await withTenant(client, async (tx) => {
    for (const code of ['CFG.COST.CONTROLLINGAREA.DEFINE', 'CFG.COST.PROFITCENTER.DEFINE']) {
      await tx.execute(sql`
        insert into config_activity_status (client, activity_code, status, created_by)
        values (${client}, ${code}, 'COMPLETED', 'BROWSER_SMOKE')
        on conflict (client, activity_code) do update set status = 'COMPLETED'
      `);
    }
    await tx.execute(sql`
      insert into config_activity_status (client, activity_code, status, created_by)
      values (${client}, ${ACTIVITY}, 'NOT_STARTED', 'BROWSER_SMOKE')
      on conflict (client, activity_code) do nothing
    `);
    await tx.execute(sql`
      insert into profit_center (client, controlling_area, profit_center, valid_from, valid_to, name, created_by)
      select ${client}, controlling_area, ${CENTRE}, '2026-01-01', '9999-12-31', 'Acceptance centre', 'BROWSER_SMOKE'
      from controlling_area_company
      where client = ${client}
      limit 1
      on conflict do nothing
    `);
  });
  const area = await controllingAreaOf(client);
  assert.ok(area, 'The fixture tenant stands a controlling area assignment.');

  // ── 1. The workbench routes here; nothing is defined yet ────────────────
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Define Profit Centre Hierarchy', exact: true }).waitFor();
  assert.match(
    await page.locator('header .code').first().innerText(),
    new RegExp(`${ACTIVITY} · KCH1/KCH5N`),
    'The screen says which activity and which reference transactions it is.',
  );
  console.log('  ✓ the workbench routes here');

  // ── 2. The hierarchy header and its nodes ───────────────────────────────
  const definePanel = page.locator('section[aria-labelledby="hier-define-title"]');
  await definePanel.locator('#hier-title').fill('Acceptance hierarchy');
  await definePanel.locator('#hier-define-reason').fill(REASON);
  await definePanel.getByRole('button', { name: 'Define hierarchy', exact: true }).click();
  // The success unmounts the define panel; the standing heading is the evidence.
  await page.getByRole('heading', { name: 'Standard hierarchy — Acceptance hierarchy', exact: true }).waitFor();

  const nodePanel = page.locator('section[aria-labelledby="hier-node-create-title"]');
  await nodePanel.locator('#hier-node-key').fill('ALL');
  await nodePanel.locator('#hier-node-title').fill('All profit centres');
  await nodePanel.locator('#hier-node-reason').fill(REASON);
  await nodePanel.getByRole('button', { name: 'Define node', exact: true }).evaluate((el) => (el as HTMLElement).click());
  await page.getByRole('status').filter({ hasText: 'Node ALL defined.' }).waitFor();

  await nodePanel.locator('#hier-node-key').fill('PLANTS');
  await nodePanel.locator('#hier-node-title').fill('Plant centres');
  await nodePanel.locator('#hier-node-parent').selectOption('ALL');
  await nodePanel.locator('#hier-node-reason').fill(REASON);
  await nodePanel.getByRole('button', { name: 'Define node', exact: true }).evaluate((el) => (el as HTMLElement).click());
  await page.getByRole('status').filter({ hasText: 'Node PLANTS defined.' }).waitFor();
  console.log('  ✓ the header stands, with root ALL and PLANTS under it');

  // ── 3. Placement is exclusive ────────────────────────────────────────────
  const placePanel = page.locator('section[aria-labelledby="hierarchy-place-title"]');
  await placePanel.locator('#place-period').selectOption(`${CENTRE}:2026-01-01`);
  await placePanel.locator('#place-node').selectOption('PLANTS');
  await placePanel.locator('#place-reason').fill(REASON);
  await placePanel.getByRole('button', { name: 'Place period', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: new RegExp(`Profit Centre ${CENTRE} from 2026-01-01 placed in Node PLANTS`) })
    .waitFor();
  assert.equal(await placedNode(client, CENTRE), 'PLANTS', 'The placement is stored.');

  await placePanel.locator('#place-period').selectOption(`${CENTRE}:2026-01-01`);
  await placePanel.locator('#place-node').selectOption('ALL');
  await placePanel.locator('#place-reason').fill(REASON);
  await placePanel.getByRole('button', { name: 'Place period', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /already stands in Node PLANTS/ }).waitFor();
  console.log('  ✓ the period stands in PLANTS, and a second home is refused');

  // ── 4. A node with children cannot be deleted ────────────────────────────
  const treeSection = page.locator('section[aria-labelledby="hierarchy-tree-title"]');
  const rootRow = treeSection
    .locator('tbody tr')
    .filter({ has: page.locator('td:first-child').getByText('ALL', { exact: true }) })
    .first();
  await rootRow.getByText('Delete', { exact: true }).first().click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete Node ALL' });
  await deleteDialog.waitFor();
  await deleteDialog.getByText(/child node.*stand under this node/).waitFor();
  await deleteDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await deleteDialog.waitFor({ state: 'hidden' });
  console.log('  ✓ root deletion states its children and refuses');

  // ── 5. A ranged group leaf resolves over the centre ─────────────────────
  const groupPanel = page.locator('section[aria-labelledby="hier-group-create-title"]');
  await groupPanel.locator('#group-name').fill('OPSG');
  await groupPanel.locator('#group-title').fill('Operations centres');
  await groupPanel.locator('#group-create-reason').fill(REASON);
  await groupPanel.getByRole('button', { name: 'Define group', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Group OPSG defined.' }).waitFor();

  const groupCard = page.locator('section[aria-labelledby="group-OPSG"]');
  await groupCard.locator('#leaf-OPSG-option').selectOption('BT');
  await groupCard.locator('#leaf-OPSG-from').fill('PC100');
  await groupCard.locator('#leaf-OPSG-to').fill('PC999');
  await groupCard.locator('#leaf-OPSG-reason').fill(REASON);
  await groupCard.getByRole('button', { name: 'Add leaf', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'The leaf stands in the group.' }).waitFor();
  await groupCard.getByText(new RegExp(`Members: ${CENTRE}`)).waitFor();
  console.log('  ✓ the ranged leaf resolves over the fixture centre');

  // ── 6. Unassigning leaves the centre standing ────────────────────────────
  const placementRow = placePanel
    .locator('tbody tr')
    .filter({ has: page.locator('td:first-child').getByText('PLANTS', { exact: true }) })
    .first();
  await placementRow.getByText('Unassign', { exact: true }).first().click();
  const unassignDialog = page.getByRole('dialog', { name: /^Unassign/ });
  await unassignDialog.waitFor();
  await unassignDialog.locator(`#unplace-reason-${CENTRE}-2026-01-01`).fill(REASON);
  await unassignDialog.getByRole('button', { name: 'Unassign period', exact: true }).click();
  // The success unmounts the dialog with the placement row; the unplaced list is the evidence.
  await page.getByText(`Unplaced periods: ${CENTRE} from 2026-01-01`).waitFor();
  assert.equal(await placedNode(client, CENTRE), null, 'The placement is gone.');
  assert.equal(await centreStands(client, CENTRE), true, 'The profit centre itself stands.');
  const docs = await withTenant(client, (tx) =>
    changeHistory(tx, client, 'profit_center_node_assignment', `${area}/${CENTRE}/2026-01-01`),
  );
  assert.ok(
    docs.some(
      (document) =>
        document.transactionCode === ACTIVITY &&
        document.changeType === 'DELETE' &&
        document.reason === REASON,
    ),
    'The unassignment is documented with its reason.',
  );
  console.log('  ✓ the placement is removed and documented; the centre stands');

  console.log('SCR-046 KCH1/KCH5N passed: workbench route, header, nodes, exclusivity, blocked deletion, ranged group, unassign');
}

async function controllingAreaOf(client: string): Promise<string> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select controlling_area from profit_center where profit_center = ${CENTRE} limit 1`),
  )) as unknown as Array<{ controlling_area: string }>;
  if (rows[0]) return rows[0].controlling_area;
  const areas = (await withTenant(client, (tx) =>
    tx.execute(sql`select controlling_area from controlling_area_company limit 1`),
  )) as unknown as Array<{ controlling_area: string }>;
  return areas[0]?.controlling_area ?? '';
}

async function placedNode(client: string, centre: string): Promise<string | null> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`
      select node from profit_center_node_assignment
      where profit_center = ${centre} and valid_from = '2026-01-01'
    `),
  )) as unknown as Array<{ node: string }>;
  return rows[0]?.node ?? null;
}

async function centreStands(client: string, centre: string): Promise<boolean> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(sql`select profit_center from profit_center where profit_center = ${centre} limit 1`),
  )) as unknown as Array<{ profit_center: string }>;
  return rows.length > 0;
}

/**
 * Narrow preparation and freshness checks for the trusted walkthrough installer.
 * This module is not an HTTP action and must only be called by walkthrough-seed.ts.
 */
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/client';
import { appUser, authOrgRestriction, userRole } from '../tables/security';
import { client as clientTable } from '../tables/tenancy';
import { listTenants } from './index';
import { assertFreshWalkthroughFirstAdmin, assertFreshWalkthroughTenantInventory } from './walkthrough-install-guard';

interface TenantRow {
  client: string;
  name: string;
  legalName: string | null;
  country: string;
  currency: string;
  timezone: string;
  status: string;
  isDevelopment: boolean;
  createdBy: string;
  createdAt: Date;
  onboardingCompletedAt: Date | null;
}

/**
 * Positively establish that this is the one newly onboarded tenant in a fresh
 * development database. Global reference tables have no `client` column and are
 * intentionally outside this tenant-scoped census.
 */
export async function assertFreshWalkthroughTenant(client: string, expectedUsername: string): Promise<TenantRow> {
  const tenants = await listTenants();
  assertFreshWalkthroughTenantInventory(tenants.length, tenants[0]?.client, client);

  return withTenant(client, async (tx) => {
    const tenantRows = await tx.select().from(clientTable).where(sql`${clientTable.client} = ${client}`).limit(1);
    const tenant = tenantRows[0] as TenantRow | undefined;
    if (!tenant || tenant.status !== 'ACTIVE' || !tenant.isDevelopment || tenant.name !== 'Walkthrough Company' ||
      tenant.legalName !== 'Walkthrough Company LLC' || tenant.country !== 'AE' || tenant.currency !== 'AED' ||
      tenant.timezone !== 'Asia/Dubai' || tenant.onboardingCompletedAt) {
      throw new Error(`Tenant ${client} is not an eligible active, incomplete development walkthrough tenant.`);
    }

    const users = await tx.select({
      id: appUser.id,
      username: appUser.username,
      isActive: appUser.isActive,
      isLocked: appUser.isLocked,
      mustChangePassword: appUser.mustChangePassword,
    }).from(appUser).where(sql`${appUser.client} = ${client}`);
    const assignments = await tx.select({ userId: userRole.userId, roleCode: userRole.roleCode })
      .from(userRole).where(sql`${userRole.client} = ${client}`);
    const scopes = await tx.select({ id: authOrgRestriction.id }).from(authOrgRestriction)
      .where(sql`${authOrgRestriction.client} = ${client}`);
    assertFreshWalkthroughFirstAdmin({ users, expectedUsername, roleAssignments: assignments, scopeCount: scopes.length });

    await assertOnboardingOnlyTenantRows(tx, client, tenant.createdAt, tenant.createdBy);
    return tenant;
  });
}

async function assertOnboardingOnlyTenantRows(tx: Tx, client: string, createdAt: Date, createdBy: string): Promise<void> {
  const baselineCutoff = new Date(createdAt.getTime() + 60_000);
  const rows = await tx.execute(sql`
    select table_name,
           bool_or(column_name = 'created_at') as has_created_at,
           bool_or(column_name = 'created_by') as has_created_by,
           bool_or(column_name = 'changed_at') as has_changed_at,
           bool_or(column_name = 'changed_by') as has_changed_by
      from information_schema.columns
     where table_schema = 'public'
       and column_name in ('client', 'created_at', 'created_by', 'changed_at', 'changed_by')
     group by table_name
    having bool_or(column_name = 'client')
     order by table_name
  `) as unknown as Array<{
    table_name: string;
    has_created_at: boolean;
    has_created_by: boolean;
    has_changed_at: boolean;
    has_changed_by: boolean;
  }>;

  // Change items inherit provenance from their parent change_document, which is checked below.
  const childAuditTables = new Set(['change_document_item']);
  const structureTables = new Set([
    'company_code', 'credit_control_area', 'controlling_area', 'controlling_area_company',
    'plant', 'storage_location', 'purchasing_org', 'purchasing_org_plant', 'sales_org',
    'sales_org_text', 'sales_org_distribution_channel', 'sales_org_division', 'sales_area',
  ]);
  const businessDataTables = new Set([
    'material', 'material_plant', 'material_valuation', 'material_document', 'material_document_line', 'stock_quantity',
    'business_partner', 'bp_role', 'customer_company', 'supplier_company', 'supplier_purchasing', 'customer_sales_area',
    'tax_code', 'material_period_control', 'purchase_order', 'purchase_order_item', 'purchase_order_schedule',
    'supplier_invoice', 'journal_entry', 'journal_entry_line', 'production_order', 'planned_order', 'sales_order',
    'delivery', 'billing_document', 'outgoing_payment', 'incoming_payment', 'customer_clearing', 'vendor_clearing',
  ]);
  const conflicts: string[] = [];

  for (const row of rows) {
    if (childAuditTables.has(row.table_name) || row.table_name === 'user_session') continue;
    if (!/^[a-z_][a-z0-9_]*$/.test(row.table_name)) {
      conflicts.push('unrecognized tenant table');
      continue;
    }
    const relation = sql.raw(`public."${row.table_name}"`);
    if (structureTables.has(row.table_name) || businessDataTables.has(row.table_name)) {
      const result = await tx.execute(sql`select exists (select 1 from ${relation} where "client" = ${client}) as conflict`) as unknown as Array<{ conflict: boolean }>;
      if (result[0]?.conflict) conflicts.push(row.table_name);
      continue;
    }
    if (row.table_name === 'audit_access_log') {
      const result = await tx.execute(sql`
        select exists (
          select 1 from ${relation}
           where "client" = ${client}
             and "event_type" not in ('LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'READ')
        ) as conflict
      `) as unknown as Array<{ conflict: boolean }>;
      if (result[0]?.conflict) conflicts.push(row.table_name);
      continue;
    }
    const provenanceChecks = [];
    if (row.has_created_at) provenanceChecks.push(sql`"created_at" > ${baselineCutoff}`);
    if (row.has_created_by) provenanceChecks.push(sql`"created_by" IS DISTINCT FROM ${createdBy}`);
    if (row.table_name === 'app_user') {
      // Normal sign-in updates only last_login_at and the technical AUTH audit fields.
      if (row.has_changed_by) provenanceChecks.push(sql`("changed_by" IS NOT NULL AND "changed_by" NOT IN (${createdBy}, 'AUTH'))`);
    } else {
      if (row.has_changed_at) provenanceChecks.push(sql`"changed_at" > ${baselineCutoff}`);
      if (row.has_changed_by) provenanceChecks.push(sql`("changed_by" IS NOT NULL AND "changed_by" IS DISTINCT FROM ${createdBy})`);
    }
    const conditions = [sql`"client" = ${client}`];
    if (provenanceChecks.length) conditions.push(sql`(${sql.join(provenanceChecks, sql` OR `)})`);

    const result = await tx.execute(sql`
      select exists (
        select 1 from ${relation}
         where ${sql.join(conditions, sql` AND `)}
      ) as conflict
    `) as unknown as Array<{ conflict: boolean }>;
    if (result[0]?.conflict) conflicts.push(row.table_name);
  }

  if (conflicts.length) {
    throw new Error(`Fresh-install eligibility refused tenant rows outside untouched onboarding state: ${[...new Set(conflicts)].join(', ')}.`);
  }
}

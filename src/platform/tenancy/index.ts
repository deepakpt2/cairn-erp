/**
 * Tenant service — CAIRN.md §6.3, §7.2, D-006
 *
 * Creating a tenant is a real, guided, tested feature — not a seed script. The
 * product owner creates their own tenant through the UI during page-by-page
 * testing, so this path must be as solid as any transaction screen.
 *
 * Note how tenant creation works under row-level security: the first insert sets
 * the session key to the very tenant being created, so the policy's WITH CHECK
 * passes. No elevation, no back door, no special case in the security model.
 */
import { and, eq } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/client';
import { client as clientTable, clientSettings } from '../tables/tenancy';
import { appUser, role, roleCapability, userRole } from '../tables/security';
import { configActivity, configActivityStatus } from '../tables/registry';
import { defineRange } from '../numbering';
import { hashPassword, checkPasswordPolicy } from '../auth/password';

/** Roles seeded into every new tenant — CAIRN.md §7.3 */
const SYSTEM_ROLES: Array<{
  code: string;
  name: string;
  description: string;
  readOnly: boolean;
  capabilities: string[];
}> = [
  {
    code: 'ADMINISTRATOR',
    name: 'Administrator',
    description: 'Full configuration and user administration',
    readOnly: false,
    capabilities: ['*'],
  },
  {
    code: 'CONFIGURATOR',
    name: 'Configurator',
    description: 'Maintains configuration through the workbench; cannot post documents',
    readOnly: false,
    capabilities: ['CFG.*', 'FND.*', 'PLT.MESSAGE.DISPLAY'],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'General ledger, payables, receivables and banking',
    readOnly: false,
    capabilities: ['FIN.*', 'COST.*', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'CONTROLLER',
    name: 'Controller',
    description: 'Costing, profitability and reporting; read-only on operational documents',
    readOnly: false,
    capabilities: ['COST.*', 'FIN.RPT.*', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'BUYER',
    name: 'Buyer',
    description: 'Requisitions, purchase orders and supplier negotiation',
    readOnly: false,
    capabilities: ['PROC.*', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'PLANNER',
    name: 'Planner',
    description: 'MRP, planned orders and production orders',
    readOnly: false,
    capabilities: ['PROD.*', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'PRODUCTION_CLERK',
    name: 'Production clerk',
    description: 'Shop-floor confirmations and goods movements',
    readOnly: false,
    capabilities: ['PROD.CONFIRM.*', 'PROD.ORDER.GI', 'PROD.ORDER.GR', 'INV.STOCK.VIEW'],
  },
  {
    code: 'WAREHOUSE_CLERK',
    name: 'Warehouse clerk',
    description: 'Goods receipts, issues, transfers and physical inventory',
    readOnly: false,
    capabilities: ['INV.*', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'SALES_CLERK',
    name: 'Sales clerk',
    description: 'Quotations, orders, deliveries and billing',
    readOnly: false,
    capabilities: ['SALES.*', 'INV.STOCK.VIEW', 'AUDIT.TRAIL.VIEW'],
  },
  {
    code: 'AUDITOR',
    name: 'Auditor',
    description:
      'Read-only external verification. Cannot post, change or delete anything, ' +
      'and its own access is logged.',
    readOnly: true,
    capabilities: ['AUDIT.*', '*.*.DISPLAY'],
  },
];

/** Operational ranges only. FI intervals are customer-maintained (D-043). */
const STANDARD_RANGES: Array<{
  objectCode: string;
  subObject: string;
  prefix: string;
  length: number;
}> = [
  { objectCode: 'MATERIAL_DOCUMENT', subObject: '*', prefix: 'MD', length: 8 },
  { objectCode: 'PURCHASE_ORDER', subObject: 'POF', prefix: 'POF', length: 7 },
  { objectCode: 'PURCHASE_REQUISITION', subObject: 'NB', prefix: 'PR', length: 7 },
  { objectCode: 'SALES_ORDER', subObject: 'OR', prefix: 'SO', length: 7 },
  { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', length: 7 },
  { objectCode: 'BILLING_DOCUMENT', subObject: 'F2', prefix: 'INV', length: 7 },
  { objectCode: 'PRODUCTION_ORDER', subObject: '*', prefix: 'PRD', length: 7 },
  { objectCode: 'PRODUCTION_CONFIRMATION', subObject: '*', prefix: 'CNF', length: 7 },
  { objectCode: 'PAYMENT_RUN', subObject: '*', prefix: 'PMT', length: 6 },
  { objectCode: 'VENDOR_INVOICE', subObject: '*', prefix: 'VI', length: 7 },
];

export interface CreateTenantInput {
  clientKey: string;
  name: string;
  legalName?: string;
  country: string;
  currency: string;
  language?: string;
  timezone?: string;
  isDevelopment?: boolean;
  /** First company code — the legal entity that keeps the books (§6.1). */
  companyCode: string;
  companyName: string;
  fiscalYearVariant: string;
  chartOfAccounts: string;
  administrator: {
    username: string;
    fullName: string;
    email?: string;
    password: string;
  };
  /**
   * Activate the standard configuration package in the same transaction (§7.3).
   * The onboarding wizard offers this, and it is what makes a new tenant able to
   * post a balanced entry on its first day rather than presenting empty screens.
   */
  activateStandardPackage?: boolean;
  createdBy: string;
}

export interface CreatedTenant {
  client: string;
  companyCode: string;
  administratorUsername: string;
  rolesCreated: number;
  rangesCreated: number;
  onboardingActivities: number;
  packageVersion?: string;
  accountsCreated?: number;
}

export class TenancyError extends Error {
  readonly code = 'CAIRN_TENANCY';
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

export async function createTenant(input: CreateTenantInput, admission?: (tx: Tx) => Promise<void>): Promise<CreatedTenant> {
  validateKey(input.clientKey);
  validateKey(input.companyCode, 'Company code');

  const policyIssue = checkPasswordPolicy(input.administrator.password);
  if (policyIssue) {
    throw new TenancyError(policyIssue, 'Choose a longer password containing letters and digits.');
  }

  const clientKey = input.clientKey.toUpperCase();
  const companyCode = input.companyCode.toUpperCase();

  const existing = await withTenant(clientKey, (tx) =>
    tx.select().from(clientTable).where(eq(clientTable.client, clientKey)).limit(1),
  );
  if (existing.length > 0) {
    throw new TenancyError(
      `Tenant ${clientKey} already exists.`,
      'Choose a different tenant key, or open the existing tenant from the list.',
    );
  }

  const passwordHash = await hashPassword(input.administrator.password);
  const userId = crypto.randomUUID();

  // Everything below happens in ONE transaction. A half-created tenant would be
  // worse than no tenant: it would look usable and fail in confusing ways later.
  return withTenant(clientKey, async (tx) => {
    if (admission) await admission(tx);
    // ── The tenant itself ────────────────────────────────────────────────────
    await tx.insert(clientTable).values({
      client: clientKey,
      name: input.name,
      legalName: input.legalName,
      country: input.country.toUpperCase(),
      currency: input.currency.toUpperCase(),
      language: (input.language ?? 'EN').toUpperCase(),
      timezone: input.timezone ?? 'UTC',
      status: 'ACTIVE',
      isDevelopment: input.isDevelopment ?? false,
      createdBy: input.createdBy,
    });

    await tx.insert(clientSettings).values({
      client: clientKey,
      fiscalYearVariant: input.fiscalYearVariant,
      createdBy: input.createdBy,
    });

    // ── Roles and capabilities ───────────────────────────────────────────────
    let rolesCreated = 0;
    for (const systemRole of SYSTEM_ROLES) {
      await tx.insert(role).values({
        client: clientKey,
        code: systemRole.code,
        name: systemRole.name,
        description: systemRole.description,
        isSystemRole: true,
        isReadOnly: systemRole.readOnly,
        createdBy: input.createdBy,
      });

      // Capabilities are global definitions; the ANTI pattern below is resolved
      // at authorisation time, not by expanding wildcards into thousands of rows.
      for (const capabilityCode of systemRole.capabilities) {
        await tx
          .insert(roleCapability)
          .values({
            client: clientKey,
            roleCode: systemRole.code,
            capabilityCode,
            createdBy: input.createdBy,
          })
          .onConflictDoNothing();
      }
      rolesCreated++;
    }

    // ── Administrator ────────────────────────────────────────────────────────
    await tx.insert(appUser).values({
      id: userId,
      client: clientKey,
      username: input.administrator.username,
      fullName: input.administrator.fullName,
      email: input.administrator.email,
      passwordHash,
      isActive: true,
      mustChangePassword: false,
      createdBy: input.createdBy,
    });

    await tx.insert(userRole).values({
      client: clientKey,
      userId,
      roleCode: 'ADMINISTRATOR',
      createdBy: input.createdBy,
    });

    // ── Number ranges ────────────────────────────────────────────────────────
    let rangesCreated = 0;
    for (const range of STANDARD_RANGES) {
      await defineRange(tx, {
        client: clientKey,
        objectCode: range.objectCode,
        subObject: range.subObject,
        prefix: range.prefix,
        numberLength: range.length,
        createdBy: input.createdBy,
      });
      rangesCreated++;
    }

    // ── Configuration workbench state ────────────────────────────────────────
    // Every activity starts NOT_STARTED. The workbench shows what to do next;
    // the onboarding wizard walks the user through it in order (§7.2).
    const activities = await tx.select().from(configActivity);
    for (const activity of activities) {
      await tx
        .insert(configActivityStatus)
        .values({
          client: clientKey,
          activityCode: activity.code,
          status: 'NOT_STARTED',
          createdBy: input.createdBy,
        })
        .onConflictDoNothing();
    }

    // Tenant, standard roles and the first user were actually created above.
    for (const code of ['CFG.PLT.CLIENT.DEFINE', 'CFG.PLT.ROLE.DEFINE', 'CFG.PLT.USER.CREATE']) {
      await markActivityComplete(tx, clientKey, code, input.createdBy);
    }

    // ── Standard configuration package ──────────────────────────────────────
    // Activated before the company code step is marked complete, because the
    // package is what actually creates the chart of accounts, the fiscal year
    // variant, the posting period rules and the company code itself.
    let packageVersion: string | undefined;
    let accountsCreated: number | undefined;

    if (input.activateStandardPackage !== false) {
      const { applyStandardPackage } = await import('../../modules/foundation/standard-config');
      const result = await applyStandardPackage(tx, {
        client: clientKey,
        companyCode,
        companyName: input.companyName,
        currency: input.currency.toUpperCase(),
        country: input.country.toUpperCase(),
        city: undefined,
        fiscalYearVariant: input.fiscalYearVariant,
        activatedBy: input.createdBy,
      });
      packageVersion = result.version;
      accountsCreated = result.accounts;

      // Mark the onboarding activities the package has just satisfied, so the
      // workbench reflects reality instead of asking for work already done.
      for (const code of [
        'CFG.ORG.COMPANYCODE.DEFINE',
        'CFG.FIN.COA.DEFINE',
        'CFG.ORG.COMPANYCODE.ASSIGN_COA',
        'CFG.FIN.FYV.DEFINE',
        'CFG.FIN.FYV.ASSIGN',
        'CFG.FIN.PPV.DEFINE',
        'CFG.FIN.PPV.ASSIGN',
        'CFG.FIN.DOCTYPE.DEFINE',
        'CFG.ORG.PLANT.DEFINE',
        'CFG.ORG.PLANT.ASSIGN_COMPANY',
        'CFG.ORG.STORAGELOC.DEFINE',
        'CFG.PROC.PURORG.DEFINE',
        'CFG.PROC.PURORG.ASSIGN_COMPANY',
        'CFG.PROC.PURORG.ASSIGN_PLANT',
        'CFG.PROC.PURGROUP.DEFINE',
        'CFG.SALES.SALESORG.DEFINE',
        'CFG.SALES.SALESORG.ASSIGN_COMPANY',
        'CFG.ORG.DISTCHANNEL.DEFINE',
        'CFG.ORG.DIVISION.DEFINE',
        'CFG.ORG.SALESAREA.DEFINE',
        'CFG.COST.CONTROLLINGAREA.DEFINE',
        'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY',
        'CFG.FIN.CREDIT.DEFINE',
        'CFG.FIN.EXRATE.MAINTAIN',
      ]) {
        await markActivityComplete(tx, clientKey, code, input.createdBy);
      }
    } else {
      await markActivityComplete(tx, clientKey, 'CFG.ORG.COMPANYCODE.DEFINE', input.createdBy);
    }

    return {
      client: clientKey,
      companyCode,
      administratorUsername: input.administrator.username,
      rolesCreated,
      rangesCreated,
      onboardingActivities: activities.length,
      packageVersion,
      accountsCreated,
    };
  });
}

export interface TenantSummary {
  client: string;
  name: string;
  country: string;
  currency: string;
  status: string;
  is_development: boolean;
  created_at: Date;
}

/**
 * List tenants for the tenant picker.
 *
 * This is inherently cross-tenant, so it goes through the narrow SECURITY DEFINER
 * function defined in 9001_admin_functions.sql rather than by handing the
 * application an elevated connection. The function returns a whitelisted set of
 * columns and cannot read business data (§6.3).
 */
export async function listTenants(): Promise<TenantSummary[]> {
  const { db } = await import('../db/client');
  const { sql } = await import('drizzle-orm');
  const rows = await db().execute(sql`select * from cairn_list_tenants()`);
  return rows as unknown as TenantSummary[];
}

export interface ConfigReadiness {
  totalActivities: number;
  completedActivities: number;
  nextActivity: string | null;
  nextActivityTitle: string | null;
  nextActivityRoute: string | null;
}

/** Workbench readiness for one tenant, via the same whitelisted-function approach. */
export async function configReadiness(clientKey: string): Promise<ConfigReadiness> {
  const { db } = await import('../db/client');
  const { sql } = await import('drizzle-orm');
  const rows = (await db().execute(
    sql`select * from cairn_config_readiness(${clientKey})`,
  )) as unknown as Array<{
    total_activities: string;
    completed_activities: string;
    next_activity: string | null;
    next_activity_title: string | null;
    next_activity_route: string | null;
  }>;

  const row = rows[0];
  return {
    totalActivities: Number(row?.total_activities ?? 0),
    completedActivities: Number(row?.completed_activities ?? 0),
    nextActivity: row?.next_activity ?? null,
    nextActivityTitle: row?.next_activity_title ?? null,
    nextActivityRoute: row?.next_activity_route ?? null,
  };
}

export async function getTenant(clientKey: string) {
  return withTenant(clientKey, (tx) =>
    tx.select().from(clientTable).where(eq(clientTable.client, clientKey)).limit(1),
  );
}

export async function markActivityComplete(
  tx: Tx,
  clientKey: string,
  activityCode: string,
  by: string,
) {
  await tx
    .update(configActivityStatus)
    .set({
      status: 'COMPLETED',
      completedAt: new Date(),
      completedBy: by,
      changedBy: by,
      changedAt: new Date(),
    })
    .where(
      and(
        eq(configActivityStatus.client, clientKey),
        eq(configActivityStatus.activityCode, activityCode),
      ),
    );
}

function validateKey(key: string, label = 'Tenant key') {
  if (!/^[A-Za-z0-9]{2,4}$/.test(key)) {
    throw new TenancyError(
      `${label} "${key}" is not valid.`,
      'Use two to four letters or digits, for example 0100 or ACME.',
    );
  }
}

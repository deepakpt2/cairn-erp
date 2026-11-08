/**
 * CAIRN-7 §30 — manual, development-only walkthrough seed.
 *
 * The seed never creates tenants or users. Start from the single tenant and real first
 * administrator created through normal development onboarding, then invoke this CLI.
 * Its trusted, one-time setup prepares the standard package and enterprise structure,
 * and grants only Company Code 1000 and Plant 1000 through the normal audited scope
 * domain service. The walkthrough then uses ordinary posting services and a live
 * application session; it never uses migration credentials, deletes data, updates a
 * mismatching record, or auto-approves a pending PO.
 *
 * Required: CAIRN_ENV=development, DATABASE_URL (cairn_app), CAIRN_SEED_DATABASE,
 * CAIRN_SEED_TENANT, CAIRN_SEED_DATE (YYYY-MM-DD), CAIRN_SEED_ORIGIN,
 * CAIRN_SEED_USERNAME and CAIRN_SEED_PASSWORD. Repeat with the SAME date.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { validateTarget } from './src/platform/db/target-guard';
import { assertApplicationRole, closeDb, withTenant, type Tx } from './src/platform/db/client';
import {
  hasCapability, loadOrgRestrictions, parseSessionCookie, resolveSession, SESSION_COOKIE,
  type SessionContext,
} from './src/platform/auth/session';
import { client as tenantTable } from './src/platform/tables/tenancy';
import {
  companyCode, creditControlArea, storageLocation as storageLocationTable, controllingArea,
  controllingAreaCompany, plant as plantTable, purchasingOrg, purchasingOrgPlant, salesArea,
  salesOrg, salesOrgText, salesOrgDistributionChannel, salesOrgDivision,
} from './src/modules/foundation/schema';
import { configActivity } from './src/platform/tables/registry';
import {
  readWalkthroughCreditPrerequisiteSnapshot,
  walkthroughCreditPrerequisiteError,
} from './src/modules/finance/walkthrough-credit-preflight';
import { applyStandardStructureInTransaction } from './src/platform/tenancy/standard-structure';
import { applyStandardPackage, STANDARD_PACKAGE_VERSION } from './src/modules/foundation/standard-config';
import { recordChange } from './src/platform/change';
import { changeDocument, changeDocumentItem } from './src/platform/tables/audit-trail';
import { appUser, authOrgRestriction, role, userRole } from './src/platform/tables/security';
import {
  assertWalkthroughCheckpointActor, assertWalkthroughCheckpointRequest, assertWalkthroughDatabaseTarget,
  assertWalkthroughScopeSet, WALKTHROUGH_INSTALL_OBJECT_CLASS, WALKTHROUGH_INSTALL_OPERATION, WALKTHROUGH_INSTALL_REASON,
} from './src/platform/tenancy/walkthrough-install-guard';
import { assertFreshWalkthroughTenant } from './src/platform/tenancy/walkthrough-provisioning';
import { markActivityComplete } from './src/platform/tenancy';
import { provisionWalkthroughFirstAdminScopesInTransaction } from './src/modules/platform/organisation-scope-admin';
import { seedDevelopmentMaterials } from './src/modules/inventory/development-fixture';
import { getMaterialDetail, saveMaterialView } from './src/modules/inventory/materials';
import { getStorageLocationVersion, saveStorageLocation } from './src/modules/foundation/storage-location-maintenance';
import { initializeMaterialPeriodControl, getMaterialPeriodControl } from './src/modules/inventory/material-period-control';
import { derivePosition } from './src/platform/periods';
import { listNumberRanges, maintainNumberRange } from './src/modules/foundation/number-ranges';
import { saveBusinessPartner, getBusinessPartner } from './src/modules/foundation/business-partners';
import { saveCustomerCompany, getCustomerCompany } from './src/modules/foundation/customer-companies';
import { saveSupplierCompany, getSupplierCompany } from './src/modules/foundation/supplier-companies';
import { saveSupplierPurchasing, getSupplierPurchasing } from './src/modules/foundation/supplier-purchasing';
import { saveCustomerSalesArea, getCustomerSalesArea } from './src/modules/foundation/customer-sales-areas';
import { saveTaxCode, listTaxCodes } from './src/modules/foundation/tax-code-definition';
import { saveAccountDetermination, listAccountDeterminations } from './src/modules/foundation/account-determination';
import { assetClass, assetTransactionType, creditRiskCategory, journalEntryLine } from './src/modules/finance/schema';
import { getCustomerCredit, saveCustomerCredit } from './src/modules/finance/credit';
import { calculateSubledgerTie } from './src/modules/finance/subledger-tie-out';
import { reconcileStock } from './src/modules/inventory/stock-reconcile';
import { getOrder, createOrder } from './src/modules/purchasing/orders';
import { getDocumentRelease } from './src/modules/purchasing/release';
import { postGoodsReceipt } from './src/modules/inventory/goods-receipt';
import { postSupplierInvoice } from './src/modules/purchasing/invoice-verification';
import { createMaterialBom, getMaterialBom, listBomItemCategories, listBomUsages, saveBomItemCategory, saveBomUsage } from './src/modules/production/material-bom';
import { createRouting, getRouting, listRoutingConfiguration, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from './src/modules/production/routing';
import { createWorkCenter, getWorkCenter, listWorkCenterCategories, saveWorkCenterCategory } from './src/modules/production/work-center';
import { createProductionVersion, getProductionVersion } from './src/modules/production/production-version';
import { listProductionOrderTypes, saveProductionOrderType } from './src/modules/production/production-order-type';
import { listOrderTypeParameters, saveOrderTypeParameter } from './src/modules/production/order-type-parameters';
import { getProductionOrder, releaseProductionOrder } from './src/modules/inventory/production-orders';
import { planMaterials, getMrpRun } from './src/modules/production/mrp-run';
import { getPlannedOrder } from './src/modules/production/planned-order-display';
import { changePlannedOrder } from './src/modules/production/planned-order-change';
import { convertPlannedOrder } from './src/modules/production/planned-order-conversion';
import { postGoodsIssue } from './src/modules/inventory/goods-issue';
import { postProductionReceipt } from './src/modules/inventory/production-receipt';
import { listSalesConditions, saveSalesCondition } from './src/modules/sales/conditions';
import { createSalesOrder, getSalesOrder } from './src/modules/sales/sales-order';
import { confirmDeliveryPicks, createDelivery, getDelivery, postDeliveryGoodsIssue } from './src/modules/sales/delivery';
import { createBillingFromDelivery } from './src/modules/sales/billing';
import { postCustomerCreditMemo } from './src/modules/finance/customer-credit-memo';
import { getCustomerInvoice } from './src/modules/finance/customer-invoice';
import { getPayables, postOutgoingPayment } from './src/modules/finance/outgoing-payment';
import { getVendorClearing } from './src/modules/finance/vendor-clearing';
import { getReceivables, postIncomingPayment } from './src/modules/finance/incoming-payment';
import { clearCustomerItems, getCustomerClearing } from './src/modules/finance/customer-clearing';
import { getTransferDocument, postTransfer, reverseTransfer, transferStockAt } from './src/modules/inventory/transfer-posting';
import { runWalkthroughVolume } from './src/dev/walkthrough-volume';
import { runWalkthroughAssetProcurement } from './src/dev/walkthrough-asset';

const COMPANY = '1000';
const PLANT = '1000';
const STORAGE = '0001';
const TRANSFER_STORAGE = '0004';
const CHART = 'CA01';
const FYV = 'K4';
const PPV = 'C001';
const COUNTRY = 'AE';
const CURRENCY = 'AED';
const PURCHASING_ORG = '1000';
const PURCHASING_GROUP = '001';
const SALES_ORG = '1000';
const CHANNEL = '01';
const DIVISION = '01';
const CUSTOMER = 'C10000';
const SUPPLIER = 'S10000';
const MATERIALS = ['RAW-STEEL', 'PACK-CARTON', 'FG-BRACKET'] as const;
const VENDOR_TAX = 'V05';
/** The asset transaction type the walkthrough acquires with; the code the standard package carries. */
const ASSET_ACQUISITION_TYPE = 'ACQ';
let ACTOR = '';
const REQUEST_PREFIX = 'wk-walkthrough';
const OUT_OF_SCOPE = [
  'The volume phase adds masters, documents, quality inspection and HR master/time data. Payroll results and postings are not fabricated: pay components and their G/L mapping stand, but the amount paid comes from an imported payroll result or a future rule engine, and AE statutory logic is never guessed.',
  'Fixed-asset accounting is exercised once: one machine, bought on an asset-assigned order item and capitalized by the supplier invoice. Depreciation runs, asset transfers, revaluations, projects, and maintenance are not fabricated by this scenario.',
  'Automated payment runs, bank-statement ingestion/reconciliation and electronic bank interfaces are outside this walkthrough; individual AP/AR payments and customer open-item clearing are exercised.',
] as const;

export interface WalkthroughSummary {
  tenant: string;
  database: string;
  asOf: string;
  created: string[];
  skipped: string[];
  updated: number;
  failed: number;
  checks: Record<string, string>;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

interface WalkthroughAuth {
  origin: URL;
  cookieHeader: string;
  session: SessionContext;
}

/** Sign in through the application's ordinary HTTP endpoint and resolve its live, persisted cookie. */
async function authenticateWalkthroughUser(tenant: string): Promise<WalkthroughAuth> {
  const origin = new URL(required('CAIRN_SEED_ORIGIN'));
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('CAIRN_SEED_ORIGIN must be a plain http(s) application origin without credentials, path, query, or fragment.');
  }
  const username = required('CAIRN_SEED_USERNAME');
  const password = required('CAIRN_SEED_PASSWORD');
  let response: Response;
  try {
    response = await fetch(new URL('/api/auth/signin', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client: tenant, username, password, next: '/' }),
      redirect: 'manual',
    });
  } catch {
    throw new Error('Could not reach the application sign-in endpoint; verify CAIRN_SEED_ORIGIN and app readiness.');
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const firstCookie = setCookie.split(';', 1)[0]?.trim() ?? '';
  const cookieValue = firstCookie.startsWith(`${SESSION_COOKIE}=`)
    ? firstCookie.slice(SESSION_COOKIE.length + 1)
    : undefined;
  if (response.status < 300 || response.status >= 400 || !cookieValue) {
    throw new Error('Normal sign-in failed; verify the tenant, username, password, and that the user does not need a password reset.');
  }
  const parsed = parseSessionCookie(cookieValue);
  if (!parsed || parsed.client !== tenant) throw new Error('The application returned an invalid tenant session cookie.');
  const cookieHeader = `${SESSION_COOKIE}=${cookieValue}`;
  try {
    const session = await withTenant(tenant, (tx) => resolveSession(tx, { client: tenant, token: parsed.token }));
    if (!session || !session.sessionId || session.user.client !== tenant || session.user.mustChangePassword) {
      throw new Error('The sign-in cookie did not resolve to a live, usable session for this tenant.');
    }
    const requiredCapabilities = [
      'INV.GR.POST', 'INV.GI.POST', 'INV.TRANSFER.POST', 'PROD.MRP.RUN',
      'PROD.PLANNEDORDER.CHANGE', 'PROD.PLANNEDORDER.CONVERT', 'PROD.ORDER.CREATE', 'PROD.ORDER.RELEASE', 'PROD.ORDER.GR',
      'PROC.PO.CREATE', 'PROC.INV.RECORD', 'FIN.AP.PAYMENT.POST', 'FIN.AR.PAYMENT.ENTER', 'FIN.AR.CLEAR',
      'FIN.AR.CREDITMEMO.POST', 'SALES.ORDER.CREATE', 'SALES.DELIVERY.CREATE', 'SALES.DELIVERY.PICK',
      'SALES.BILLING.CREATE', 'SALES.GI.POST',
    ];
    const missing = requiredCapabilities.filter((capability) => !hasCapability(session.user.capabilities, capability));
    if (missing.length) {
      throw new Error(`Authenticated first administrator ${session.user.username} lacks required scenario capabilities: ${missing.join(', ')}.`);
    }
    // Fresh first admins intentionally have no organisation scopes yet. The trusted
    // provisioning transaction below grants only Company Code 1000 and Plant 1000;
    // the persisted records are re-read and audited before any business operation.
    return { origin, cookieHeader, session };
  } catch (error) {
    await revokeCookieSession(origin, cookieHeader).catch(() => undefined);
    throw error;
  }
}

async function revokeCookieSession(origin: URL, cookieHeader: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(new URL('/api/auth/signout', origin), {
      method: 'POST', headers: { cookie: cookieHeader }, redirect: 'manual',
    });
  } catch {
    throw new Error('The walkthrough ran, but the normal sign-out endpoint could not be reached to revoke its session.');
  }
  if (response.status < 300 || response.status >= 400) {
    throw new Error('The walkthrough ran, but the normal sign-out endpoint did not revoke its session.');
  }
}

async function signOutWalkthroughUser(auth: WalkthroughAuth): Promise<void> {
  await revokeCookieSession(auth.origin, auth.cookieHeader);
}

function moneyEqual(a: unknown, b: number, tolerance = 0.01): boolean {
  return Number.isFinite(Number(a)) && Math.abs(Number(a) - b) <= tolerance;
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateIsValid(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function record(summary: WalkthroughSummary, label: string, created: boolean) {
  (created ? summary.created : summary.skipped).push(label);
}

function summaryTotals(summary: WalkthroughSummary) {
  return { createdCount: summary.created.length, skippedCount: summary.skipped.length, updatedCount: summary.updated, failedCount: summary.failed };
}

function expectedMaterial(number: typeof MATERIALS[number]) {
  if (number === 'RAW-STEEL') return { description: 'Carbon steel sheet', group: 'RAW', unit: 'KG', type: 'RAW', procurement: 'BUY', priceControl: 'MOVING_AVERAGE', valuationClass: 'RAW_INVENTORY', price: 5 };
  if (number === 'PACK-CARTON') return { description: 'Shipping carton', group: 'PACKAGING', unit: 'PC', type: 'RAW', procurement: 'BUY', priceControl: 'MOVING_AVERAGE', valuationClass: 'RAW_INVENTORY', price: 2 };
  return { description: 'Manufactured bracket', group: 'PRODUCTS', unit: 'PC', type: 'FIN', procurement: 'MAKE', priceControl: 'STANDARD', valuationClass: 'FINISHED_INVENTORY', price: 100 };
}

async function partnerSubledgerLine(tenant: string, documentNumber: string, fiscalYear: number, partner: string, glAccount: string) {
  const lines = await withTenant(tenant, (tx) => tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
  }).from(journalEntryLine).where(and(
    eq(journalEntryLine.client, tenant), eq(journalEntryLine.documentNumber, documentNumber),
    eq(journalEntryLine.fiscalYear, fiscalYear), eq(journalEntryLine.businessPartner, partner),
    eq(journalEntryLine.companyCode, COMPANY), eq(journalEntryLine.glAccount, glAccount),
  )));
  if (lines.length !== 1) throw new Error(`Expected one ${partner} subledger line on journal ${documentNumber}; found ${lines.length}.`);
  return lines[0];
}

async function materialDocumentStatus(tenant: string, requestKey: string): Promise<string | null> {
  const rows = await withTenant(tenant, async (tx) => await tx.execute(sql`
    select status from material_document where client = ${tenant} and request_key = ${requestKey}
  `) as unknown as Array<{ status: string }>);
  return rows[0]?.status ?? null;
}

async function assertNoUnownedWalkthroughStock(tenant: string) {
  const [markers] = await withTenant(tenant, async (tx) => await tx.execute(sql`
    select
      (select count(*)::int from purchase_order where client = ${tenant} and created_by = ${ACTOR} and company_code = ${COMPANY}) as seed_orders,
      (select count(*)::int from material_document where client = ${tenant} and request_key like ${`${REQUEST_PREFIX}-${tenant.toLowerCase()}-%`}) as seed_material_documents
  `) as unknown as Array<{ seed_orders: number; seed_material_documents: number }>);
  if (Number(markers?.seed_orders ?? 0) > 0 || Number(markers?.seed_material_documents ?? 0) > 0) return;
  const [movement] = await withTenant(tenant, async (tx) => await tx.execute(sql`
    select
      (select count(*)::int from material_document_line where client = ${tenant} and material_number in ('RAW-STEEL','PACK-CARTON','FG-BRACKET')) as document_lines,
      (select count(*)::int from stock_quantity where client = ${tenant} and material_number in ('RAW-STEEL','PACK-CARTON','FG-BRACKET') and quantity <> 0) as stock_rows
  `) as unknown as Array<{ document_lines: number; stock_rows: number }>);
  if (Number(movement?.document_lines ?? 0) > 0 || Number(movement?.stock_rows ?? 0) > 0) {
    throw new Error('Walkthrough materials already carry stock or material-document history without this seed’s markers; use a fresh development tenant rather than consuming existing data.');
  }
}

async function ensureTaxAndAccounts(tenant: string, summary: WalkthroughSummary) {
  // The tax screen gates on the configuration workbench, and the workbench's activities
  // come from the global catalogue `npm run seed` writes. A tenant onboarded against a
  // database where that has not run inherits a partial catalogue with no company-code
  // activity in it, and the tax service then refuses with a step the operator has already
  // done. Say what is actually missing instead.
  const [companyCodeActivity] = await withTenant(tenant, (tx) => tx.select({ code: configActivity.code })
    .from(configActivity).where(eq(configActivity.code, 'CFG.ORG.COMPANYCODE.DEFINE')));
  if (!companyCodeActivity) {
    throw new Error('The configuration activity catalogue is missing CFG.ORG.COMPANYCODE.DEFINE. Initialize global reference data with "npm run seed" (scripts/seed.ts) before onboarding the tenant, then run the walkthrough against a fresh database.');
  }
  const codes = await listTaxCodes(tenant);
  const standingTax = codes.find((row) => row.country === COUNTRY && row.taxCode === VENDOR_TAX);
  if (standingTax) {
    if (standingTax.name !== 'UAE VAT 5%' || standingTax.taxType !== 'VAT' || !moneyEqual(standingTax.ratePercent, 5)) {
      throw new Error(`Tax code ${COUNTRY}/${VENDOR_TAX} exists with different values; refusing to change it.`);
    }
    record(summary, `tax code ${VENDOR_TAX}`, false);
  } else {
    await saveTaxCode({ client: tenant, changedBy: ACTOR, mode: 'CREATE', country: COUNTRY, taxCode: VENDOR_TAX,
      name: 'UAE VAT 5%', taxType: 'VAT', ratePercent: '5', accountKey: '', expectedRate: '',
      reason: 'Development walkthrough setup: UAE VAT demonstration.' });
    record(summary, `tax code ${VENDOR_TAX}`, true);
  }

  const determinationRows = [
    { event: 'INVENTORY', valuationClass: 'RAW_INVENTORY', generalModifier: '', glAccount: '120000' },
    { event: 'INVENTORY', valuationClass: 'FINISHED_INVENTORY', generalModifier: '', glAccount: '120200' },
    { event: 'GR_IR_CLEARING', valuationClass: '', generalModifier: '', glAccount: '210000' },
    { event: 'PRODUCTION_CONSUMPTION', valuationClass: 'RAW_INVENTORY', generalModifier: '', glAccount: '410000' },
    { event: 'PRODUCTION_OUTPUT', valuationClass: 'FINISHED_INVENTORY', generalModifier: '', glAccount: '410000' },
    { event: 'SALES_ISSUE', valuationClass: 'FINISHED_INVENTORY', generalModifier: '', glAccount: '400000' },
    { event: 'SALES_REVENUE', valuationClass: '', generalModifier: '', glAccount: '300000' },
    { event: 'TAX', valuationClass: '', generalModifier: '', glAccount: '220000' },
  ];
  const existing = await listAccountDeterminations(tenant);
  for (const desired of determinationRows) {
    const found = existing.find((row) => row.chartOfAccounts === CHART && row.event === desired.event &&
      row.valuationClass === desired.valuationClass && row.generalModifier === desired.generalModifier);
    if (found) {
      if (found.glAccount !== desired.glAccount) throw new Error(`Account determination ${desired.event}/${desired.valuationClass || 'blank'} points to ${found.glAccount}, expected ${desired.glAccount}; refusing to change it.`);
      record(summary, `account determination ${desired.event}/${desired.valuationClass || 'blank'}`, false);
    } else {
      await saveAccountDetermination({ client: tenant, changedBy: ACTOR, mode: 'CREATE', chartOfAccounts: CHART,
        ...desired, reason: 'Development walkthrough posting configuration.' });
      record(summary, `account determination ${desired.event}/${desired.valuationClass || 'blank'}`, true);
    }
  }
}

/**
 * Asset accounting needs two things configured before any value can be capitalized:
 * an active transaction type of kind ACQUISITION, and an active asset class carrying
 * the reconciliation account the acquisition is posted to. The standard package
 * carries both, so this normally finds them standing and only records the finding.
 *
 * It completes the tenant when the type is missing rather than letting the walkthrough
 * fail later at the invoice: a tenant that cannot capitalize an asset cannot show the
 * path at all, and leaving that to be configured by hand is the gap this closes. The
 * class is not invented — it is master data with accounts, depreciation keys and
 * useful lives, and a class guessed here would post to accounts nobody chose.
 */
async function ensureAssetAcquisitionConfiguration(
  tenant: string, summary: WalkthroughSummary,
): Promise<{ transactionType: string; assetClass: string; assetAccount: string }> {
  const types = await withTenant(tenant, (tx) => tx.select().from(assetTransactionType).where(and(
    eq(assetTransactionType.client, tenant), eq(assetTransactionType.kind, 'ACQUISITION'),
  )).orderBy(asc(assetTransactionType.typeCode)));
  const active = types.find((row) => row.isActive);
  let transactionType = active?.typeCode;
  if (!transactionType) {
    await withTenant(tenant, (tx) => tx.insert(assetTransactionType).values({
      client: tenant, typeCode: ASSET_ACQUISITION_TYPE, name: 'Acquisition with automatic offsetting',
      kind: 'ACQUISITION', isActive: true, createdBy: ACTOR,
    }));
    transactionType = ASSET_ACQUISITION_TYPE;
    record(summary, `asset transaction type ${transactionType}`, true);
  } else {
    record(summary, `asset transaction type ${transactionType}`, false);
  }

  const classes = await withTenant(tenant, (tx) => tx.select().from(assetClass).where(and(
    eq(assetClass.client, tenant), eq(assetClass.isActive, true),
  )).orderBy(asc(assetClass.assetClass)));
  const usable = classes.find((row) => row.reconAccount !== null && row.reconAccount.length > 0);
  if (!usable?.reconAccount) {
    throw new Error('No active asset class carries a reconciliation account; configure asset class account determination before running the walkthrough.');
  }
  record(summary, `asset class ${usable.assetClass} (${usable.reconAccount})`, false);
  return { transactionType, assetClass: usable.assetClass, assetAccount: usable.reconAccount };
}

async function ensurePartners(tenant: string, summary: WalkthroughSummary) {
  const partners = [
    { number: CUSTOMER, name: 'Walkthrough Customer LLC', role: 'CUSTOMER' as const, email: 'orders@walkthrough.example',
      reason: 'Development walkthrough customer.' },
    { number: SUPPLIER, name: 'Walkthrough Components LLC', role: 'SUPPLIER' as const, email: 'ap@walkthrough.example',
      reason: 'Development walkthrough supplier.' },
  ];
  for (const p of partners) {
    const existing = await getBusinessPartner(tenant, p.number);
    if (existing) {
      const g = existing.general;
      const hasRole = existing.roles.some((r) => r.roleCode === p.role && r.isActive);
      if (g.category !== 'ORGANIZATION' || g.name !== p.name || g.country !== COUNTRY || g.region !== 'Dubai' ||
          g.street !== 'Trade Centre' || g.city !== 'Dubai' || g.postalCode !== null || g.taxNumber !== null ||
          g.searchTerm !== p.number || g.name2 !== null || g.email !== p.email || g.phone !== null || g.isBlocked ||
          !hasRole || g.generalStatus === 'INCOMPLETE') {
        throw new Error(`Business partner ${p.number} exists with different or incomplete walkthrough values; refusing to change it.`);
      }
      record(summary, `business partner ${p.number}`, false);
    } else {
      await saveBusinessPartner({ client: tenant, partnerNumber: p.number, expectedVersion: 0, changedBy: ACTOR,
        reason: p.reason, category: 'ORGANIZATION', name: p.name, name2: '', searchTerm: p.number,
        country: COUNTRY, region: 'Dubai', street: 'Trade Centre', city: 'Dubai', postalCode: '', taxNumber: '',
        email: p.email, phone: '', roles: [p.role], isBlocked: false });
      record(summary, `business partner ${p.number}`, true);
    }
  }

  const cc = await getCustomerCompany(tenant, CUSTOMER, COMPANY);
  if (cc) {
    if (cc.chartOfAccounts !== CHART || cc.reconciliationAccount !== '110000' || cc.paymentTermsCode !== 'NET30' ||
        cc.paymentMethods !== null || cc.dunningProcedure !== null || cc.isBlocked || cc.companyStatus === 'INCOMPLETE') throw new Error('Customer company-code values differ from walkthrough defaults; refusing to change them.');
    record(summary, `customer company data ${CUSTOMER}/${COMPANY}`, false);
  } else {
    await saveCustomerCompany({ client: tenant, partnerNumber: CUSTOMER, companyCode: COMPANY, expectedVersion: 0,
      changedBy: ACTOR, reason: 'Development walkthrough customer company setup.', reconciliationAccount: '110000',
      paymentTermsCode: 'NET30', paymentMethods: '', dunningProcedure: '', isBlocked: false });
    record(summary, `customer company data ${CUSTOMER}/${COMPANY}`, true);
  }

  const sc = await getSupplierCompany(tenant, SUPPLIER, COMPANY);
  if (sc) {
    if (sc.chartOfAccounts !== CHART || sc.reconciliationAccount !== '200000' || sc.paymentTermsCode !== 'NET30' ||
        sc.paymentMethods !== null || sc.isBlocked || sc.companyStatus === 'INCOMPLETE') throw new Error('Supplier company-code values differ from walkthrough defaults; refusing to change them.');
    record(summary, `supplier company data ${SUPPLIER}/${COMPANY}`, false);
  } else {
    await saveSupplierCompany({ client: tenant, partnerNumber: SUPPLIER, companyCode: COMPANY, expectedVersion: 0,
      changedBy: ACTOR, reason: 'Development walkthrough supplier company setup.', reconciliationAccount: '200000',
      paymentTermsCode: 'NET30', paymentMethods: '', isBlocked: false });
    record(summary, `supplier company data ${SUPPLIER}/${COMPANY}`, true);
  }

  const purchasing = await getSupplierPurchasing(tenant, SUPPLIER, PURCHASING_ORG);
  if (purchasing) {
    if (purchasing.orderCurrency !== CURRENCY || purchasing.purchasingGroup !== PURCHASING_GROUP || purchasing.incotermsCode !== 'EXW' ||
        purchasing.incotermsLocation !== 'Dubai' || purchasing.paymentTermsCode !== 'NET30' || purchasing.isBlocked ||
        purchasing.purchasingStatus === 'INCOMPLETE') throw new Error('Supplier purchasing defaults differ from walkthrough values; refusing to change them.');
    record(summary, `supplier purchasing data ${SUPPLIER}/${PURCHASING_ORG}`, false);
  } else {
    await saveSupplierPurchasing({ client: tenant, partnerNumber: SUPPLIER, purchasingOrg: PURCHASING_ORG,
      expectedVersion: 0, changedBy: ACTOR, reason: 'Development walkthrough supplier purchasing setup.',
      orderCurrency: CURRENCY, purchasingGroup: PURCHASING_GROUP, incotermsCode: 'EXW',
      incotermsLocation: 'Dubai', paymentTermsCode: 'NET30', isBlocked: false });
    record(summary, `supplier purchasing data ${SUPPLIER}/${PURCHASING_ORG}`, true);
  }

  const salesArea = await getCustomerSalesArea(tenant, CUSTOMER, SALES_ORG, CHANNEL, DIVISION);
  if (salesArea) {
    if (salesArea.salesDistrict !== 'DXB' || salesArea.deliveringPlant !== PLANT || salesArea.pricingProcedure !== 'PR01' ||
        salesArea.completeDelivery || salesArea.orderCombination || salesArea.isBlocked || salesArea.salesStatus === 'INCOMPLETE') throw new Error('Customer sales-area values differ from walkthrough defaults; refusing to change them.');
    record(summary, `customer sales area ${CUSTOMER}/${SALES_ORG}/${CHANNEL}/${DIVISION}`, false);
  } else {
    await saveCustomerSalesArea({ client: tenant, partnerNumber: CUSTOMER, salesOrg: SALES_ORG,
      distributionChannel: CHANNEL, division: DIVISION, expectedVersion: 0, changedBy: ACTOR,
      reason: 'Development walkthrough customer sales setup.', salesDistrict: 'DXB', deliveringPlant: PLANT,
      pricingProcedure: 'PR01', accountAssignmentGroup: '001',
      completeDelivery: false, orderCombination: false, isBlocked: false });
    record(summary, `customer sales area ${CUSTOMER}/${SALES_ORG}/${CHANNEL}/${DIVISION}`, true);
  }

  const credit = await getCustomerCredit(tenant, CUSTOMER, '0001');
  if (credit) {
    if (!moneyEqual(credit.creditLimit, 100000) || credit.creditCurrency !== CURRENCY || credit.riskCategory !== 'A' ||
        credit.validTo !== null || credit.representativeGroup !== null || credit.customerCreditGroup !== null || credit.isBlocked) throw new Error('Customer credit settings differ from walkthrough defaults; refusing to change them.');
    record(summary, `customer credit ${CUSTOMER}/0001`, false);
  } else {
    await saveCustomerCredit({ client: tenant, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: '0001',
      creditLimit: '100000', riskCategory: 'A', isBlocked: false,
      changeReason: 'Development walkthrough credit setup.' });
    record(summary, `customer credit ${CUSTOMER}/0001`, true);
  }
}

async function ensureFiNumberRange(tenant: string, summary: WalkthroughSummary) {
  const ranges = (await listNumberRanges(tenant)).ranges;
  const existing = ranges.find((r) => r.objectCode === 'RF_BELEG' && r.companyCode === COMPANY && r.subObject === 'GENERAL' && r.fiscalYear === 0);
  if (existing) {
    if (existing.prefix !== 'JE' || existing.fromNumber !== 1 || existing.toNumber !== 999999 || existing.numberLength !== 6 || existing.displayStyle !== 'READABLE' || existing.status !== 'ACTIVE') {
      throw new Error('The RF_BELEG/1000/GENERAL/0 interval exists with different bounds or status; refusing to change it.');
    }
    record(summary, 'FI journal number range RF_BELEG/1000/GENERAL/0', false);
  } else {
    await maintainNumberRange({ client: tenant, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL', fiscalYear: 0,
      prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE',
      mode: 'CREATE', changedBy: ACTOR, reason: 'Development walkthrough FI document numbering.' });
    record(summary, 'FI journal number range RF_BELEG/1000/GENERAL/0', true);
  }
}

async function ensureProductionMasters(tenant: string, date: string, summary: WalkthroughSummary) {
  const bomUsages = await listBomUsages(tenant);
  const usage = bomUsages.find((row) => row.usage === 'P');
  if (usage) {
    if (usage.description !== 'Production' || usage.productionRelevance !== '.' || usage.engineeringRelevance !== '.' ||
        usage.costingRelevance !== '.' || usage.salesRelevance !== '.') throw new Error('BOM usage P is not the walkthrough production usage; refusing to change it.');
    record(summary, 'BOM usage P', false);
  } else {
    await saveBomUsage({ client: tenant, changedBy: ACTOR, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
    record(summary, 'BOM usage P', true);
  }
  const categories = await listBomItemCategories(tenant);
  const category = categories.find((row) => row.category === 'S');
  if (category) {
    if (category.description !== 'Stock' || category.materialEntry !== '+' || category.quantityEntry !== '+' ||
        category.allowFixedQuantity !== 'X' || category.allowBulk !== 'X' || category.allowPhantom !== 'X' ||
        category.allowCoproduct !== 'X' || category.allowFollowUp !== 'X' || category.allowSpecialProcurement !== 'X' || category.allowNegativeQuantity !== ' ') {
      throw new Error('BOM item category S exists with different entry rules; refusing to change it.');
    }
    record(summary, 'BOM item category S', false);
  } else {
    await saveBomItemCategory({ client: tenant, changedBy: ACTOR, category: 'S', description: 'Stock',
      materialEntry: '+', quantityEntry: '+', allowFixedQuantity: 'X', allowBulk: 'X', allowPhantom: 'X',
      allowCoproduct: 'X', allowFollowUp: 'X', allowSpecialProcurement: 'X', allowNegativeQuantity: ' ' });
    record(summary, 'BOM item category S', true);
  }

  const routingConfig = await listRoutingConfiguration(tenant);
  const taskListType = routingConfig.types.find((row) => row.taskListType === 'N');
  if (taskListType) {
    if (taskListType.description !== 'Routing' || taskListType.requireControlKey !== ' ') throw new Error('Routing task-list type N has different settings; refusing to change it.');
    record(summary, 'routing task-list type N', false);
  } else {
    await saveRoutingTaskListType({ client: tenant, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
    record(summary, 'routing task-list type N', true);
  }
  const routingUsage = routingConfig.usages.find((row) => row.usage === '1');
  if (routingUsage) {
    if (routingUsage.description !== 'Production') throw new Error('Routing usage 1 has a different description; refusing to change it.');
    record(summary, 'routing usage 1', false);
  } else {
    await saveRoutingUsage({ client: tenant, changedBy: ACTOR, usage: '1', description: 'Production' });
    record(summary, 'routing usage 1', true);
  }
  const controlKey = routingConfig.controlKeys.find((row) => row.controlKey === 'PP01');
  if (controlKey) {
    if (controlKey.description !== 'Internal processing' || controlKey.scheduling !== ' ' || controlKey.costing !== ' ' || controlKey.confirmation !== ' ' || controlKey.externalProcessing !== ' ' || controlKey.requireWorkCenter !== ' ') {
      throw new Error('Routing control key PP01 has different settings; refusing to change it.');
    }
    record(summary, 'routing control key PP01', false);
  } else {
    await saveRoutingControlKey({ client: tenant, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal processing' });
    record(summary, 'routing control key PP01', true);
  }

  const wcCategories = await listWorkCenterCategories(tenant);
  const wcCategory = wcCategories.find((row) => row.category === 'MACH');
  if (wcCategory) {
    if (wcCategory.description !== 'Machine' || wcCategory.requireCapacity || wcCategory.requireScheduling || wcCategory.requireCosting || wcCategory.requireStandardValueKey) {
      throw new Error('Work-center category MACH has different settings; refusing to change it.');
    }
    record(summary, 'work-center category MACH', false);
  } else {
    await saveWorkCenterCategory({ client: tenant, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
    record(summary, 'work-center category MACH', true);
  }
  const workCenter = await getWorkCenter(tenant, PLANT, 'WC01');
  if (workCenter) {
    if (workCenter.description !== 'Walkthrough Assembly' || workCenter.category !== 'MACH') throw new Error('Work center 1000/WC01 exists with different values; refusing to change it.');
    record(summary, 'work center 1000/WC01', false);
  } else {
    await createWorkCenter({ client: tenant, changedBy: ACTOR, plant: PLANT, workCenter: 'WC01', category: 'MACH', description: 'Walkthrough Assembly' });
    record(summary, 'work center 1000/WC01', true);
  }

  const routing = await getRouting(tenant, 'N', '50000051', '01', date);
  if (routing) {
    if (routing.plant !== PLANT || routing.usage !== '1' || !moneyEqual(routing.baseQuantity, 1, 0.0005) || routing.baseUnit !== 'PC' || routing.validFrom !== date ||
        routing.assignments.length !== 1 || routing.assignments[0].materialNumber !== 'FG-BRACKET' || routing.operations.length !== 1 ||
        routing.operations[0].operationNumber !== '0010' || routing.operations[0].shortText !== 'Assemble bracket' ||
        routing.operations[0].workCenter !== 'WC01' || routing.operations[0].controlKey !== 'PP01') {
      throw new Error('Routing 50000051/01 differs from the walkthrough routing; refusing to change it.');
    }
    record(summary, 'routing 50000051/01', false);
  } else {
    await createRouting({ client: tenant, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
      routingGroup: '50000051', groupCounter: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: date,
      assignments: [{ materialNumber: 'FG-BRACKET' }],
      operations: [{ operationNumber: '0010', shortText: 'Assemble bracket', workCenter: 'WC01', controlKey: 'PP01' }] });
    record(summary, 'routing 50000051/01', true);
  }

  const existingBom = await getMaterialBom(tenant, 'FG-BRACKET', PLANT, 'P', '01');
  if (existingBom) {
    const expected = new Map([['RAW-STEEL', { quantity: 19.6, unit: 'KG' }], ['PACK-CARTON', { quantity: 1, unit: 'PC' }]]);
    if (existingBom.baseUnit !== 'PC' || existingBom.items.length !== 2 || existingBom.items.some((item) => {
      const value = expected.get(item.componentMaterial ?? '');
      return !value || item.itemCategory !== 'S' || item.unit !== value.unit || !moneyEqual(item.quantity, value.quantity, 0.0005);
    })) {
      throw new Error('Production BOM for FG-BRACKET differs from the walkthrough recipe; refusing to change it.');
    }
    record(summary, 'production BOM FG-BRACKET/P/01', false);
  } else {
    await createMaterialBom({ client: tenant, changedBy: ACTOR, materialNumber: 'FG-BRACKET', plant: PLANT, usage: 'P', alternative: '01',
      baseQuantity: '1', baseUnit: 'PC', validFrom: date,
      items: [
        { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'RAW-STEEL', quantity: '19.6', unit: 'KG', validFrom: date },
        { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'PACK-CARTON', quantity: '1', unit: 'PC', validFrom: date },
      ] });
    record(summary, 'production BOM FG-BRACKET/P/01', true);
  }

  const productionTypes = await listProductionOrderTypes(tenant);
  const prodType = productionTypes.types.find((row) => row.orderType === 'PP01');
  if (prodType) {
    if (prodType.description !== 'Walkthrough production' || prodType.orderCategory !== '10') throw new Error('Production order type PP01 exists with different values; refusing to change it.');
    record(summary, 'production order type PP01', false);
  } else {
    await saveProductionOrderType({ client: tenant, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Walkthrough production', version: 0, reason: 'Development walkthrough production setup.' });
    record(summary, 'production order type PP01', true);
  }

  const parameters = await listOrderTypeParameters(tenant);
  const orderTypeParameters = parameters.parameters.find((row) => row.plant === PLANT && row.orderType === 'PP01');
  if (orderTypeParameters) {
    if (orderTypeParameters.orderCategory !== '10' || orderTypeParameters.taskListType !== 'N' || orderTypeParameters.productionVersionSelection !== '0') {
      throw new Error('Order-type parameters for plant 1000/PP01 differ from the walkthrough selection; refusing to change them.');
    }
    record(summary, 'order-type parameters 1000/PP01', false);
  } else {
    await saveOrderTypeParameter({ client: tenant, changedBy: ACTOR, mode: 'CREATE', plant: PLANT,
      orderType: 'PP01', taskListType: 'N', productionVersionSelection: '0', version: 0,
      reason: 'Development walkthrough production-version selection.' });
    record(summary, 'order-type parameters 1000/PP01', true);
  }

  const version = await getProductionVersion(tenant, 'FG-BRACKET', PLANT, '0001');
  if (version) {
    if (version.description !== 'Walkthrough bracket build' || version.validFrom !== date || !moneyEqual(version.lotFrom, 0, 0.0005) || !moneyEqual(version.lotTo, 999999, 0.0005) ||
        version.bomUsage !== 'P' || version.bomAlternative !== '01' || version.routingGroup !== '50000051' ||
        version.groupCounter !== '01' || version.lotUnit !== 'PC' || version.receivingStorageLocation !== STORAGE) {
      throw new Error('Production version FG-BRACKET/0001 differs from the walkthrough version; refusing to change it.');
    }
    record(summary, 'production version FG-BRACKET/0001', false);
  } else {
    await createProductionVersion({ client: tenant, changedBy: ACTOR, materialNumber: 'FG-BRACKET', plant: PLANT,
      productionVersion: '0001', description: 'Walkthrough bracket build', validFrom: date, lotFrom: '0', lotTo: '999999',
      lotUnit: 'PC', bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '50000051', groupCounter: '01',
      receivingStorageLocation: STORAGE, requestKey: `${REQUEST_PREFIX}-${tenant.toLowerCase()}-pv` });
    record(summary, 'production version FG-BRACKET/0001', true);
  }
}

async function ensureMrpSafetyStock(tenant: string, summary: WalkthroughSummary) {
  const detail = await getMaterialDetail(tenant, 'FG-BRACKET');
  const view = detail?.plants.find((row) => row.plant === PLANT);
  if (!detail || !view || view.mrpStatus === 'INCOMPLETE' || view.mrpType !== 'REQUIREMENTS' || view.procurementType !== 'MAKE' ||
      (view.lotSizing !== 'EXACT' && view.lotSizing !== 'FIXED')) {
    throw new Error('FG-BRACKET has no complete requirements-planning MRP view for made procurement.');
  }
  if (moneyEqual(view.safetyStock, 5, 0.0005)) {
    record(summary, 'MRP safety stock FG-BRACKET/1000 = 5 PC', false);
    return;
  }
  if (!moneyEqual(view.safetyStock, 0, 0.0005)) {
    throw new Error(`FG-BRACKET safety stock is ${view.safetyStock}, not the expected 0 or 5; refusing to overwrite the MRP view.`);
  }
  const saved = await saveMaterialView({
    client: tenant, changedBy: ACTOR, expectedVersion: view.version, view: 'MRP',
    materialNumber: 'FG-BRACKET', plant: PLANT, mrpType: view.mrpType,
    mrpController: view.mrpController ?? '001', procurementType: view.procurementType,
    lotSizing: view.lotSizing, fixedLotSize: view.fixedLotSize, minimumLotSize: view.minimumLotSize,
    maximumLotSize: view.maximumLotSize, safetyStock: '5', reorderPoint: view.reorderPoint,
    plannedDeliveryDays: view.plannedDeliveryDays, inHouseProductionDays: view.inHouseProductionDays,
    backflush: view.backflush, automaticGoodsReceipt: view.automaticGoodsReceipt,
    reason: 'Development walkthrough MRP safety-stock requirement.',
  });
  if (!saved.changed) throw new Error('The MRP safety-stock change was not applied.');
  const confirmed = await getMaterialDetail(tenant, 'FG-BRACKET');
  if (!confirmed?.plants.some((row) => row.plant === PLANT && moneyEqual(row.safetyStock, 5, 0.0005))) {
    throw new Error('The FG-BRACKET MRP safety stock did not read back as 5 PC after the supported material-view save.');
  }
  record(summary, 'MRP safety stock FG-BRACKET/1000 = 5 PC', true);
}

async function ensureTransferStorageLocation(tenant: string, summary: WalkthroughSummary) {
  const [standing] = await withTenant(tenant, (tx) => tx.select().from(storageLocationTable).where(and(
    eq(storageLocationTable.client, tenant), eq(storageLocationTable.plant, PLANT),
    eq(storageLocationTable.storageLocation, TRANSFER_STORAGE),
  )));
  if (standing) {
    if (standing.name !== 'Walkthrough Transfer Bin' || standing.allowNegativeStock || !standing.isActive) {
      throw new Error(`Storage location ${PLANT}/${TRANSFER_STORAGE} exists with different values; refusing to change it.`);
    }
    record(summary, `storage location ${PLANT}/${TRANSFER_STORAGE}`, false);
    return;
  }
  const version = await getStorageLocationVersion(tenant, PLANT, TRANSFER_STORAGE);
  if (version !== 0) throw new Error(`Storage location ${PLANT}/${TRANSFER_STORAGE} has audit history without a standing row; refusing to recreate it.`);
  await saveStorageLocation({ client: tenant, changedBy: ACTOR, mode: 'CREATE', plant: PLANT,
    storageLocation: TRANSFER_STORAGE, expectedVersion: 0,
    reason: 'Development walkthrough internal transfer destination.',
    values: { name: 'Walkthrough Transfer Bin', allowNegativeStock: false } });
  record(summary, `storage location ${PLANT}/${TRANSFER_STORAGE}`, true);
}

async function ensureSalesPrice(tenant: string, date: string, summary: WalkthroughSummary) {
  // Price maintenance has a derived business key. A matching existing price is a no-op;
  // any other overlap is refused, never silently superseded.
  const from = date;
  const to = addDays(date, 30);
  const standing = await listSalesConditions(tenant, { customerNumber: CUSTOMER, materialNumber: 'FG-BRACKET' });
  const same = standing.find((row) => row.validityFrom === from);
  if (same) {
    if (same.salesOrg !== SALES_ORG || same.distributionChannel !== CHANNEL || same.division !== DIVISION ||
        same.currency !== CURRENCY || !moneyEqual(same.amount, 160) || same.priceUnit !== 1 || same.validityTo !== to) {
      throw new Error(`Sales condition ${same.conditionNumber} exists with different values; refusing to change it.`);
    }
    record(summary, `sales price ${CUSTOMER}/FG-BRACKET`, false);
    return;
  }
  await saveSalesCondition({ client: tenant, changedBy: ACTOR, salesOrg: SALES_ORG, distributionChannel: CHANNEL,
    division: DIVISION, customerNumber: CUSTOMER, materialNumber: 'FG-BRACKET', currency: CURRENCY,
    amount: 160, priceUnit: 1, validityFrom: from, validityTo: to, supersedeStanding: false });
  record(summary, `sales price ${CUSTOMER}/FG-BRACKET`, true);
}

async function ensureCreditRiskCategory(tenant: string, summary: WalkthroughSummary) {
  const rows = await withTenant(tenant, (tx) => tx.select().from(creditRiskCategory).where(and(
    eq(creditRiskCategory.client, tenant), eq(creditRiskCategory.riskCategory, 'A'))));
  if (rows.length) {
    if (rows[0].name !== 'Low risk' || !rows[0].isActive) throw new Error('Credit risk category A is customized or inactive; refusing to change it.');
    record(summary, 'credit risk category A', false);
  } else {
    await withTenant(tenant, async (tx) => { await tx.insert(creditRiskCategory).values({ client: tenant, riskCategory: 'A', name: 'Low risk', createdBy: ACTOR }).onConflictDoNothing(); });
    const confirmed = await withTenant(tenant, (tx) => tx.select().from(creditRiskCategory).where(and(
      eq(creditRiskCategory.client, tenant), eq(creditRiskCategory.riskCategory, 'A'))));
    if (!confirmed[0]?.isActive || confirmed[0]?.name !== 'Low risk') throw new Error('Credit risk category A could not be confirmed after creation.');
    record(summary, 'credit risk category A', true);
  }
}

async function runChecks(tenant: string, fiscalYear: number, summary: WalkthroughSummary) {
  const stock = await reconcileStock(tenant, { plant: PLANT });
  if (!stock.balanced) throw new Error(`Stock ledger/projection mismatch: ${JSON.stringify(stock.drift)}`);
  summary.checks.stockReconciliation = `${stock.dimensionsChecked} dimensions, no drift`;

  const tie = await calculateSubledgerTie({ client: tenant, selection: { companyCode: COMPANY, fiscalYear, periodTo: 12, ledger: '0L' } });
  const customer = tie.rows.find((row) => row.kind === 'ACCOUNT' && row.accountNumber === '110000');
  const supplier = tie.rows.find((row) => row.kind === 'ACCOUNT' && row.accountNumber === '200000');
  if (!customer || customer.status !== 'TIED' || !moneyEqual(customer.difference, 0) || !supplier || supplier.status !== 'TIED' || !moneyEqual(supplier.difference, 0) || tie.partnerlessLines !== 0) {
    throw new Error(`Customer/vendor subledger reconciliation failed: ${JSON.stringify({ customer, supplier, partnerlessLines: tie.partnerlessLines })}`);
  }
  summary.checks.subledger = `customer 110000 and vendor 200000 tied; ${tie.partnerlessLines} partnerless reconciliation lines`;

  const stockValueRows = await withTenant(tenant, async (tx) => await tx.execute(sql`
    select v.material_number,
           v.total_stock_quantity::text as valuation_quantity,
           coalesce(sum(s.quantity), 0)::text as projected_quantity,
           v.stock_value::text as stock_value,
           (v.total_stock_quantity * case when v.price_control = 'STANDARD' then v.standard_price else v.moving_average_price end / v.price_unit)::text as expected_value,
           v.valuation_class
      from material_valuation v
      left join stock_quantity s on s.client = v.client and s.material_number = v.material_number and s.plant = v.valuation_area
     where v.client = ${tenant} and v.valuation_area = ${PLANT}
       and v.material_number in (${sql.join(MATERIALS.map((materialNumber) => sql`${materialNumber}`), sql`, `)})
     group by v.material_number, v.total_stock_quantity, v.stock_value, v.price_control, v.standard_price, v.moving_average_price, v.price_unit, v.valuation_class
     order by v.material_number
  `) as unknown as Array<{ material_number: string; valuation_quantity: string; projected_quantity: string; stock_value: string; expected_value: string; valuation_class: string }>);
  const expectedClosingStock = new Map([['RAW-STEEL', 2], ['PACK-CARTON', 45], ['FG-BRACKET', 0]]);
  if (stockValueRows.length !== MATERIALS.length || stockValueRows.some((r) =>
    !moneyEqual(r.valuation_quantity, Number(r.projected_quantity), 0.0005) ||
    !moneyEqual(r.stock_value, Number(r.expected_value), 0.02) ||
    !moneyEqual(r.projected_quantity, expectedClosingStock.get(r.material_number) ?? Number.NaN, 0.0005))) {
    throw new Error(`Material quantity/valuation check failed: ${JSON.stringify(stockValueRows)}`);
  }
  summary.checks.stockValuation = `${stockValueRows.length} materials: closing quantities RAW-STEEL 2 KG / PACK-CARTON 45 PC / FG-BRACKET 0 PC and book values match`;

  const inventoryTieRows = await withTenant(tenant, async (tx) => await tx.execute(sql`
    with stock as (
      select valuation_class, sum(stock_value)::text as stock_value
        from material_valuation where client = ${tenant} and valuation_area = ${PLANT}
         and valuation_class in ('RAW_INVENTORY','FINISHED_INVENTORY')
       group by valuation_class
    ), gl as (
      select gl_account, sum(case when debit_credit = 'S' then amount_local else -amount_local end)::text as balance
        from journal_entry_line where client = ${tenant} and company_code = ${COMPANY}
       group by gl_account
    )
    select d.valuation_class, d.gl_account, coalesce(s.stock_value, '0') as stock_value,
           coalesce(g.balance, '0') as gl_balance
      from account_determination d
      left join stock s on s.valuation_class = d.valuation_class
      left join gl g on g.gl_account = d.gl_account
     where d.client = ${tenant} and d.chart_of_accounts = ${CHART} and d.event = 'INVENTORY'
       and d.valuation_class in ('RAW_INVENTORY','FINISHED_INVENTORY')
     order by d.valuation_class
  `) as unknown as Array<{ valuation_class: string; gl_account: string; stock_value: string; gl_balance: string }>);
  if (inventoryTieRows.length !== 2 || inventoryTieRows.some((row) => !moneyEqual(row.stock_value, Number(row.gl_balance), 0.02))) {
    throw new Error(`Inventory subledger-to-G/L reconciliation failed: ${JSON.stringify(inventoryTieRows)}`);
  }
  summary.checks.inventoryGl = inventoryTieRows.map((row) => `${row.valuation_class} ${row.gl_account}=${row.gl_balance}`).join('; ');

  const journalRows = await withTenant(tenant, async (tx) => await tx.execute(sql`
    select count(*)::int as unbalanced from (
      select l.document_number, l.fiscal_year
        from journal_entry_line l join journal_entry e
          on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
       where l.client = ${tenant} and e.company_code = ${COMPANY} and e.status = 'POSTED'
       group by l.document_number, l.fiscal_year
      having abs(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)) > 0.01
    ) bad
  `) as unknown as Array<{ unbalanced: number }>);
  if (Number(journalRows[0]?.unbalanced ?? 0) !== 0) throw new Error(`${journalRows[0]?.unbalanced ?? 0} posted journal documents are out of balance.`);
  summary.checks.accounting = 'all posted company-code journal documents balance';

  const grirRows = await withTenant(tenant, async (tx) => await tx.execute(sql`
    select coalesce(sum(case when debit_credit = 'S' then amount_local else -amount_local end), 0)::text as balance
      from journal_entry_line where client = ${tenant} and company_code = ${COMPANY} and gl_account = '210000'
  `) as unknown as Array<{ balance: string }>);
  if (!moneyEqual(grirRows[0]?.balance, 0)) throw new Error(`GR/IR account 210000 remains ${grirRows[0]?.balance ?? 'unknown'}; invoice verification did not clear the receipt.`);
  summary.checks.grir = 'GR/IR 210000 is zero after supplier invoice verification';
}

/** Read-only credit configuration gate, before the first business-setup write. */
async function preflightCreditConfiguration(tenant: string, summary: WalkthroughSummary) {
  const { company, area } = await readWalkthroughCreditPrerequisiteSnapshot(tenant, COMPANY, '0001');
  const error = walkthroughCreditPrerequisiteError({
    company,
    area,
    companyCode: COMPANY,
    areaCode: '0001',
    expectedCurrency: CURRENCY,
  });
  if (error) throw new Error(error);
  summary.checks.creditControlArea = company
    ? `active CCA 0001 in ${CURRENCY}; company code ${COMPANY} is mapped to it`
    : `standard structure will create CCA 0001 in ${CURRENCY} and map new company code ${COMPANY}`;
}

type WalkthroughCheckpointState = 'PROVISIONED' | 'COMPLETE';
interface WalkthroughCheckpoint {
  operation: string;
  state: WalkthroughCheckpointState;
  client: string;
  database: string;
  asOf: string;
  actorUserId: string;
  username: string;
  companyScopeId: string;
  plantScopeId: string;
}

function installationCorrelationId(tenant: string) {
  return `${WALKTHROUGH_INSTALL_OPERATION}:${tenant}`;
}

function installationObjectKey(tenant: string) {
  return `${tenant}:${WALKTHROUGH_INSTALL_OPERATION}`;
}

async function readWalkthroughCheckpoint(tenant: string): Promise<WalkthroughCheckpoint | null> {
  return withTenant(tenant, async (tx) => {
    const documents = await tx.select().from(changeDocument).where(and(
      eq(changeDocument.client, tenant),
      eq(changeDocument.objectClass, WALKTHROUGH_INSTALL_OBJECT_CLASS),
      eq(changeDocument.objectKey, installationObjectKey(tenant)),
    )).orderBy(asc(changeDocument.changedAt)).limit(3);
    if (documents.length === 0) return null;
    if (documents.length > 2 || documents[0]?.changeType !== 'CREATE' ||
        (documents[1] && documents[1].changeType !== 'CHANGE')) {
      throw new Error('Walkthrough installation checkpoint history is ambiguous or malformed; refusing recovery.');
    }
    const snapshot: Record<string, string> = {};
    for (const document of documents) {
      const items = await tx.select().from(changeDocumentItem).where(and(
        eq(changeDocumentItem.client, tenant), eq(changeDocumentItem.changeDocumentId, document.id),
      ));
      for (const item of items) {
        if (item.newValue === null) delete snapshot[item.fieldName];
        else snapshot[item.fieldName] = item.newValue;
      }
    }
    const checkpoint = snapshot as unknown as WalkthroughCheckpoint;
    if (!['PROVISIONED', 'COMPLETE'].includes(checkpoint.state) || checkpoint.operation !== WALKTHROUGH_INSTALL_OPERATION ||
        checkpoint.client !== tenant || !checkpoint.database || !checkpoint.asOf || !checkpoint.actorUserId ||
        !checkpoint.username || !checkpoint.companyScopeId || !checkpoint.plantScopeId) {
      throw new Error('Walkthrough installation checkpoint is incomplete; refusing to guess whether setup can be resumed.');
    }
    if (documents.length === 1 && checkpoint.state !== 'PROVISIONED') {
      throw new Error('Walkthrough installation checkpoint has an invalid initial state.');
    }
    if (documents.length === 2 && checkpoint.state !== 'COMPLETE') {
      throw new Error('Walkthrough installation checkpoint transition is incomplete or out of order.');
    }
    for (const document of documents) {
      if (document.changedBy !== checkpoint.username || document.reason !== WALKTHROUGH_INSTALL_REASON ||
          document.correlationId !== installationCorrelationId(tenant)) {
        throw new Error('Walkthrough installation checkpoint audit provenance is inconsistent; refusing recovery.');
      }
    }
    return checkpoint;
  });
}

async function assertWalkthroughScopes(tenant: string, auth: WalkthroughAuth, checkpoint: WalkthroughCheckpoint): Promise<void> {
  assertWalkthroughCheckpointActor(checkpoint, { userId: auth.session.user.userId, username: auth.session.user.username });
  const firstAdminStillEligible = await withTenant(tenant, async (tx) => {
    const users = await tx.select({ id: appUser.id, username: appUser.username, isActive: appUser.isActive, isLocked: appUser.isLocked, mustChangePassword: appUser.mustChangePassword })
      .from(appUser).where(eq(appUser.client, tenant));
    const assignments = await tx.select({ userId: userRole.userId, roleCode: userRole.roleCode }).from(userRole).where(eq(userRole.client, tenant));
    const [administratorRole] = await tx.select({ isActive: role.isActive, isSystemRole: role.isSystemRole }).from(role)
      .where(and(eq(role.client, tenant), eq(role.code, 'ADMINISTRATOR')));
    return users.length === 1 && users[0]?.id === checkpoint.actorUserId && users[0]?.username === checkpoint.username &&
      users[0]?.isActive && !users[0]?.isLocked && !users[0]?.mustChangePassword && assignments.length === 1 &&
      assignments[0]?.userId === checkpoint.actorUserId && assignments[0]?.roleCode === 'ADMINISTRATOR' &&
      administratorRole?.isActive && administratorRole.isSystemRole;
  });
  if (!firstAdminStillEligible) throw new Error('The checkpoint no longer has the sole eligible first administrator with only the initial ADMINISTRATOR role.');
  const rows = await withTenant(tenant, async (tx) => await tx.select().from(authOrgRestriction)
    .where(eq(authOrgRestriction.client, tenant)));
  assertWalkthroughScopeSet(rows, checkpoint.actorUserId, checkpoint.username, checkpoint.companyScopeId, checkpoint.plantScopeId);
  const auditIsValid = await withTenant(tenant, async (tx) => {
    for (const row of rows) {
      const docs = await tx.select().from(changeDocument).where(and(
        eq(changeDocument.client, tenant),
        eq(changeDocument.objectClass, 'auth_org_restriction'),
        eq(changeDocument.objectKey, row.id),
      ));
      if (!docs.some((doc) => doc.changedBy === checkpoint.username && doc.reason === WALKTHROUGH_INSTALL_REASON &&
          doc.correlationId === installationCorrelationId(tenant) && doc.changeType === 'CREATE')) return false;
    }
    return true;
  });
  if (!auditIsValid) throw new Error('The Company/Plant grant is missing its expected domain change audit; refusing to continue.');
  const restrictions = await withTenant(tenant, (tx) => loadOrgRestrictions(tx, tenant, checkpoint.actorUserId));
  const companyGranted = restrictions.some((row) => row.scopeType === 'COMPANY_CODE' && row.scopeValue.trim() === COMPANY);
  const plantGranted = restrictions.some((row) => row.scopeType === 'PLANT' && row.scopeValue.trim() === PLANT);
  if (!companyGranted || !plantGranted) throw new Error('The authenticated first administrator does not resolve to both required persisted scopes.');
}

async function assertStandardWalkthroughStructure(tx: Tx, tenant: string): Promise<void> {
  const [company] = await tx.select().from(companyCode).where(and(
    eq(companyCode.client, tenant), eq(companyCode.companyCode, COMPANY),
  ));
  const [cca] = await tx.select().from(creditControlArea).where(and(
    eq(creditControlArea.client, tenant), eq(creditControlArea.creditControlArea, '0001'),
  ));
  const [area] = await tx.select().from(controllingArea).where(and(
    eq(controllingArea.client, tenant), eq(controllingArea.controllingArea, 'A000'),
  ));
  const controllingLinks = await tx.select().from(controllingAreaCompany).where(and(
    eq(controllingAreaCompany.client, tenant), eq(controllingAreaCompany.controllingArea, 'A000'), eq(controllingAreaCompany.companyCode, COMPANY),
  ));
  const [mainPlant] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, tenant), eq(plantTable.plant, PLANT),
  ));
  const locations = await tx.select().from(storageLocationTable).where(and(
    eq(storageLocationTable.client, tenant), eq(storageLocationTable.plant, PLANT),
  ));
  const [purchasing] = await tx.select().from(purchasingOrg).where(and(
    eq(purchasingOrg.client, tenant), eq(purchasingOrg.purchasingOrg, '1000'),
  ));
  const purchasingLinks = await tx.select().from(purchasingOrgPlant).where(and(
    eq(purchasingOrgPlant.client, tenant), eq(purchasingOrgPlant.purchasingOrg, '1000'), eq(purchasingOrgPlant.plant, PLANT),
  ));
  const [sales] = await tx.select().from(salesOrg).where(and(
    eq(salesOrg.client, tenant), eq(salesOrg.salesOrg, '1000'),
  ));
  const salesTexts = await tx.select().from(salesOrgText).where(and(
    eq(salesOrgText.client, tenant), eq(salesOrgText.salesOrg, '1000'), eq(salesOrgText.languageKey, 'E'),
  ));
  const channelLinks = await tx.select().from(salesOrgDistributionChannel).where(and(
    eq(salesOrgDistributionChannel.client, tenant), eq(salesOrgDistributionChannel.salesOrg, '1000'), eq(salesOrgDistributionChannel.distributionChannel, '01'),
  ));
  const divisionLinks = await tx.select().from(salesOrgDivision).where(and(
    eq(salesOrgDivision.client, tenant), eq(salesOrgDivision.salesOrg, '1000'), eq(salesOrgDivision.division, '01'),
  ));
  const salesAreas = await tx.select().from(salesArea).where(and(
    eq(salesArea.client, tenant), eq(salesArea.salesOrg, '1000'), eq(salesArea.distributionChannel, '01'), eq(salesArea.division, '01'),
  ));
  const locationKeys = new Set(locations.map((row) => row.storageLocation.trim()));
  // The four the standard structure writes have to stand. What is counted is presence,
  // not the total: this tenant also carries the walkthrough's own transfer bin (0004),
  // so a run that has already been through the transfer would otherwise look like a
  // structure that was never built, and a re-run would be refused for no good reason.
  const expectedLocations = ['0001', '0002', '0003', '0099'];
  if (!company?.isActive || company.name !== 'Walkthrough Company' || company.country !== COUNTRY || company.currency !== CURRENCY ||
      company.chartOfAccounts !== CHART || company.fiscalYearVariant !== FYV || company.postingPeriodVariant !== PPV || company.creditControlArea !== '0001' ||
      !cca?.isActive || cca.currency !== CURRENCY || !area?.isActive || area.currency !== CURRENCY || area.fiscalYearVariant !== FYV ||
      controllingLinks.length !== 1 || !mainPlant?.isActive || mainPlant.companyCode !== COMPANY ||
      expectedLocations.some((key) => !locationKeys.has(key)) || locations.length < expectedLocations.length ||
      !purchasing?.isActive || purchasing.companyCode !== COMPANY || purchasingLinks.length !== 1 ||
      !sales?.isActive || sales.companyCode !== COMPANY || sales.currency !== CURRENCY ||
      salesTexts.length !== 1 || salesTexts[0]?.name !== 'Standard Sales' || channelLinks.length !== 1 || divisionLinks.length !== 1 || salesAreas.length !== 1) {
    throw new Error('Standard walkthrough organisational structure is incomplete or conflicting; refusing to repair or adopt partial rows.');
  }
}

async function writeWalkthroughCheckpoint(tx: Tx, input: {
  tenant: string; database: string; asOf: string; actorUserId: string; username: string;
  companyScopeId: string; plantScopeId: string;
}): Promise<void> {
  await recordChange(tx, {
    client: input.tenant,
    objectClass: WALKTHROUGH_INSTALL_OBJECT_CLASS,
    objectKey: installationObjectKey(input.tenant),
    changeType: 'CREATE',
    changedBy: input.username,
    transactionCode: 'WALKTHROUGH.SEED',
    reason: WALKTHROUGH_INSTALL_REASON,
    correlationId: installationCorrelationId(input.tenant),
    after: {
      operation: WALKTHROUGH_INSTALL_OPERATION,
      state: 'PROVISIONED',
      client: input.tenant,
      database: input.database,
      asOf: input.asOf,
      actorUserId: input.actorUserId,
      username: input.username,
      companyScopeId: input.companyScopeId,
      plantScopeId: input.plantScopeId,
    },
    fieldLabels: { state: 'Installation State', asOf: 'Seed Date', actorUserId: 'First Administrator User ID', companyScopeId: 'Company Code Scope Record', plantScopeId: 'Plant Scope Record' },
    securityRelevantFields: ['actorUserId', 'companyScopeId', 'plantScopeId'],
  });
}

async function completeWalkthroughCheckpoint(tenant: string, checkpoint: WalkthroughCheckpoint, summary: WalkthroughSummary): Promise<void> {
  if (checkpoint.state === 'COMPLETE') return;
  const requiredChecks = ['stockReconciliation', 'stockValuation', 'inventoryGl', 'grir', 'subledger', 'accounting', 'openItems'];
  const missing = requiredChecks.filter((key) => !summary.checks[key]);
  if (missing.length) throw new Error(`Walkthrough completion checkpoint cannot be written; reconciliation evidence is missing: ${missing.join(', ')}.`);
  await withTenant(tenant, async (tx) => {
    await recordChange(tx, {
      client: tenant,
      objectClass: WALKTHROUGH_INSTALL_OBJECT_CLASS,
      objectKey: installationObjectKey(tenant),
      changeType: 'CHANGE',
      changedBy: checkpoint.username,
      transactionCode: 'WALKTHROUGH.SEED',
      reason: WALKTHROUGH_INSTALL_REASON,
      correlationId: installationCorrelationId(tenant),
      before: { state: 'PROVISIONED' },
      after: {
        state: 'COMPLETE',
        stockReconciliation: summary.checks.stockReconciliation,
        inventoryGl: summary.checks.inventoryGl,
        grir: summary.checks.grir,
        apAr: summary.checks.openItems,
        accounting: summary.checks.accounting,
      },
      fieldLabels: { state: 'Installation State', stockReconciliation: 'Stock Reconciliation', inventoryGl: 'Inventory to G/L', grir: 'GR/IR', apAr: 'AP/AR', accounting: 'Balanced Journals' },
    });
  });
}

/**
 * The configuration activities the standard package satisfies: the chart of accounts, the
 * fiscal year and posting period variants, the document types, the purchasing groups, the
 * distribution channels and divisions, and the exchange rates. Onboarding with the standard
 * package marks these complete; a tenant onboarded as `empty` receives the same rows from
 * the seed's own package activation, and configuration services such as account
 * determination refuse to write until the matching activity stands completed.
 */
const WALKTHROUGH_PACKAGE_ACTIVITIES = [
  'CFG.FIN.COA.DEFINE',
  'CFG.FIN.FYV.DEFINE',
  'CFG.FIN.PPV.DEFINE',
  'CFG.FIN.DOCTYPE.DEFINE',
  'CFG.PROC.PURGROUP.DEFINE',
  'CFG.ORG.DISTCHANNEL.DEFINE',
  'CFG.ORG.DIVISION.DEFINE',
  'CFG.FIN.EXRATE.MAINTAIN',
] as const;

async function ensureStandardPackage(tx: Tx, tenant: string, allowApply: boolean): Promise<void> {
  const markers = await tx.select({ id: changeDocument.id }).from(changeDocument).where(and(
    eq(changeDocument.client, tenant),
    eq(changeDocument.objectClass, 'standard_config_package'),
    eq(changeDocument.objectKey, STANDARD_PACKAGE_VERSION),
  ));
  if (markers.length > 1) throw new Error(`More than one ${STANDARD_PACKAGE_VERSION} package checkpoint exists; refusing to guess which configuration is authoritative.`);
  if (markers.length === 0) {
    if (!allowApply) throw new Error(`The ${STANDARD_PACKAGE_VERSION} standard package checkpoint is missing after walkthrough provisioning; refusing to repair partial installation state.`);
    const result = await applyStandardPackage(tx, { client: tenant, currency: CURRENCY, activatedBy: ACTOR });
    if (result.version !== STANDARD_PACKAGE_VERSION) throw new Error(`Unexpected standard package version ${result.version}.`);
    const written = await tx.select({ id: changeDocument.id }).from(changeDocument).where(and(
      eq(changeDocument.client, tenant),
      eq(changeDocument.objectClass, 'standard_config_package'),
      eq(changeDocument.objectKey, STANDARD_PACKAGE_VERSION),
    ));
    if (written.length !== 1) throw new Error('Standard accounting/configuration package did not leave exactly one auditable version checkpoint.');
  }
  // The package now stands, so the activities it satisfied stand completed. Recorded through
  // the same helper onboarding uses, inside the caller's transaction, and only for activities
  // whose configuration the package actually delivered.
  for (const activityCode of WALKTHROUGH_PACKAGE_ACTIVITIES) {
    await markActivityComplete(tx, tenant, activityCode, ACTOR);
  }
}

async function run(tenant: string, database: string, asOf: string): Promise<WalkthroughSummary> {
  const summary: WalkthroughSummary = { tenant, database, asOf, created: [], skipped: [], updated: 0, failed: 0, checks: {} };
  let auth: WalkthroughAuth | undefined;
  try {
    let checkpoint: WalkthroughCheckpoint | null = null;
    if (process.env.CAIRN_ENV !== 'development') throw new Error('The walkthrough seed is development-only; CAIRN_ENV must be development.');
    if (!dateIsValid(asOf)) throw new Error('CAIRN_SEED_DATE must be a real ISO date (YYYY-MM-DD).');
    if (tenant === '0100') throw new Error('Tenant 0100 is protected from walkthrough seeding. Choose a separate development tenant.');

    // Pure target policy must run before assertApplicationRole, validateTarget, or any pooled/direct DB connection.
    assertWalkthroughDatabaseTarget(database, process.env.DATABASE_URL);
    const target = await validateTarget(database, undefined, process.env.DATABASE_URL);
    if (target.protected) throw new Error(`Database ${database} is protected by the target guard.`);
    if (target.database !== database) throw new Error(`Validated database ${target.database} does not match CAIRN_SEED_DATABASE.`);
    await assertApplicationRole();

    const roleRows = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select current_user as role, current_setting('cairn.client', true) as tenant_context
    `) as unknown as Array<{ role: string; tenant_context: string }>);
    if (roleRows[0]?.role !== 'cairn_app' || roleRows[0]?.tenant_context !== tenant) {
      throw new Error(`Walkthrough mutations require current_user=cairn_app and tenant context ${tenant}; observed ${roleRows[0]?.role ?? 'no role'}/${roleRows[0]?.tenant_context ?? 'no tenant'}.`);
    }

    const tenantRows = await withTenant(tenant, (tx) => tx.select().from(tenantTable).where(eq(tenantTable.client, tenant)));
    const t = tenantRows[0];
    if (!t || t.status !== 'ACTIVE' || !t.isDevelopment || t.name !== 'Walkthrough Company' || t.legalName !== 'Walkthrough Company LLC' ||
        t.country !== COUNTRY || t.currency !== CURRENCY || t.timezone !== 'Asia/Dubai') {
      throw new Error(`Tenant ${tenant} must already be an active development tenant named Walkthrough Company LLC, country AE, currency AED, timezone Asia/Dubai. Provision it through the normal owner/onboarding flow; this seed does not create users or tenants.`);
    }

    checkpoint = await readWalkthroughCheckpoint(tenant);
    if (checkpoint) {
      assertWalkthroughCheckpointRequest(checkpoint, { operation: WALKTHROUGH_INSTALL_OPERATION, client: tenant, database, asOf });
    } else {
      await assertFreshWalkthroughTenant(tenant, required('CAIRN_SEED_USERNAME'));
    }

    // Read-only accounting prerequisite check precedes every installation/setup write.
    await preflightCreditConfiguration(tenant, summary);
    auth = await authenticateWalkthroughUser(tenant);
    ACTOR = auth.session.user.username;

    let structureCreated = false;
    if (checkpoint) {
      await withTenant(tenant, async (tx) => {
        await ensureStandardPackage(tx, tenant, false);
        await assertStandardWalkthroughStructure(tx, tenant);
      });
    } else {
      const installed = await withTenant(tenant, async (tx) => {
        await ensureStandardPackage(tx, tenant, true);
        const structure = await applyStandardStructureInTransaction(tx, {
          client: tenant, companyName: 'Walkthrough Company', country: COUNTRY, currency: CURRENCY,
          chartOfAccounts: CHART, fiscalYearVariant: FYV, postingPeriodVariant: PPV, changedBy: ACTOR,
        });
        await assertStandardWalkthroughStructure(tx, tenant);
        const scopes = await provisionWalkthroughFirstAdminScopesInTransaction(tx, {
          client: tenant, database,
          actor: { userId: auth!.session.user.userId, sessionId: auth!.session.sessionId! },
          username: ACTOR, correlationId: installationCorrelationId(tenant),
        });
        await writeWalkthroughCheckpoint(tx, {
          tenant, database, asOf, actorUserId: auth!.session.user.userId, username: ACTOR,
          companyScopeId: scopes.companyScopeId, plantScopeId: scopes.plantScopeId,
        });
        return { structureCreated: structure.created, scopes };
      });
      structureCreated = installed.structureCreated;
      checkpoint = {
        operation: WALKTHROUGH_INSTALL_OPERATION, state: 'PROVISIONED', client: tenant, database, asOf,
        actorUserId: auth.session.user.userId, username: ACTOR,
        companyScopeId: installed.scopes.companyScopeId, plantScopeId: installed.scopes.plantScopeId,
      };
    }
    await assertWalkthroughScopes(tenant, auth, checkpoint);
    summary.checks.authentication = `Normal /api/auth/signin session for ${ACTOR}; required posting capabilities and exactly the audited Company Code 1000 / Plant 1000 scopes verified.`;
    summary.checks.creditControlArea = 'active CCA 0001 in AED; Company Code 1000 mapped to it';
    record(summary, `enterprise structure ${COMPANY}/${PLANT}`, structureCreated);

    const base = await withTenant(tenant, async (tx) => {
      const start = await derivePosition(tx, tenant, FYV, asOf);
      const end = await derivePosition(tx, tenant, FYV, addDays(asOf, 8));
      if (start.fiscalYear !== end.fiscalYear || start.period !== end.period) throw new Error('Choose a seed date with the following eight days in the same fiscal period.');
      return start;
    });
    summary.checks.fiscalPosition = `${base.fiscalYear}/${base.period} (K4 calendar fiscal year)`;

    const existingPeriod = await getMaterialPeriodControl(tenant, COMPANY);
    if (existingPeriod) {
      if (existingPeriod.currentFiscalYear !== base.fiscalYear || existingPeriod.currentPeriod !== base.period) throw new Error(`Material period stands at ${existingPeriod.currentFiscalYear}/${existingPeriod.currentPeriod}; seed date is ${base.fiscalYear}/${base.period}. It will not shift or reinitialize it.`);
      record(summary, `material period ${COMPANY}/${base.fiscalYear}/${base.period}`, false);
    } else {
      await initializeMaterialPeriodControl({ client: tenant, changedBy: ACTOR, companyCode: COMPANY, fiscalYear: base.fiscalYear,
        period: base.period, reason: 'Initialize the fresh walkthrough development company to the selected seed period.' });
      record(summary, `material period ${COMPANY}/${base.fiscalYear}/${base.period}`, true);
    }

    await assertNoUnownedWalkthroughStock(tenant);
    const beforeMaterials = new Map<string, Awaited<ReturnType<typeof getMaterialDetail>>>();
    for (const number of MATERIALS) {
      const existing = await getMaterialDetail(tenant, number);
      beforeMaterials.set(number, existing);
      const expected = expectedMaterial(number);
      if (existing && (existing.base.description !== expected.description || existing.base.materialGroup !== expected.group ||
          existing.base.baseUnit !== expected.unit || existing.base.materialType !== expected.type || existing.base.isBlocked)) {
        throw new Error(`Existing material ${number} differs from its development fixture master; refusing to add or change views.`);
      }
      const plantView = existing?.plants.find((row) => row.plant === PLANT);
      if (plantView && (plantView.mrpType !== 'REQUIREMENTS' || plantView.mrpController !== '001' || plantView.procurementType !== expected.procurement ||
          (expected.procurement === 'BUY' && (plantView.purchasingGroup !== '001' || plantView.orderUnit !== expected.unit || plantView.purchasingStatus === 'NOT_CREATED')))) {
        throw new Error(`Existing plant data for ${number}/${PLANT} differs from its development fixture; refusing to use it.`);
      }
      const valuation = existing?.valuations.find((row) => row.valuationArea === PLANT);
      if (valuation && (valuation.valuationClass !== expected.valuationClass || valuation.priceControl !== expected.priceControl ||
          valuation.currency !== CURRENCY || !moneyEqual(valuation.priceControl === 'STANDARD' ? valuation.standardPrice : valuation.movingAveragePrice, expected.price))) {
        throw new Error(`Existing valuation for ${number}/${PLANT} differs from its development fixture; refusing to use it.`);
      }
    }
    await seedDevelopmentMaterials(tenant);
    for (const number of MATERIALS) {
      const detail = await getMaterialDetail(tenant, number);
      if (!detail) throw new Error(`Material fixture did not create ${number}.`);
      const expected = expectedMaterial(number);
      const plantView = detail.plants.find((row) => row.plant === PLANT);
      const valuation = detail.valuations.find((row) => row.valuationArea === PLANT);
      if (detail.base.description !== expected.description || detail.base.materialGroup !== expected.group || detail.base.baseUnit !== expected.unit ||
          detail.base.materialType !== expected.type || detail.base.isBlocked || !plantView || plantView.mrpType !== 'REQUIREMENTS' ||
          plantView.mrpController !== '001' || plantView.procurementType !== expected.procurement || !valuation ||
          valuation.valuationClass !== expected.valuationClass || valuation.priceControl !== expected.priceControl || valuation.currency !== CURRENCY ||
          !moneyEqual(valuation.priceControl === 'STANDARD' ? valuation.standardPrice : valuation.movingAveragePrice, expected.price)) {
        throw new Error(`Material ${number} does not match the development fixture; refusing to use it.`);
      }
      const before = beforeMaterials.get(number);
      const addedView = !before || !before.plants.some((row) => row.plant === PLANT) || !before.valuations.some((row) => row.valuationArea === PLANT);
      record(summary, `material ${number}`, addedView);
    }

    await ensureTaxAndAccounts(tenant, summary);
    await ensureFiNumberRange(tenant, summary);
    await ensureCreditRiskCategory(tenant, summary);
    await ensurePartners(tenant, summary);
    const assetConfiguration = await ensureAssetAcquisitionConfiguration(tenant, summary);

    const dates = { po: asOf, gr: addDays(asOf, 1), invoice: addDays(asOf, 2), productionStart: addDays(asOf, 3), productionFinish: addDays(asOf, 4), issue: addDays(asOf, 5), receipt: addDays(asOf, 6), sales: addDays(asOf, 7), delivery: addDays(asOf, 8), billing: addDays(asOf, 8) };
    await ensureProductionMasters(tenant, asOf, summary);
    await ensureMrpSafetyStock(tenant, summary);
    await ensureSalesPrice(tenant, dates.sales, summary);

    // Purchase order creation has no request-key field, so the order is found by what it
    // buys: the two walkthrough materials, and nothing else in the tenant buys either of
    // them. Searching by actor and company alone is not enough to identify it — the same
    // administrator also owns the volume orders and the asset order, so on any run after
    // the first that search finds dozens and can only refuse.
    const candidateRows = await withTenant(tenant, (tx) => tx.execute(sql`
      select o.order_number
        from purchase_order o
        join purchase_order_item i
          on i.client = o.client and i.order_number = o.order_number
       where o.client = ${tenant} and o.created_by = ${ACTOR} and o.company_code = ${COMPANY}
         and i.material_number in ('RAW-STEEL', 'PACK-CARTON')
       group by o.order_number
    `) as unknown as Promise<Array<{ order_number: string }>>);
    if (candidateRows.length > 1) throw new Error('More than one purchase order buys the walkthrough materials under the seed actor/company; refusing to guess which is the walkthrough order.');
    let order = candidateRows.length ? await getOrder(tenant, candidateRows[0].order_number) : null;
    if (order) {
      const itemExpectations = new Map([['RAW-STEEL', { quantity: 100, unit: 'KG', price: 5 }], ['PACK-CARTON', { quantity: 50, unit: 'PC', price: 2 }]]);
      if (order.documentType !== 'STANDARD' || order.supplierNumber !== SUPPLIER || order.companyCode !== COMPANY ||
          order.purchasingOrg !== PURCHASING_ORG || order.purchasingGroup !== PURCHASING_GROUP || order.currency !== CURRENCY ||
          !dateIsValid(order.documentDate) || order.documentDate > dates.gr || order.items.length !== 2 || new Set(order.items.map((item) => item.materialNumber)).size !== 2 ||
          order.items.some((item) => {
            const expected = item.materialNumber ? itemExpectations.get(item.materialNumber) : undefined;
            return !expected || !moneyEqual(item.quantity, expected.quantity, 0.0005) || item.unit !== expected.unit ||
              !moneyEqual(item.netPrice, expected.price, 0.0005) || item.priceUnit !== '1' || item.plant !== PLANT ||
              item.storageLocation !== STORAGE || item.taxCode !== VENDOR_TAX || item.accountAssignmentCategory !== null ||
              item.assignments.length > 0 || item.scheduleLines.length !== 1 || item.scheduleLines[0].deliveryDate !== dates.gr ||
              !moneyEqual(item.scheduleLines[0].quantity, expected.quantity, 0.0005);
          })) {
        throw new Error(`Seed-owned purchase order ${order.orderNumber} differs from the expected payload; refusing to modify or replay it.`);
      }
      record(summary, `purchase order ${order.orderNumber}`, false);
    } else {
      const created = await createOrder({ client: tenant, changedBy: ACTOR, supplierNumber: SUPPLIER, purchasingOrg: PURCHASING_ORG,
        purchasingGroup: PURCHASING_GROUP, companyCode: COMPANY, currency: CURRENCY,
        items: [
          { materialNumber: 'RAW-STEEL', shortText: 'Carbon steel sheet', quantity: 100, unit: 'KG', netPrice: 5, priceUnit: 1,
            plant: PLANT, storageLocation: STORAGE, taxCode: VENDOR_TAX, scheduleLines: [{ deliveryDate: dates.gr, quantity: 100 }] },
          { materialNumber: 'PACK-CARTON', shortText: 'Shipping carton', quantity: 50, unit: 'PC', netPrice: 2, priceUnit: 1,
            plant: PLANT, storageLocation: STORAGE, taxCode: VENDOR_TAX, scheduleLines: [{ deliveryDate: dates.gr, quantity: 50 }] },
        ] });
      order = await getOrder(tenant, created.orderNumber);
      if (!order) throw new Error(`Purchase order ${created.orderNumber} was not readable after creation.`);
      record(summary, `purchase order ${order.orderNumber}`, true);
    }

    const release = await getDocumentRelease(tenant, 'PURCHASE_ORDER', order.orderNumber);
    if (release.status === 'PENDING') throw new Error(`Purchase order ${order.orderNumber} requires an approval step (${release.steps[release.currentStep] ?? 'unknown'}). Approve it through the normal UI, then rerun with the same seed date.`);
    if (release.status !== 'NOT_REQUIRED' && release.status !== 'RELEASED') throw new Error(`Purchase order ${order.orderNumber} has unexpected release state ${release.status}.`);

    const grKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-gr`;
    const oldReceipt = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select material_document_number from material_document where client = ${tenant} and request_key = ${grKey}
    `) as unknown as Array<{ material_document_number: string }>);
    const receipt = await postGoodsReceipt({ client: tenant, changedBy: ACTOR, orderNumber: order.orderNumber, documentDate: dates.gr,
      postingDate: dates.gr, headerText: 'Walkthrough receipt', requestKey: grKey,
      lines: order.items.map((item) => ({ itemNumber: item.itemNumber, quantity: Number(item.quantity), storageLocation: STORAGE })) },
      { authorization: { userId: auth.session.user.userId, sessionId: auth.session.sessionId! } });
    if (receipt.status !== 'POSTED') throw new Error(`Goods receipt ${receipt.materialDocumentNumber} stands ${receipt.status}; a reversed or incomplete receipt will not be reused.`);
    record(summary, `goods receipt ${receipt.materialDocumentNumber}`, oldReceipt.length === 0);

    const invoiceKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-supplier-invoice`;
    const oldInvoice = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select invoice_number from supplier_invoice where client = ${tenant} and request_key = ${invoiceKey}
    `) as unknown as Array<{ invoice_number: string }>);
    const invoice = await postSupplierInvoice({ client: tenant, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: `WT-${tenant}-SUP-001`, invoiceDate: dates.invoice, postingDate: dates.invoice, grossAmount: 630,
      headerText: 'Walkthrough supplier invoice', requestKey: invoiceKey,
      lines: order.items.map((item) => ({ itemNumber: item.itemNumber, quantity: Number(item.quantity),
        netAmount: Number(item.quantity) * Number(item.netPrice), taxCode: VENDOR_TAX })) });
    const invoiceItems = new Map([['RAW-STEEL', { quantity: 100, net: 500 }], ['PACK-CARTON', { quantity: 50, net: 100 }]]);
    if (invoice.status !== 'POSTED' || invoice.supplierNumber !== SUPPLIER || invoice.companyCode !== COMPANY ||
        invoice.purchaseOrderNumber !== order.orderNumber || invoice.supplierReference !== `WT-${tenant}-SUP-001` ||
        invoice.invoiceDate !== dates.invoice || invoice.postingDate !== dates.invoice || !moneyEqual(invoice.grossAmount, 630) ||
        invoice.items.length !== 2 || invoice.items.some((item) => {
          const expected = item.materialNumber ? invoiceItems.get(item.materialNumber) : undefined;
          return !expected || !moneyEqual(item.quantity, expected.quantity, 0.0005) || !moneyEqual(item.netAmount, expected.net) || item.taxCode !== VENDOR_TAX;
        })) {
      throw new Error(`Supplier invoice ${invoice.invoiceNumber} does not match the walkthrough payload.`);
    }
    record(summary, `supplier invoice ${invoice.invoiceNumber}`, oldInvoice.length === 0);

    const mrpKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-mrp`;
    const oldMrpRun = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select run_number from mrp_run where client = ${tenant} and request_key = ${mrpKey}
    `) as unknown as Array<{ run_number: string }>);
    const mrpRun = await planMaterials({ client: tenant, requestedBy: ACTOR, requestKey: mrpKey,
      processingKey: 'NETCH', plantFrom: PLANT, plantTo: PLANT, materialFrom: 'FG-BRACKET', materialTo: 'FG-BRACKET',
      entryPoint: 'SINGLE_ITEM', explode: true, productionVersion: '0001' });
    const mrp = await getMrpRun(tenant, mrpRun.runNumber);
    if (!mrp || !['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(mrp.status) || mrp.materialsFailed !== 0) {
      throw new Error(`MRP run ${mrpRun.runNumber} did not complete cleanly: ${mrp?.errorSummary ?? mrp?.status ?? 'not readable'}.`);
    }
    const proposal = mrp.proposals.find((item) => item.materialNumber === 'FG-BRACKET' && item.proposalType === 'PLANNED_ORDER' && item.action !== 'DELETE');
    if (!proposal?.documentNumber || !moneyEqual(proposal.quantity, 5, 0.0005)) {
      throw new Error(`MRP run ${mrpRun.runNumber} did not create the expected five-piece FG-BRACKET planned order.`);
    }
    record(summary, `MRP run ${mrpRun.runNumber} / planned order ${proposal.documentNumber}`, oldMrpRun.length === 0);
    let planned = await getPlannedOrder(tenant, proposal.documentNumber);
    if (!planned || planned.materialNumber !== 'FG-BRACKET' || planned.plant !== PLANT || !moneyEqual(planned.quantity, 5, 0.0005) || planned.unit !== 'PC') {
      throw new Error(`MRP planned order ${proposal.documentNumber} does not match the expected material, plant, quantity and unit.`);
    }
    if (planned.startDate !== dates.productionStart || planned.finishDate !== dates.productionFinish) {
      const changed = await changePlannedOrder({ client: tenant, changedBy: ACTOR, orderNumber: planned.orderNumber,
        expectedVersion: planned.version, startDate: dates.productionStart, finishDate: dates.productionFinish });
      if (!changed.order || changed.order.startDate !== dates.productionStart || changed.order.finishDate !== dates.productionFinish) {
        throw new Error(`Planned order ${planned.orderNumber} did not accept the walkthrough schedule.`);
      }
      planned = changed.order;
    }
    const conversion = await convertPlannedOrder({ client: tenant, changedBy: ACTOR, orderNumber: planned.orderNumber,
      expectedVersion: planned.version, orderType: 'PP01', productionVersion: '0001' });
    if (!conversion.productionOrderNumber || !['CONVERTED', 'ALREADY_CONVERTED'].includes(conversion.status)) {
      throw new Error(`Planned order ${planned.orderNumber} was not converted: ${conversion.message}`);
    }
    const production = await getProductionOrder(tenant, conversion.productionOrderNumber);
    const expectedComponents = new Map([['RAW-STEEL', 98], ['PACK-CARTON', 5]]);
    if (!production || production.plannedOrderNumber !== planned.orderNumber || production.materialNumber !== 'FG-BRACKET' || production.plant !== PLANT || production.orderType !== 'PP01' ||
        !moneyEqual(production.orderQuantity, 5, 0.0005) || production.productionVersion !== '0001' ||
        production.scheduledStart !== dates.productionStart || production.scheduledFinish !== dates.productionFinish ||
        production.components.length !== 2 || production.components.some((component) => {
          const expected = expectedComponents.get(component.materialNumber);
          return expected === undefined || !moneyEqual(component.requiredQuantity, expected, 0.0005);
        })) {
      throw new Error('Converted planned order does not match the expected production-order snapshot; refusing to proceed.');
    }
    record(summary, `production order ${production.orderNumber}`, conversion.status === 'CONVERTED');
    const releasedProduction = await releaseProductionOrder({ client: tenant, orderNumber: production.orderNumber, releasedBy: ACTOR });
    if (releasedProduction.status !== 'RELEASED') throw new Error(`Production order ${production.orderNumber} is not released.`);

    const existingIssue = await withTenant(tenant, (tx) => tx.execute(sql`
      select material_document_number from material_document where client = ${tenant} and request_key = ${`${REQUEST_PREFIX}-${tenant.toLowerCase()}-production-issue`}
    `) as unknown as Promise<Array<{ material_document_number: string }>>);
    if (existingIssue.length) record(summary, `production component issue ${existingIssue[0].material_document_number}`, false);
    const issue = await postGoodsIssue({ client: tenant, changedBy: ACTOR, movementTypeCode: '261', postingDate: dates.issue,
      documentDate: dates.issue, headerText: 'Walkthrough prod issue', requestKey: `${REQUEST_PREFIX}-${tenant.toLowerCase()}-production-issue`,
      lines: production.components.map((component) => ({ materialNumber: component.materialNumber, plant: component.plant,
        storageLocation: component.storageLocation || STORAGE, quantity: Number(component.requiredQuantity),
        productionOrderNumber: production.orderNumber, productionOrderItem: component.itemNumber })) }, 'MIGO',
      { authorization: { userId: auth.session.user.userId, sessionId: auth.session.sessionId! } });
    if (await materialDocumentStatus(tenant, `${REQUEST_PREFIX}-${tenant.toLowerCase()}-production-issue`) !== 'POSTED') {
      throw new Error(`Production component issue ${issue.materialDocumentNumber} is not in POSTED status.`);
    }
    if (!existingIssue.length) record(summary, `production component issue ${issue.materialDocumentNumber}`, true);

    const existingReceipt = await withTenant(tenant, (tx) => tx.execute(sql`
      select material_document_number from material_document where client = ${tenant} and request_key = ${`${REQUEST_PREFIX}-${tenant.toLowerCase()}-production-receipt`}
    `) as unknown as Promise<Array<{ material_document_number: string }>>);
    const finishedReceipt = await postProductionReceipt({ client: tenant, changedBy: ACTOR, orderNumber: production.orderNumber,
      postingDate: dates.receipt, documentDate: dates.receipt, headerText: 'Walkthrough output GR',
      requestKey: `${REQUEST_PREFIX}-${tenant.toLowerCase()}-production-receipt`, lines: [{ storageLocation: STORAGE, quantity: 5, entryUnit: 'PC' }] });
    if (finishedReceipt.orderNumber !== production.orderNumber || finishedReceipt.movementCode !== '101' || !moneyEqual(finishedReceipt.receivedAfter, 5, 0.0005) ||
        await materialDocumentStatus(tenant, `${REQUEST_PREFIX}-${tenant.toLowerCase()}-production-receipt`) !== 'POSTED') {
      throw new Error(`Production receipt ${finishedReceipt.materialDocumentNumber} is incomplete, reversed, or linked to a different order.`);
    }
    record(summary, `production receipt ${finishedReceipt.materialDocumentNumber}`, !existingReceipt.length);

    const salesOrderResult = await createSalesOrder({ client: tenant, changedBy: ACTOR, salesOrg: SALES_ORG,
      distributionChannel: CHANNEL, division: DIVISION, customerNumber: CUSTOMER, companyCode: COMPANY,
      currency: CURRENCY, orderDate: dates.sales, requestKey: `${REQUEST_PREFIX}-${tenant.toLowerCase()}-sales-order`,
      lines: [{ materialNumber: 'FG-BRACKET', plant: PLANT, orderQuantity: 5, quantityUnit: 'PC', taxCode: VENDOR_TAX }] });
    const salesOrder = await getSalesOrder(tenant, salesOrderResult.orderNumber);
    if (!salesOrder || salesOrder.lines.length !== 1 || salesOrder.lines[0].materialNumber !== 'FG-BRACKET' ||
        !moneyEqual(salesOrder.lines[0].orderQuantity, 5, 0.0005) || !moneyEqual(salesOrder.lines[0].netPrice, 160) ||
        salesOrder.lines[0].taxCode !== VENDOR_TAX || salesOrder.customerNumber !== CUSTOMER || salesOrder.companyCode !== COMPANY) {
      throw new Error(`Sales order ${salesOrderResult.orderNumber} does not match the seed payload.`);
    }
    record(summary, `sales order ${salesOrderResult.orderNumber}`, !salesOrderResult.replayed);

    const deliveryResult = await createDelivery({ client: tenant, changedBy: ACTOR, orderNumber: salesOrderResult.orderNumber,
      deliveryDate: dates.delivery, goodsMovementDate: dates.delivery, items: [{ orderLineNumber: salesOrder.lines[0].lineNumber, quantity: '5' }],
      requestKey: `${REQUEST_PREFIX}-${tenant.toLowerCase()}-delivery` });
    let delivery = await getDelivery(tenant, deliveryResult.deliveryNumber);
    if (!delivery) throw new Error(`Delivery ${deliveryResult.deliveryNumber} is not readable.`);
    if (delivery.orderNumber !== salesOrder.orderNumber || delivery.customerNumber !== CUSTOMER || delivery.plant !== PLANT ||
        delivery.deliveryDate !== dates.delivery || delivery.lines.length !== 1 || delivery.lines[0].orderLineNumber !== salesOrder.lines[0].lineNumber ||
        delivery.lines[0].materialNumber !== 'FG-BRACKET' || !moneyEqual(delivery.lines[0].deliveryQuantity, 5, 0.0005)) {
      throw new Error(`Delivery ${delivery.deliveryNumber} does not match the walkthrough order and quantity.`);
    }
    record(summary, `delivery ${delivery.deliveryNumber}`, !deliveryResult.replayed);
    if (delivery.status !== 'GOODS_ISSUED') {
      if (delivery.status !== 'PICKED') {
        delivery = await confirmDeliveryPicks({ client: tenant, changedBy: ACTOR, deliveryNumber: delivery.deliveryNumber,
          expectedVersion: delivery.version, requestKey: `${REQUEST_PREFIX}-${tenant.toLowerCase()}-pick`,
          items: [{ lineNumber: delivery.lines[0].lineNumber, quantity: delivery.lines[0].deliveryQuantity, storageLocation: STORAGE }] });
      }
      await postDeliveryGoodsIssue({ client: tenant, changedBy: ACTOR, deliveryNumber: delivery.deliveryNumber,
        expectedVersion: delivery.version, postingDate: dates.delivery, documentDate: dates.delivery });
      delivery = await getDelivery(tenant, delivery.deliveryNumber) ?? delivery;
    }
    if (delivery.status !== 'GOODS_ISSUED') throw new Error(`Delivery ${delivery.deliveryNumber} is not goods-issued after the lifecycle steps.`);

    const billing = await createBillingFromDelivery({ client: tenant, changedBy: ACTOR, deliveryNumber: delivery.deliveryNumber,
      billingDate: dates.billing, requestKey: `${REQUEST_PREFIX}-${tenant.toLowerCase()}-billing` });
    const billingInvoice = billing.invoice ?? (billing.billing.customerInvoiceNumber
      ? await getCustomerInvoice(tenant, billing.billing.customerInvoiceNumber)
      : null);
    record(summary, `billing ${billing.billing.billingNumber}`, !billing.replayed);
    if (!billingInvoice || !billing.posted || billing.heldForCredit || billing.billing.status !== 'POSTED' || billingInvoice.status !== 'POSTED' ||
        billing.billing.deliveryNumber !== delivery.deliveryNumber ||
        billing.billing.customerNumber !== CUSTOMER || billing.billing.companyCode !== COMPANY || billing.billing.currency !== CURRENCY ||
        !moneyEqual(billing.billing.netValue, 800) || !moneyEqual(billing.billing.taxValue, 40) || !moneyEqual(billing.billing.grossValue, 840) ||
        billingInvoice.customerNumber !== CUSTOMER || !moneyEqual(billingInvoice.grossAmount, 840)) {
      throw new Error(`Billing ${billing.billing.billingNumber} or its accounting invoice does not match the walkthrough sale.`);
    }

    const creditMemoKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-credit-memo`;
    const oldCreditMemo = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select invoice_number from customer_invoice where client = ${tenant} and request_key = ${creditMemoKey}
    `) as unknown as Array<{ invoice_number: string }>);
    const creditMemo = await postCustomerCreditMemo({ client: tenant, changedBy: ACTOR, customerNumber: CUSTOMER,
      companyCode: COMPANY, documentDate: dates.billing, postingDate: dates.billing, reference: `WT-${tenant}-CM-001`,
      currency: CURRENCY, grossAmount: 168, creditOfInvoice: billingInvoice.invoiceNumber,
      creditOfBilling: billing.billing.billingNumber, requestKey: creditMemoKey,
      lines: [{ glAccount: '300000', netAmount: 160, taxCode: VENDOR_TAX }] });
    if (creditMemo.status !== 'POSTED' || creditMemo.creditOf !== billingInvoice.invoiceNumber || creditMemo.customerNumber !== CUSTOMER ||
        creditMemo.companyCode !== COMPANY || creditMemo.documentDate !== dates.billing || creditMemo.postingDate !== dates.billing ||
        creditMemo.reference !== `WT-${tenant}-CM-001` || creditMemo.currency !== CURRENCY || !moneyEqual(creditMemo.grossAmount, 168) ||
        creditMemo.lines.length !== 1 || creditMemo.lines[0].glAccount !== '300000' || !moneyEqual(creditMemo.lines[0].netAmount, 160) ||
        creditMemo.lines[0].taxCode !== VENDOR_TAX) {
      throw new Error(`Customer credit memo ${creditMemo.invoiceNumber} does not match the walkthrough payload.`);
    }
    record(summary, `customer credit memo ${creditMemo.invoiceNumber}`, oldCreditMemo.length === 0);

    const payables = await getPayables(tenant, SUPPLIER, COMPANY);
    const apPaymentKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-ap-payment`;
    const oldApPayment = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select payment_number from outgoing_payment where client = ${tenant} and request_key = ${apPaymentKey}
    `) as unknown as Array<{ payment_number: string }>);
    if (oldApPayment.length === 0 && (payables.openItems.length !== 1 || !moneyEqual(payables.openBalance, 630))) {
      throw new Error(`Expected one ${SUPPLIER} payable for AED 630 before settlement; found ${payables.openItems.length} item(s), balance ${payables.openBalance}.`);
    }
    const apInvoiceRef = await partnerSubledgerLine(tenant, invoice.journalDocumentNumber!, invoice.fiscalYear, SUPPLIER, '200000');
    const apItems = oldApPayment.length ? [apInvoiceRef] : payables.openItems.map((item) => ({ documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber }));
    const apPayment = await postOutgoingPayment({ client: tenant, changedBy: ACTOR, vendorNumber: SUPPLIER, companyCode: COMPANY,
      documentDate: dates.billing, postingDate: dates.billing, clearingDate: dates.billing, bankGlAccount: '101000',
      amount: 630, currency: CURRENCY, reference: `WT-${tenant}-AP-01`, requestKey: apPaymentKey,
      items: apItems });
    if (!moneyEqual(apPayment.amount, 630) || apPayment.itemsCleared !== 1) throw new Error(`Outgoing payment ${apPayment.paymentNumber} did not settle the supplier invoice.`);
    record(summary, `supplier payment ${apPayment.paymentNumber}`, oldApPayment.length === 0);
    const vendorClearing = await getVendorClearing(tenant, SUPPLIER, COMPANY);
    if (vendorClearing.openItems.length !== 0 || !moneyEqual(vendorClearing.openBalance, 0) || vendorClearing.clearedItems.length < 2) {
      throw new Error(`Supplier payment left an unexpected AP balance or clearing history: ${JSON.stringify({ openItems: vendorClearing.openItems.length, openBalance: vendorClearing.openBalance, clearedItems: vendorClearing.clearedItems.length })}`);
    }

    const receivables = await getReceivables(tenant, CUSTOMER, COMPANY);
    const arPaymentKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-ar-payment`;
    const oldArPayment = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select payment_number from incoming_payment where client = ${tenant} and request_key = ${arPaymentKey}
    `) as unknown as Array<{ payment_number: string }>);
    if (oldArPayment.length === 0 && (receivables.openItems.length !== 1 || !moneyEqual(receivables.openBalance, 840))) {
      throw new Error(`Expected one ${CUSTOMER} receivable for AED 840 before the partial receipt; found ${receivables.openItems.length} item(s), balance ${receivables.openBalance}.`);
    }
    const arInvoiceRef = await partnerSubledgerLine(tenant, billingInvoice.journalDocumentNumber!, billingInvoice.fiscalYear, CUSTOMER, '110000');
    const arItems = oldArPayment.length ? [{ ...arInvoiceRef, applied: 672, outcome: 'PARTIAL' as const }]
      : [{ documentNumber: receivables.openItems[0].documentNumber, fiscalYear: receivables.openItems[0].fiscalYear,
          lineNumber: receivables.openItems[0].lineNumber, applied: 672, outcome: 'PARTIAL' as const }];
    const arPayment = await postIncomingPayment({ client: tenant, changedBy: ACTOR, customerNumber: CUSTOMER, companyCode: COMPANY,
      documentDate: dates.billing, postingDate: dates.billing, clearingDate: dates.billing, bankGlAccount: '101000',
      amount: 672, currency: CURRENCY, reference: `WT-${tenant}-AR-01`, requestKey: arPaymentKey,
      items: arItems });
    if (!moneyEqual(arPayment.amount, 672) || arPayment.itemsCleared !== 0) throw new Error(`Incoming partial payment ${arPayment.paymentNumber} did not leave its expected residual open.`);
    record(summary, `customer partial payment ${arPayment.paymentNumber}`, oldArPayment.length === 0);

    const customerBeforeClear = await getCustomerClearing(tenant, CUSTOMER, COMPANY);
    const arClearingKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-ar-clearing`;
    const oldArClearing = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select 1 as found from change_document d join change_document_item i
        on i.client = d.client and i.change_document_id = d.id
       where d.client = ${tenant} and d.object_class = 'customer_clearing'
         and i.field_name = 'requestKey' and i.new_value = ${arClearingKey}
       limit 1
    `) as unknown as Array<{ found: number }>);
    if (oldArClearing.length === 0 && (customerBeforeClear.openItems.length !== 3 || !moneyEqual(customerBeforeClear.openBalance, 0))) {
      throw new Error(`Expected invoice, partial receipt, and linked credit memo to balance before customer clearing; found ${customerBeforeClear.openItems.length} item(s), balance ${customerBeforeClear.openBalance}.`);
    }
    if (oldArClearing.length > 0 && (customerBeforeClear.openItems.length !== 0 || !moneyEqual(customerBeforeClear.openBalance, 0))) {
      throw new Error('The existing customer clearing did not leave zero open items.');
    }
    const clearingReplayItems = customerBeforeClear.openItems.length ? customerBeforeClear.openItems : customerBeforeClear.clearedItems;
    const arClearing = await clearCustomerItems({ client: tenant, changedBy: ACTOR, customer: CUSTOMER, companyCode: COMPANY,
      clearingDate: dates.billing, postingDate: dates.billing, documentDate: dates.billing, confirmed: true,
      requestKey: arClearingKey,
      items: clearingReplayItems.map((item) => ({ documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, lineNumber: item.lineNumber })) });
    if (!moneyEqual(arClearing.openBalance, 0) || arClearing.openItems.length !== 0 || arClearing.clearedItems.length < 6) {
      throw new Error(`Customer clearing ${arClearing.clearingDocumentNumber} did not clear the balanced invoice/payment/credit items.`);
    }
    record(summary, `customer clearing ${arClearing.clearingDocumentNumber}`, oldArClearing.length === 0);

    await ensureTransferStorageLocation(tenant, summary);
    const transferKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-transfer`;
    const oldTransfer = await withTenant(tenant, async (tx) => await tx.execute(sql`
      select material_document_number from material_document where client = ${tenant} and request_key = ${transferKey}
    `) as unknown as Array<{ material_document_number: string }>);
    const transfer = await postTransfer({ client: tenant, changedBy: ACTOR, movementTypeCode: '311', materialNumber: 'RAW-STEEL',
      quantity: 1, issuingPlant: PLANT, issuingStorageLocation: STORAGE, receivingPlant: PLANT,
      receivingStorageLocation: TRANSFER_STORAGE, postingDate: dates.billing, documentDate: dates.billing,
      headerText: 'Walkthrough bin transfer', externalReference: `WT-${tenant}-TR-01`, requestKey: transferKey });
    if (!(transfer.status === 'POSTED' || (oldTransfer.length > 0 && transfer.status === 'REVERSED')) || transfer.lines.length !== 2 || transfer.lines.some((line) => line.materialNumber !== 'RAW-STEEL')) {
      throw new Error(`Storage transfer ${transfer.materialDocumentNumber} does not contain the expected posted two-sided movement.`);
    }
    record(summary, `storage transfer ${transfer.materialDocumentNumber}`, oldTransfer.length === 0);
    const reversalKey = `${REQUEST_PREFIX}-${tenant.toLowerCase()}-transfer-reversal`;
    const reversal = await reverseTransfer({ client: tenant, changedBy: ACTOR, materialDocumentNumber: transfer.materialDocumentNumber,
      postingDate: dates.billing, documentDate: dates.billing, requestKey: reversalKey });
    const originalAfterReversal = await getTransferDocument(tenant, transfer.materialDocumentNumber);
    if (!originalAfterReversal || originalAfterReversal.status !== 'REVERSED' || originalAfterReversal.reversedBy !== reversal.materialDocumentNumber ||
        reversal.status !== 'POSTED' || reversal.reversalOf !== transfer.materialDocumentNumber) {
      throw new Error(`Transfer ${transfer.materialDocumentNumber} and its reversal do not retain linked reversal history.`);
    }
    record(summary, `transfer reversal ${reversal.materialDocumentNumber}`, !transfer.reversedBy);
    const transferStock = await transferStockAt(tenant, 'RAW-STEEL', PLANT);
    const stockAt = (location: string) => transferStock.filter((row) => row.storageLocation === location).reduce((sum, row) => sum + Number(row.quantity), 0);
    if (!moneyEqual(stockAt(STORAGE), 2, 0.0005) || !moneyEqual(stockAt(TRANSFER_STORAGE), 0, 0.0005)) {
      throw new Error(`The transfer reversal did not restore the expected storage-location quantities: ${JSON.stringify(transferStock)}.`);
    }

    // Volume runs after the reconciled single-document walkthrough and before the
    // checks below, so every tie-out has to hold for the whole tenant, not just for
    // the one order the walkthrough follows. It touches no walkthrough material.
    const volume = await runWalkthroughVolume({
      tenant,
      actor: ACTOR,
      authorization: { userId: auth!.session.user.userId, sessionId: auth!.session.sessionId! },
      company: COMPANY,
      plant: PLANT,
      storage: STORAGE,
      purchasingOrg: PURCHASING_ORG,
      purchasingGroup: PURCHASING_GROUP,
      salesOrg: SALES_ORG,
      channel: CHANNEL,
      division: DIVISION,
      chart: CHART,
      currency: CURRENCY,
      taxCode: VENDOR_TAX,
      creditControlArea: '0001',
      controllingArea: 'A000',
      requestPrefix: REQUEST_PREFIX,
      dates,
      record: (label, created) => record(summary, label, created),
    });
    summary.checks.volume = `${volume.materials} materials, ${volume.suppliers} suppliers, ${volume.customers} customers, ` +
      `${volume.purchaseOrders} purchase orders, ${volume.goodsReceipts} goods receipts, ${volume.supplierInvoices} supplier invoices, ` +
      `${volume.inspectionLots} inspection lots with ${volume.inspectionResults} recorded results and accepted usage decisions, ` +
      `${volume.productionOrders} production orders, ${volume.salesOrders} sales orders, ${volume.deliveries} deliveries, ` +
      `${volume.billingDocuments} billing documents, ${volume.employees} employees in ${volume.orgUnits} org units on ${volume.positions} positions, ` +
      `${volume.absences} approved absences, ${volume.timeRecordings} time recordings, ${volume.payComponents} pay components; ` +
      'every volume component closes at purchased less consumed, every finished good at zero after sale, and every volume partner at zero open items';

    // The asset path runs last, before the checks below, so every tie-out has to hold
    // with an asset in the tenant too: the acquisition, the invoice that capitalized it,
    // the payment that settled it, and no stock or GR/IR balance anywhere in between.
    const asset = await runWalkthroughAssetProcurement({
      tenant, actor: ACTOR, company: COMPANY, plant: PLANT, chart: CHART,
      purchasingOrg: PURCHASING_ORG, purchasingGroup: PURCHASING_GROUP, supplier: SUPPLIER,
      currency: CURRENCY, taxCode: VENDOR_TAX,
      transactionType: assetConfiguration.transactionType, assetClass: assetConfiguration.assetClass,
      assetAccount: assetConfiguration.assetAccount,
      requestPrefix: REQUEST_PREFIX,
      invoiceDate: dates.invoice, postingDate: dates.invoice, paymentDate: dates.billing,
      record: (label, created) => record(summary, label, created),
    });
    summary.checks.assetProcurement = `asset ${asset.assetNumber}/${asset.subNumber} acquired for ${asset.acquiredValue} by invoice ${asset.invoiceNumber} ` +
      `(order ${asset.orderNumber}, no goods movement, ${asset.grIrLines} GR/IR or stock lines), settled by payment ${asset.paymentNumber}`;

    await runChecks(tenant, base.fiscalYear, summary);
    summary.checks.lifecycle = 'PO → GR → supplier invoice → AP payment/clearing; safety-stock MRP → planned order change/conversion → released production order → 261 issue → output receipt; sales order → delivery pick → goods issue → billing/invoice → partial AR receipt → DI-020 credit memo → customer clearing; 311 storage transfer → reversal; asset-assigned PO → supplier invoice capitalizing the asset → AP payment/clearing (no receipt, no GR/IR)';
    summary.checks.openItems = 'supplier and customer open items are zero after payment/clearing; customer and vendor subledgers tie to G/L';
    summary.checks.payments = `supplier payment ${apPayment.paymentNumber} cleared ${vendorClearing.clearedItems.length} AP items; customer partial receipt ${arPayment.paymentNumber} and clearing ${arClearing.clearingDocumentNumber} left zero AR items`;
    summary.checks.transferReversal = `transfer ${transfer.materialDocumentNumber} reversed by ${reversal.materialDocumentNumber}; 2 KG raw steel restored to ${STORAGE}, zero in ${TRANSFER_STORAGE}`;
    if (!checkpoint) throw new Error('Walkthrough installation checkpoint is missing after provisioning.');
    await completeWalkthroughCheckpoint(tenant, checkpoint, summary);
    summary.checks.installationCheckpoint = checkpoint.state === 'COMPLETE' ? 'Complete checkpoint already verified on same-date replay.' : 'Complete checkpoint written after reconciliation.';
    return summary;
  } catch (error) {
    summary.failed += 1;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { walkthroughSummary: summary });
  } finally {
    if (auth) {
      try {
        await signOutWalkthroughUser(auth);
        summary.checks.sessionCleanup = 'Authenticated walkthrough session was revoked through the normal sign-out endpoint.';
      } catch {
        summary.checks.sessionCleanup = 'Normal sign-out failed; the live session may remain until expiry.';
        if (summary.failed === 0) {
          summary.failed += 1;
          throw Object.assign(new Error('The walkthrough ran, but its authenticated session could not be revoked.'), { walkthroughSummary: summary });
        }
      }
    }
  }
}

async function main() {
  try {
    const tenant = required('CAIRN_SEED_TENANT').toUpperCase();
    const database = required('CAIRN_SEED_DATABASE');
    const asOf = required('CAIRN_SEED_DATE');
    const summary = await run(tenant, database, asOf);
    console.log(JSON.stringify({ ...summary, ...summaryTotals(summary), outOfScope: OUT_OF_SCOPE }, null, 2));
    console.log('Walkthrough seed completed. Re-run only with the same database, tenant and CAIRN_SEED_DATE. No existing values were overwritten and no data was deleted.');
  } catch (error) {
    const e = error as Error & { walkthroughSummary?: WalkthroughSummary };
    if (e.walkthroughSummary) console.error(JSON.stringify({ ...e.walkthroughSummary, ...summaryTotals(e.walkthroughSummary), outOfScope: OUT_OF_SCOPE }, null, 2));
    console.error(`walkthrough-seed failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

if (process.argv[1]?.endsWith('walkthrough-seed.ts')) void main();

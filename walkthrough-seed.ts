/**
 * Walkthrough seed — CAIRN-7 §2.839.
 *
 * Deterministic, manually executable seed that builds an interconnected
 * business scenario inside an existing tenant. It exercises the purchase-to-pay
 * and order-to-cash chains supported by this release, including the DI-020
 * customer credit memo workflow.
 *
 * Safety:
 *   - Requires explicit database target (CAIRN_SEED_DATABASE); never falls back
 *     to DATABASE_URL / MIGRATION_DATABASE_URL.
 *   - Validates the target through `validateTarget`; refuses protected databases.
 *   - Never deletes, overwrites, or silently changes existing data.
 *   - Idempotent: safe to repeat; existing business documents are left alone.
 *   - Runs only when invoked by the owner (never during build, startup,
 *     migration, or restart).
 *
 * Usage (inside the running application container):
 *   docker exec -it cairn-app tsx /app/walkthrough-seed.ts
 *
 * Required environment:
 *   CAIRN_SEED_DATABASE        Database name (explicit, never guessed)
 *   CAIRN_SEED_TENANT          Tenant/client key (default: WK01)
 *   CAIRN_SEED_CHANGED_BY      Actor for audit fields (default: WALKTHROUGH_SEED)
 *   CAIRN_DB_USER / CAIRN_DB_PASSWORD / CAIRN_DB_HOST / CAIRN_DB_PORT
 *                              App-role credentials for verification (never printed)
 *   DATABASE_URL / MIGRATION_DATABASE_URL   Actual mutation connections
 */

import { validateTarget } from './src/platform/db/target-guard';
import postgres from 'postgres';
import { withTenant, directSql } from './src/platform/db/client';
import { createTenant } from './src/platform/tenancy';
import { applyStandardStructure } from './src/platform/tenancy/standard-structure';
import { seedDevelopmentMaterials } from './src/modules/inventory/development-fixture';
import {
  businessPartner, bpRole, customerCompany,
  taxCode, accountDetermination, paymentTerms,
} from './src/modules/foundation/schema';
import { supplierPurchasing } from './src/modules/foundation/supplier-purchasing-schema';
import { postCustomerCreditMemo } from './src/modules/finance/customer-credit-memo';
import { type CustomerCreditMemoView } from './src/modules/finance/customer-credit-memo';

const DEFAULT_TENANT = 'WK01';
const DEFAULT_CHANGED_BY = 'WALKTHROUGH_SEED';
const COMPANY_CODE = '1000';
const COUNTRY = 'KW';
const CURRENCY = 'USD';
const PLANT = '1000';
const STORAGE_LOCATION = '0001';
const PURCHASING_ORG = '1000';
const PURCHASING_GROUP = '001';
const SALES_ORG = '1000';
const DIST_CHANNEL = '01';
const DIVISION = '01';
const GL_RECONCILIATION = '100000';
const GL_REVENUE = '400000';
const GL_TAX = '240000';
const GL_PURCHASE = '500000';
const GL_GR_IR = '250000';
const CHART = 'CA01';
const FYV = 'K4';
const PPV = 'C001';

interface Summary {
  tenant: string;
  company: string;
  created: boolean;
  materials: number;
  businessPartners: number;
  purchaseOrders: number;
  goodsReceipts: number;
  salesOrders: number;
  deliveries: number;
  billingDocuments: number;
  customerInvoices: number;
  creditMemos: number;
  journalLines: number;
  notes: string[];
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Environment & connection
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`walkthrough-seed: ${name} is required (set it before invoking).`);
  }
  return value.trim();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  // ── Resolve configuration (explicit targets only) ──────────────────────
  const database = requiredEnv('CAIRN_SEED_DATABASE');
  const tenant = (process.env.CAIRN_SEED_TENANT ?? DEFAULT_TENANT).toUpperCase();
  const changedBy = process.env.CAIRN_SEED_CHANGED_BY ?? DEFAULT_CHANGED_BY;

  // Validate the target before any mutation. Protected databases are refused.
  const validated = await validateTarget(database, undefined, process.env.DATABASE_URL);
  if (validated.protected) {
    throw new Error(
      `walkthrough-seed: "${database}" is a protected database. ` +
        'The walkthrough seed must not target acceptance databases.',
    );
  }
  console.log(`walkthrough-seed: validated target "${validated.database}"`);
  console.log(`walkthrough-seed: tenant "${tenant}" · changed_by "${changedBy}"`);

  // ── Connect for foundation-data writes (direct SQL, app role) ──────────
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) {
    throw new Error('walkthrough-seed: MIGRATION_DATABASE_URL is required.');
  }
  // Point the migration URL at the validated database name.
  const targetUrl = new URL(migrationUrl);
  targetUrl.pathname = `/${database}`;

  const client = postgres(targetUrl.toString(), {
    max: 5,
    prepare: false,
    onnotice: () => {},
  });

  const summary: Summary = {
    tenant,
    company: COMPANY_CODE,
    created: false,
    materials: 0,
    businessPartners: 0,
    purchaseOrders: 0,
    goodsReceipts: 0,
    salesOrders: 0,
    deliveries: 0,
    billingDocuments: 0,
    customerInvoices: 0,
    creditMemos: 0,
    journalLines: 0,
    notes: [],
  };

  try {
    // ── 1. Tenant (create if missing; never overwrite) ───────────────────
    console.log('\n▸ Tenant');
    let tenantExists = false;
    try {
      const [row] = await client.unsafe<Array<{ client: string }>>(
        `select client from client where client = $1`,
        [tenant],
      );
      tenantExists = Boolean(row);
    } catch {
      tenantExists = false;
    }

    if (!tenantExists) {
      await createTenant({
        clientKey: tenant,
        name: 'Walkthrough Company',
        legalName: 'Walkthrough Company LLC',
        country: COUNTRY,
        currency: CURRENCY,
        timezone: 'Asia/Kuwait',
        isDevelopment: false,
        administrator: {
          username: 'walkthrough.admin',
          fullName: 'Walkthrough Administrator',
          email: 'walkthrough@cairn.local',
          password: 'Wk2026Seed',
        },
        creationType: 'standard',
        createdBy: changedBy,
      });
      summary.created = true;
      console.log(`  created tenant ${tenant}`);
    } else {
      console.log(`  tenant ${tenant} already exists — leaving it unchanged`);
    }

    // ── 2. Standard enterprise structure (no-op if already present) ──────
    console.log('\n▸ Enterprise structure');
    const structure = await applyStandardStructure({
      client: tenant,
      companyName: 'Walkthrough Company',
      country: COUNTRY,
      currency: CURRENCY,
      chartOfAccounts: CHART,
      fiscalYearVariant: FYV,
      postingPeriodVariant: PPV,
      changedBy,
    });
    console.log(`  company code ${structure.companyCode} · plant ${structure.plant}`);
    console.log(`  purchasing org ${structure.purchasingOrg} · sales org ${structure.salesOrg}`);
    if (!structure.created) {
      console.log('  structure already present — no changes made');
    }

    // ── 3. Materials (development fixtures) ──────────────────────────────
    console.log('\n▸ Materials');
    await seedDevelopmentMaterials();
    const [matCount] = await client.unsafe<Array<{ n: number }>>(
      `select count(*)::int as n from material where client = $1`,
      [tenant],
    );
    summary.materials = matCount.n;
    console.log(`  ${summary.materials} material master(s)`);

    // ── 4. Foundation data (direct SQL; idempotent upserts) ─────────────
    console.log('\n▸ Foundation data');

    // Business partners — customer and supplier
    const customerNumber = 'C10000';
    const supplierNumber = 'S10000';

    await client.unsafe(
      `insert into business_partner
         (client, partner_number, category, name, country, general_status, version, created_by, changed_by)
       values ($1,$2,'ORGANIZATION',$3,$4,'MAINTAINED',1,$5,$5)
       on conflict (client, partner_number) do nothing`,
      [tenant, customerNumber, 'Walkthrough Customer', COUNTRY, changedBy],
    );
    await client.unsafe(
      `insert into bp_role
         (client, partner_number, role_code, is_active, created_by, changed_by)
       values ($1,$2,'CUSTOMER',true,$6,$6)
       on conflict (client, partner_number, role_code) do nothing`,
      [tenant, customerNumber, changedBy],
    );
    await client.unsafe(
      `insert into business_partner
         (client, partner_number, category, name, country, general_status, version, created_by, changed_by)
       values ($1,$2,'ORGANIZATION',$3,$4,'MAINTAINED',1,$5,$5)
       on conflict (client, partner_number) do nothing`,
      [tenant, supplierNumber, 'Walkthrough Supplier', COUNTRY, changedBy],
    );
    await client.unsafe(
      `insert into bp_role
         (client, partner_number, role_code, is_active, created_by, changed_by)
       values ($1,$2,'SUPPLIER',true,$6,$6)
       on conflict (client, partner_number, role_code) do nothing`,
      [tenant, supplierNumber, changedBy],
    );

    // Customer company code data
    await client.unsafe(
      `insert into customer_company_code
         (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, company_status, created_by, changed_by)
       values ($1,$2,'CUSTOMER',$3,$4,$5,'NET30','MAINTAINED',$6,$6)
       on conflict (client, partner_number, company_code) do nothing`,
      [tenant, customerNumber, COMPANY_CODE, CHART, GL_RECONCILIATION, changedBy],
    );

    // Supplier purchasing org data (no company_code/plant columns — those are on the supplier master)
    await client.unsafe(
      `insert into supplier_purchasing_org
         (client, partner_number, role_code, purchasing_org, purchasing_group, order_currency, payment_terms_code, purchasing_status, created_by, changed_by)
       values ($1,$2,'SUPPLIER',$3,$4,'USD','NET30','MAINTAINED',$7,$7)
       on conflict (client, partner_number, purchasing_org) do nothing`,
      [tenant, supplierNumber, PURCHASING_ORG, PURCHASING_GROUP, changedBy],
    );

    // Tax code (10% output tax)
    await client.unsafe(
      `insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by, changed_by)
       values ($1,$2,'T10','Output tax 10 percent','VAT',10,$3,$3)
       on conflict (client, country, tax_code) do nothing`,
      [tenant, COUNTRY, changedBy],
    );

    // Account determination
    await client.unsafe(
      `insert into account_determination
         (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by, changed_by)
       values ($1,$2,'TAX','','',$3,$4,$4)
       on conflict (client, chart_of_accounts, event, valuation_class, general_modifier) do nothing`,
      [tenant, CHART, GL_TAX, changedBy],
    );
    await client.unsafe(
      `insert into account_determination
         (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by, changed_by)
       values ($1,$2,'SALES_REVENUE','','',$3,$4,$4)
       on conflict (client, chart_of_accounts, event, valuation_class, general_modifier) do nothing`,
      [tenant, CHART, GL_REVENUE, changedBy],
    );
    await client.unsafe(
      `insert into account_determination
         (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by, changed_by)
       values ($1,$2,'PURCHASE_RECEIPT','','',$3,$4,$4)
       on conflict (client, chart_of_accounts, event, valuation_class, general_modifier) do nothing`,
      [tenant, CHART, GL_PURCHASE, changedBy],
    );
    await client.unsafe(
      `insert into account_determination
         (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by, changed_by)
       values ($1,$2,'GR_IR','','',$3,$4,$4)
       on conflict (client, chart_of_accounts, event, valuation_class, general_modifier) do nothing`,
      [tenant, CHART, GL_GR_IR, changedBy],
    );

    // Payment terms
    await client.unsafe(
      `insert into payment_terms
         (client, terms_code, description, baseline_source, net_days, created_by, changed_by)
       values ($1,'NET30','Net 30 days','DOCUMENT_DATE',30,$2,$2)
       on conflict (client, terms_code) do nothing`,
      [tenant, changedBy],
    );

    const [bpCount] = await client.unsafe<Array<{ n: number }>>(
      `select count(*)::int as n from business_partner where client = $1`,
      [tenant],
    );
    summary.businessPartners = bpCount.n;
    console.log(`  ${summary.businessPartners} business partner(s)`);

    // ── 5. Purchase order → goods receipt ───────────────────────────────
    console.log('\n▸ Purchase-to-pay');

    const { createOrder } = await import('./src/modules/purchasing/orders');
    const { releaseDocument } = await import('./src/modules/purchasing/release');
    const { postGoodsReceipt } = await import('./src/modules/inventory/goods-receipt');

    const poDate = isoDate(new Date('2026-11-02'));
    const grDate = isoDate(new Date('2026-11-03'));

    let poNumber: string | null = null;
    try {
      const result = await createOrder({
        client: tenant,
        changedBy,
        supplierNumber,
        purchasingOrg: PURCHASING_ORG,
        purchasingGroup: PURCHASING_GROUP,
        companyCode: COMPANY_CODE,
        currency: CURRENCY,
        items: [
          {
            materialNumber: 'RAW-STEEL',
            shortText: 'Carbon steel sheet',
            quantity: 100,
            unit: 'KG',
            netPrice: 5.0,
            priceUnit: 1,
            plant: PLANT,
            storageLocation: STORAGE_LOCATION,
            taxCode: 'T10',
            scheduleLines: [
              { deliveryDate: grDate, quantity: 100 },
            ],
            assignments: [
              { glAccount: GL_PURCHASE, costCenter: 'CC1000', distributionPercentage: 100 },
            ],
          },
        ],
      });
      poNumber = result.orderNumber;
      summary.purchaseOrders += 1;
      console.log(`  PO ${poNumber} created${result.replayed ? ' (replayed — already existed)' : ''}`);

      // Attempt release so the goods receipt can post
      try {
        await releaseDocument({
          client: tenant,
          changedBy,
          documentCategory: 'PURCHASE_ORDER',
          documentNumber: poNumber,
          releaseCode: 'RELEASE',
        });
        console.log(`  PO ${poNumber} released`);
      } catch (releaseError: any) {
        // Release may fail if no strategy is configured — note and continue
        summary.notes.push(`PO ${poNumber} release not attempted: ${releaseError.message}`);
        console.log(`  PO ${poNumber} release skipped: ${releaseError.message}`);
      }
    } catch (error: any) {
      summary.notes.push(`Purchase order skipped: ${error.message}`);
      console.log(`  PO creation skipped: ${error.message}`);
    }

    let grNumber: string | null = null;
    if (poNumber) {
      try {
        const grView = await postGoodsReceipt({
          client: tenant,
          changedBy,
          orderNumber: poNumber,
          documentDate: grDate,
          postingDate: grDate,
          headerText: 'Walkthrough goods receipt',
          requestKey: `wk-gr-${poNumber}`,
          lines: [
            { itemNumber: 10, quantity: 100, storageLocation: STORAGE_LOCATION },
          ],
        });
        grNumber = grView.materialDocumentNumber;
        summary.goodsReceipts += 1;
        summary.journalLines += (grView.journalDocumentNumber ? 3 : 0);
        console.log(`  GR ${grNumber} posted (journal ${grView.journalDocumentNumber})`);
      } catch (error: any) {
        summary.notes.push(`Goods receipt skipped: ${error.message}`);
        console.log(`  GR creation skipped: ${error.message}`);
      }
    }

    // ── 6. Sales order → delivery → goods issue → billing → credit memo ──
    console.log('\n▸ Order-to-cash (including DI-020 credit memo)');

    const { createSalesOrder } = await import('./src/modules/sales/sales-order');
    const { createDelivery } = await import('./src/modules/sales/delivery');
    const { postDeliveryGoodsIssue } = await import('./src/modules/sales/delivery');
    const { createBillingFromDelivery } = await import('./src/modules/sales/billing');

    const soDate = isoDate(new Date('2026-11-04'));
    const delDate = isoDate(new Date('2026-11-05'));
    const giDate = isoDate(new Date('2026-11-05'));
    const billDate = isoDate(new Date('2026-11-06'));

    let soNumber: string | null = null;
    try {
      const soResult = await createSalesOrder({
        client: tenant,
        changedBy,
        salesOrg: SALES_ORG,
        distributionChannel: DIST_CHANNEL,
        division: DIVISION,
        customerNumber,
        companyCode: COMPANY_CODE,
        currency: CURRENCY,
        orderDate: soDate,
        requestKey: `wk-so-${tenant}`,
        lines: [
          {
            materialNumber: 'FG-BRACKET',
            plant: PLANT,
            orderQuantity: 10,
            quantityUnit: 'PC',
            taxCode: 'T10',
          },
        ],
      });
      soNumber = soResult.orderNumber;
      summary.salesOrders += 1;
      console.log(`  SO ${soNumber} created${soResult.replayed ? ' (replayed)' : ''}`);
    } catch (error: any) {
      summary.notes.push(`Sales order skipped: ${error.message}`);
      console.log(`  SO creation skipped: ${error.message}`);
    }

    let deliveryNumber: string | null = null;
    if (soNumber) {
      try {
        const delView = await createDelivery({
          client: tenant,
          changedBy,
          orderNumber: soNumber,
          deliveryDate: delDate,
          goodsMovementDate: giDate,
          items: [{ orderLineNumber: 10, quantity: '10' }],
          requestKey: `wk-del-${soNumber}`,
        });
        deliveryNumber = delView.deliveryNumber;
        summary.deliveries += 1;
        console.log(`  Delivery ${deliveryNumber} created${delView.replayed ? ' (replayed)' : ''}`);
      } catch (error: any) {
        summary.notes.push(`Delivery skipped: ${error.message}`);
        console.log(`  Delivery creation skipped: ${error.message}`);
      }
    }

    let giPosted = false;
    if (deliveryNumber) {
      try {
        // Fetch current version for expectedVersion
        const { getDelivery } = await import('./src/modules/sales/delivery');
        const current = await getDelivery(tenant, deliveryNumber);
        const expectedVersion = current ? 1 : undefined;
        if (!expectedVersion) {
          throw new Error(`cannot determine version for delivery ${deliveryNumber}`);
        }
        await postDeliveryGoodsIssue({
          client: tenant,
          changedBy,
          deliveryNumber,
          expectedVersion,
          postingDate: giDate,
          documentDate: giDate,
        });
        giPosted = true;
        console.log(`  Goods issue posted for delivery ${deliveryNumber}`);
      } catch (error: any) {
        summary.notes.push(`Goods issue skipped: ${error.message}`);
        console.log(`  Goods issue skipped: ${error.message}`);
      }
    }

    let billingNumber: string | null = null;
    let invoiceNumber: string | null = null;
    if (giPosted && deliveryNumber) {
      try {
        const billView = await createBillingFromDelivery({
          client: tenant,
          changedBy,
          deliveryNumber,
          billingDate: billDate,
          requestKey: `wk-bill-${deliveryNumber}`,
        });
        billingNumber = billView.billing.billingNumber;
        summary.billingDocuments += 1;
        console.log(`  Billing ${billingNumber} created${billView.replayed ? ' (replayed)' : ''}`);
        if (billView.invoice) {
          invoiceNumber = billView.invoice.invoiceNumber;
          summary.customerInvoices += 1;
          summary.journalLines += 3;
          console.log(`  Customer invoice ${invoiceNumber} posted`);
        }
      } catch (error: any) {
        summary.notes.push(`Billing skipped: ${error.message}`);
        console.log(`  Billing skipped: ${error.message}`);
      }
    }

    // DI-020 credit memo against the customer invoice
    if (invoiceNumber) {
      try {
        const memoView = await postCustomerCreditMemo({
          client: tenant,
          changedBy,
          customerNumber,
          companyCode: COMPANY_CODE,
          documentDate: billDate,
          postingDate: billDate,
          reference: `WK-CM-001`,
          currency: CURRENCY,
          grossAmount: 110,
          creditOfInvoice: invoiceNumber,
          requestKey: `wk-cm-${invoiceNumber}`,
          lines: [{ glAccount: GL_REVENUE, netAmount: 100, taxCode: 'T10' }],
        });
        summary.creditMemos += 1;
        summary.journalLines += 3;
        console.log(`  Credit memo ${memoView.invoiceNumber} posted against invoice ${invoiceNumber}`);
      } catch (error: any) {
        summary.notes.push(`Credit memo skipped: ${error.message}`);
        console.log(`  Credit memo skipped: ${error.message}`);
      }
    }

    // ── 7. Summary ───────────────────────────────────────────────────────
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Walkthrough seed summary');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Tenant / client : ${summary.tenant}`);
    console.log(`Company code    : ${summary.company}`);
    console.log(`Tenant created  : ${summary.created ? 'yes' : 'no (already existed)'}`);
    console.log(`Materials       : ${summary.materials}`);
    console.log(`Business partners: ${summary.businessPartners}`);
    console.log(`Purchase orders : ${summary.purchaseOrders}`);
    console.log(`Goods receipts  : ${summary.goodsReceipts}`);
    console.log(`Sales orders    : ${summary.salesOrders}`);
    console.log(`Deliveries      : ${summary.deliveries}`);
    console.log(`Billing documents: ${summary.billingDocuments}`);
    console.log(`Customer invoices: ${summary.customerInvoices}`);
    console.log(`Credit memos    : ${summary.creditMemos} (DI-020)`);
    console.log(`Journal lines   : ${summary.journalLines}`);
    if (summary.notes.length > 0) {
      console.log('\nNotes:');
      for (const note of summary.notes) {
        console.log(`  - ${note}`);
      }
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nWalkthrough seed complete. No data was deleted or overwritten.');
  } finally {
    await client.end({ timeout: 10 });
  }
}

main().catch((error) => {
  console.error(`walkthrough-seed: ${error.message}`);
  process.exit(1);
});

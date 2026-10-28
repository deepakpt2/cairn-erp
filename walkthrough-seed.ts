/**
 * Cairn ERP — walkthrough seed (standalone; not run by build, migrate or seed).
 *
 * Creates a fictional Indian company with an April–March fiscal year,
 * a complete standing configuration + master data, and real transaction
 * history posted through the application's own services, so every
 * implemented transaction/report can be used immediately after login
 * without entering any master data first.
 *
 * This file lives in the repository root. In the Docker deployment the
 * operations image bakes it in (COPY . .) and docker-compose.yml also
 * mounts the host copy over /app/walkthrough-seed.ts for the migrate
 * service, so the host file is what runs — no rebuild needed to refresh it.
 *
 * DOCKER (the normal path, after `docker compose up -d` has completed
 * and the migrate service has finished on the fresh database):
 *
 *   git pull   # walkthrough-seed.ts must stand next to docker-compose.yml
 *   docker compose run --rm migrate npx tsx walkthrough-seed.ts
 *   docker compose run --rm migrate npx tsx walkthrough-seed.ts --client=W100
 *
 * If the run answers "Cannot find module '/app/walkthrough-seed.ts'",
 * the host file or the operations image predates this seed: confirm
 * `ls walkthrough-seed.ts` succeeds beside docker-compose.yml, then
 * bake the current tree into the image and run again:
 *
 *   docker compose build migrate
 *   docker compose run --rm migrate npx tsx walkthrough-seed.ts
 *
 * Do NOT run it in the `app` container (runtime-only image, no source or
 * tsx) and do NOT source .env.local inside a container — Compose already
 * injects the correct DATABASE_URL for the operations image.
 *
 * BARE METAL (from the repository root of a fresh checkout):
 *
 *   npm run db:migrate && npm run seed:reference && npm run seed
 *   set -a; . ./.env.local; set +a
 *   npx tsx walkthrough-seed.ts                      # default tenant key 0100
 *
 * Login afterwards: tenant <client key>, user `admin`, password printed
 * at the end of the run (and defined as ADMIN_PASSWORD below).
 * Re-running against the same tenant key is refused safely.
 */
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from './src/platform/db/client';
import { createTenant } from './src/platform/tenancy';
import { applyStandardStructure } from './src/platform/tenancy/standard-structure';
import { maintainNumberRange } from './src/modules/foundation/number-ranges';
import { defineRange } from './src/platform/numbering';
import { postJournalEntry } from './src/platform/posting';
import { createOrder } from './src/modules/purchasing/orders';
import { postGoodsReceipt } from './src/modules/inventory/goods-receipt';
import { postSupplierInvoice } from './src/modules/purchasing/invoice-verification';
import { initializeMaterialPeriodControl, getMaterialPeriodControl, shiftMaterialPeriod } from './src/modules/inventory/material-period-control';
import { createPaymentRun, generateProposal, executePaymentRun } from './src/modules/finance/payment-run';
import { postCustomerInvoice } from './src/modules/finance/customer-invoice';
import { hashPassword, checkPasswordPolicy } from './src/platform/auth/password';
import { getMaterialDetail, saveMaterialView } from './src/modules/inventory/materials';
import { createRequisition, getRequisition } from './src/modules/purchasing/requisitions';
import { createRequestForQuotation } from './src/modules/purchasing/rfq';
import { createQuotation, openQuotation } from './src/modules/purchasing/quotation';
import { compareQuotations } from './src/modules/purchasing/quotation-comparison';
import { createPurchaseContract } from './src/modules/purchasing/contract';
import { createSchedulingAgreement } from './src/modules/purchasing/scheduling-agreement';
import {
  assignReleaseProfile, createSchedulingAgreementReleases, saveReleaseProfile,
} from './src/modules/purchasing/scheduling-agreement-release';
import { maintainDeliverySchedule } from './src/modules/purchasing/scheduling-agreement-schedule';
import { createPurchasingInfoRecord } from './src/modules/purchasing/info-record';
import { createSourceListEntry } from './src/modules/purchasing/source-list';
import { createQuotaArrangement } from './src/modules/purchasing/quota-arrangement';
import { getDocumentRelease, releaseDocument } from './src/modules/purchasing/release';
import { parkSupplierInvoice } from './src/modules/purchasing/parked-invoice';
import { placePaymentBlock, releasePaymentBlock } from './src/modules/purchasing/blocked-invoice';
import { listGrIrMaintenance, listGrIrResiduals, postGrIrClearing, reverseGrIrClearing } from './src/modules/purchasing/grir-clearing';
import { saveManualScore } from './src/modules/purchasing/vendor-evaluation';
import { openPurchaseOrderDisplay } from './src/modules/purchasing/purchase-order-display';
import {
  saveReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus,
} from './src/modules/foundation/release-strategy-definition';
import { postVendorDownPayment } from './src/modules/finance/vendor-down-payment';
import { clearDownPayments, getDownPaymentClearing } from './src/modules/finance/vendor-down-payment-clearing';
import { createVendorDownPaymentRequest } from './src/modules/finance/vendor-down-payment-request';
import { postVendorCreditMemo } from './src/modules/finance/vendor-credit-memo';
import { postVendorInvoice } from './src/modules/finance/vendor-invoice';
import { executeGrIrAnalysis } from './src/modules/finance/grir-reclass';
import { postGoodsIssue } from './src/modules/inventory/goods-issue';
import { reverseGoodsReceipt } from './src/modules/inventory/goods-receipt';
import { listMaterialDocuments } from './src/modules/inventory/material-document-list';
import { getCountStatus, submitCounts } from './src/modules/inventory/physical-inventory-count';
import { getDifferenceDocument, listDifferences } from './src/modules/inventory/physical-inventory-differences';
import { postDifferences } from './src/modules/inventory/physical-inventory-posting';
import { createRecount, getRecountSource } from './src/modules/inventory/physical-inventory-recount';
import { createPhysicalInventory } from './src/modules/inventory/physical-inventory';
import { changeMaterialPrice, listFuturePrices } from './src/modules/inventory/price-change';
import { createProductionOrder, releaseProductionOrder } from './src/modules/inventory/production-orders';
import { postProductionReceipt } from './src/modules/inventory/production-receipt';
import { createReservation, getReservation } from './src/modules/inventory/reservations';
import { getReturnableDocument, postReturnDelivery } from './src/modules/inventory/return-delivery';
import { stockOverview } from './src/modules/inventory/stock-overview';
import { stockOnPostingDate } from './src/modules/inventory/stock-posting-date';
import { postTransfer, reverseTransfer } from './src/modules/inventory/transfer-posting';
import { listAvailabilityCheck } from './src/modules/production/availability-check';
import { saveCheckingControl } from './src/modules/production/checking-control';
import { saveCheckingRule } from './src/modules/production/availability-check';
import { cancelConfirmation, loadConfirmationCancellation } from './src/modules/production/confirmation-cancel';
import { createMaterialBom, getMaterialBom, listMaterialBoms, saveBomItemCategory, saveBomStatus, saveBomUsage } from './src/modules/production/material-bom';
import { explodePlannedSupply } from './src/modules/production/mrp-explosion';
import { getMrpRun, listMrpRuns, planMaterials, planSingleItem } from './src/modules/production/mrp-run';
import { checkOrderAvailability } from './src/modules/production/order-availability';
import { enterOrderConfirmation, previewOrderConfirmation } from './src/modules/production/order-confirmation';
import { saveOrderTypeParameter } from './src/modules/production/order-type-parameters';
import { convertPlannedOrder, listConversionLog, listConvertiblePlannedOrders } from './src/modules/production/planned-order-conversion';
import { createPlannedOrder } from './src/modules/production/planned-order-create';
import { getPlannedOrder, listPlannedOrders } from './src/modules/production/planned-order-display';
import { technicallyCompleteProductionOrder } from './src/modules/production/production-order-change';
import { getProductionOrderDisplay, listProductionOrders } from './src/modules/production/production-order-display';
import { saveProductionOrderType } from './src/modules/production/production-order-type';
import { checkProductionVersion, createProductionVersion, getProductionVersion, lockProductionVersion } from './src/modules/production/production-version';
import { createRouting, getRouting, listRoutings, saveRoutingControlKey, saveRoutingStandardValueKey, saveRoutingStatus, saveRoutingTaskListType, saveRoutingUsage } from './src/modules/production/routing';
import { stockRequirementsList } from './src/modules/production/stock-requirements';
import { enterTimeTicket } from './src/modules/production/time-ticket';
import { createWorkCenter, listWorkCenters, saveWorkCenterCategory } from './src/modules/production/work-center';
import { getLot, listInspectableLines, listLots, openLot } from './src/modules/quality/lot';

import { maintainSpecialGlConfig } from './src/modules/foundation/special-gl';
import { saveBatchLevel } from './src/modules/inventory/batch-level';
import { createBatch } from './src/modules/inventory/batch-master';
import { saveCharacteristic } from './src/modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from './src/modules/foundation/class-definition';
import { postIncomingPayment } from './src/modules/finance/incoming-payment';
import { calculateCashflow } from './src/modules/finance/cash-flow';

const ACTOR = 'WALKTHROUGH';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Meridian-2026-admin';
const COMPANY = '1000';
const COMPANY_NAME = 'Meridian Auto Components Pvt Ltd';

const argClient = process.argv.find((a) => a.startsWith('--client='))?.split('=')[1];
const CLIENT = (argClient ?? '0100').toUpperCase();

/** April–March fiscal calendar: FY named by its April start year. */
function fyPeriod(isoDate: string): { fiscalYear: number; period: number } {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  return m >= 4 ? { fiscalYear: y, period: m - 3 } : { fiscalYear: y - 1, period: m + 9 };
}

/** The second company code: intercompany, consolidation, a second set of open items. */
const SECOND_COMPANY = '2000';
const SECOND_COMPANY_NAME = 'Meridian Logistics Pvt Ltd';
const SECOND_CONTROLLING_AREA = 'A200';
/** The one sales area the standard structure builds: sales org 1000, channel 01, division 01. */
const SALES_AREA = { salesOrg: '1000', distributionChannel: '01', division: '01' };
/** Shared by every area login created below, so one password opens the whole walkthrough. */
const DEMO_PASSWORD = 'Meridian-2026-demo';

/** What a section put on screen, printed at the end against `implemented-functions.md`. */
const COVERED: Array<{ area: string; code: string; detail: string }> = [];
const SKIPPED: Array<{ step: string; reason: string }> = [];

function cover(area: string, code: string, detail: string) {
  COVERED.push({ area, code, detail });
}

function warn(step: string, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  SKIPPED.push({ step, reason });
  console.log(`  ! ${step} skipped: ${reason}`);
}

/** Same message shape as warn(), for the sections that guard themselves. */
function skip(step: string, error: unknown) {
  warn(step, error);
}

/** What every extended section is handed: the tenant, its company code, and the standing accounts. */
interface Walk {
  client: string;
  company: string;
  actor: string;
  accounts: { bank: string; recv: string; pay: string; revenue: string; equity: string; inventory: string; grIr: string };
}

/** One login per area, on the system role whose capabilities that area needs. */
const DEMO_USERS: Array<{ username: string; role: string; fullName: string; for: string }> = [
  { username: 'configurator', role: 'CONFIGURATOR', fullName: 'Structure Configurator', for: 'the configuration workbench' },
  { username: 'buyer', role: 'BUYER', fullName: 'Anita Bhosale (Buyer)', for: 'requisitions, orders, invoices' },
  { username: 'warehouse', role: 'WAREHOUSE_CLERK', fullName: 'Sunita Rane (Warehouse)', for: 'goods movement and inventory' },
  { username: 'planner', role: 'PLANNER', fullName: 'Vikram Setu (Planner)', for: 'MRP, planned orders, availability' },
  { username: 'production', role: 'PRODUCTION_CLERK', fullName: 'Imran Qureshi (Production)', for: 'confirmations and time tickets' },
  { username: 'quality', role: 'WAREHOUSE_CLERK', fullName: 'Meera Nair (Quality)', for: 'inspection lots' },
  { username: 'sales', role: 'SALES_CLERK', fullName: 'Rahul Deshpande (Sales)', for: 'orders, deliveries, billing' },
  { username: 'accountant', role: 'ACCOUNTANT', fullName: 'Farida Khan (Accountant)', for: 'journals, clearing, payments' },
  { username: 'controller', role: 'CONTROLLER', fullName: 'Ganesh Iyer (Controller)', for: 'cost centres, orders, reports' },
  { username: 'auditor', role: 'AUDITOR', fullName: 'External Audit Firm', for: 'read-only review of everything above' },
];

/** Plants beyond the one the standard structure builds, and their stores. */
const EXTRA_PLANTS: Array<{ plant: string; name: string; city: string; production: boolean; storage: boolean }> = [
  { plant: '1100', name: 'Meridian Assembly (Nashik)', city: 'Nashik', production: true, storage: true },
  { plant: '1200', name: 'Meridian Distribution (Chennai)', city: 'Chennai', production: false, storage: true },
];
const EXTRA_STORES: Record<string, Array<[string, string]>> = {
  '1000': [['0004', 'Quality hold'], ['0005', 'Returns floor']],
  '1100': [['0001', 'Assembly inputs'], ['0003', 'Assembly output'], ['0099', 'Goods receipt area']],
  '1200': [['0001', 'Distribution main'], ['0002', 'Duty deferred'], ['0099', 'Goods receipt area']],
};

const COST_CENTRES: Array<[string, string, string]> = [
  ['MACH', 'Machining Pune', 'PRODUCTION'],
  ['ASSY', 'Assembly Nashik', 'PRODUCTION'],
  ['QA', 'Quality Assurance', 'ADMINISTRATION'],
  ['LOG', 'Logistics and Stores', 'ADMINISTRATION'],
  ['SALES', 'Sales and Distribution', 'SALES'],
  ['PUR', 'Purchasing', 'ADMINISTRATION'],
  ['ADM', 'Administration', 'ADMINISTRATION'],
  ['PROD', 'Production', 'PRODUCTION'],
];
const PROFIT_CENTRES: Array<[string, string, string]> = [
  ['PUNE', 'Machining Pune', 'AUTO'],
  ['NASHIK', 'Assembly Nashik', 'AUTO'],
  ['DIST', 'Distribution', 'AUTO'],
  ['TRADE', 'Trading goods', 'TRADE'],
  ['LOG2', 'Logistics 2000', 'LOGI'],
];
/** Cost centres that belong to the second company's controlling area. */
const SECOND_AREA_CENTRES: Array<[string, string, string]> = [
  ['FLEET', 'Fleet operations', 'ADMINISTRATION'],
  ['WARE2', 'Chennai warehouse', 'ADMINISTRATION'],
];

async function seedPeople(w: Walk) {
  const issue = checkPasswordPolicy(DEMO_PASSWORD);
  if (issue) throw new Error(`demo password is not policy-compliant: ${issue}`);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await withTenant(w.client, async (tx) => {
    for (const user of DEMO_USERS) {
      await tx.execute(sql`
        insert into app_user (id, client, username, full_name, email, password_hash, is_active, created_by)
        values (${`walkthrough-${user.username}`.slice(0, 36)}, ${w.client}, ${user.username}, ${user.fullName},
                ${`${user.username}@meridian.example`}, ${passwordHash}, true, ${w.actor})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into user_role (client, user_id, role_code, created_by)
        select ${w.client}, id, ${user.role}, ${w.actor} from app_user
         where client = ${w.client} and username = ${user.username}
        on conflict do nothing
      `);
    }
  });
  console.log(`  ${DEMO_USERS.length} area logins stand (password ${DEMO_PASSWORD})`);
  cover('Platform', 'CFG.PLT.ROLE.DEFINE', `${DEMO_USERS.length} users across 9 system roles`);
  cover('Platform', 'PLT.LOCK.DISPLAY', 'documents below hold and release object locks');
}

async function seedOrganisation(w: Walk) {
  await withTenant(w.client, async (tx) => {
    for (const p of EXTRA_PLANTS) {
      // The plant row carries its company code directly, which is what the standard structure builder writes.
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, city, is_production_site, is_storage_site, is_active, created_by)
        values (${w.client}, ${p.plant}, ${p.name}, ${w.company}, 'IN', ${p.city}, ${p.production}, ${p.storage}, true, ${w.actor})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
        values (${w.client}, ${w.company}, ${p.plant}, ${w.actor}) on conflict do nothing
      `);
    }
    /* The stores come after the plants: storage_location is keyed on a plant that must already stand. */
    for (const [plant, entries] of Object.entries(EXTRA_STORES)) {
      for (const [code, name] of entries) {
        await tx.execute(sql`
          insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
          values (${w.client}, ${plant}, ${code}, ${name}, false, true, ${w.actor})
          on conflict do nothing
        `);
      }
    }
  });

  /* The controlling area follows the tenant onto the April-March variant, so both companies read one calendar. */
  await withTenant(w.client, (tx) => tx.execute(sql`
    update controlling_area set fiscal_year_variant = 'V3', changed_by = ${w.actor}, changed_at = now()
     where client = ${w.client} and controlling_area = 'A000'
  `));

  /* A second company code, written the way the standard structure builder writes the first.
     It gets its own controlling area because A000 is scoped to a single company code — that scope is
     enforced when a company is assigned, so a second company cannot share it. */
  await withTenant(w.client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
                                currency, country, city, language, tax_registration_number, credit_control_area,
                                intercompany_clearing_account, is_active, created_by)
      values (${w.client}, ${SECOND_COMPANY}, ${SECOND_COMPANY_NAME}, 'CA01', 'V3', 'C001', 'INR', 'IN', 'Chennai', 'EN',
              '33AAXXM0000B1Z7', '0001', '110100', true, ${w.actor})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into controlling_area (client, controlling_area, name, organization_name, company_code_scope, currency,
                                    fiscal_year_variant, is_active, created_by)
      values (${w.client}, ${SECOND_CONTROLLING_AREA}, 'Meridian Logistics Controlling', ${SECOND_COMPANY_NAME}, 'SINGLE',
              'INR', 'V3', true, ${w.actor})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into controlling_area_company (client, controlling_area, company_code, created_by)
      values (${w.client}, ${SECOND_CONTROLLING_AREA}, ${SECOND_COMPANY}, ${w.actor}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${w.client}, ${SECOND_COMPANY}, 'HB01', 'IN', 'HDFC01', ${w.actor}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${w.client}, ${SECOND_COMPANY}, 'HB01', 'MAIN', '50200098765432', 'INR', ${w.accounts.bank}, ${w.actor})
      on conflict do nothing
    `);
    for (const [key, name, category] of COST_CENTRES) {
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
        values (${w.client}, 'A000', ${key}, '2026-04-01', '9999-12-31', ${name}, ${category}, ${w.company}, ${w.actor})
        on conflict do nothing
      `);
    }
    for (const [key, name, segment] of PROFIT_CENTRES) {
      await tx.execute(sql`
        insert into profit_center (client, controlling_area, profit_center, valid_from, valid_to, name, segment, created_by)
        values (${w.client}, 'A000', ${key}, '2026-04-01', '9999-12-31', ${name}, ${segment}, ${w.actor})
        on conflict do nothing
      `);
    }
    for (const [key, name, category] of SECOND_AREA_CENTRES) {
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
        values (${w.client}, ${SECOND_CONTROLLING_AREA}, ${key}, '2026-04-01', '9999-12-31', ${name}, ${category},
                ${SECOND_COMPANY}, ${w.actor})
        on conflict do nothing
      `);
    }
    /* Activity types the work centres and confirmations price against. */
    /* Category 3 is a manual activity type and price indicator 1 reads the planned price; both are
       single-character codes on this table, not the four-digit SAP form the screens show. */
    for (const [code, name] of [['MACH', 'Machining hour'], ['ASSY', 'Assembly hour'], ['INSP', 'Inspection hour'], ['SERV', 'Service hour']] as Array<[string, string]>) {
      await tx.execute(sql`
        insert into activity_type (client, controlling_area, activity_type, valid_from, valid_to, name, activity_unit, category, price_indicator, created_by)
        values (${w.client}, 'A000', ${code}, '2026-04-01', '9999-12-31', ${name}, 'HR', '3', '1', ${w.actor})
        on conflict do nothing
      `);
    }
    /* Planned activity prices (KP26) for the whole fiscal year, per centre and type. */
    for (const period of Array.from({ length: 12 }, (_, i) => i + 1)) {
      for (const [centre, type, fixed, variable] of [
        ['MACH', 'MACH', '420', '310'], ['ASSY', 'ASSY', '260', '190'],
        ['QA', 'INSP', '180', '120'], ['LOG', 'SERV', '150', '90'],
      ] as Array<[string, string, string, string]>) {
        await tx.execute(sql`
          insert into activity_rate (client, controlling_area, plan_version, fiscal_year, period, cost_center, activity_type,
                                     fixed_price, variable_price, price_unit, created_by)
          values (${w.client}, 'A000', '0', 2026, ${period}, ${centre}, ${type}, ${fixed}, ${variable}, 1, ${w.actor})
          on conflict do nothing
        `);
      }
    }
    /* Exchange rates: the FX valuation and a foreign-currency supplier invoice need them. */
    for (const [from, to, rate] of [['USD', 'INR', '83.20'], ['EUR', 'INR', '90.40'], ['AED', 'INR', '22.65']] as Array<[string, string, string]>) {
      await tx.execute(sql`
        insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, ratio_from, ratio_to, created_by)
        values (${w.client}, 'M', ${from}, ${to}, '2026-04-01', ${rate}, 1, 1, ${w.actor}) on conflict do nothing
      `);
    }
  });

  console.log(`  organisation: 3 plants, ${COST_CENTRES.length + SECOND_AREA_CENTRES.length} cost centres, ${PROFIT_CENTRES.length} profit centres, activity prices, exchange rates, company ${SECOND_COMPANY} on ${SECOND_CONTROLLING_AREA}`);
  cover('Foundation', 'CFG.ORG.PLANT.DEFINE', 'plants 1000 / 1100 / 1200');
  cover('Foundation', 'CFG.ORG.STORAGELOC.DEFINE', `${Object.values(EXTRA_STORES).flat().length} storage locations`);
  cover('Controlling (CO)', 'CFG.COST.COSTCENTER.DEFINE', `${COST_CENTRES.length} cost centres in A000`);
  cover('Controlling (CO)', 'CFG.COST.PROFITCENTER.DEFINE', `${PROFIT_CENTRES.length} profit centres`);
  cover('Controlling (CO)', 'CFG.COST.ACTIVITYTYPE.DEFINE', '4 activity types, hourly');
  cover('Controlling (CO)', 'CFG.COST.ACTIVITYRATE.CONFIRM', '12 planned periods × 4 centre/type pairs');
  cover('Finance (FI)', 'CFG.FIN.EXCHRATE.DEFINE', 'USD, EUR, AED against INR');
  cover('Finance (FI)', 'FIN.ORG.COMPANYCODE.DEFINE', `company codes ${w.company} and ${SECOND_COMPANY}`);
}

async function seedFinanceConfig(w: Walk) {
  await withTenant(w.client, async (tx) => {
    /* Output and input tax codes with the account key the tax report groups by. */
    for (const [code, name, type, rate, key] of [
      ['G18', 'GST output 18 percent', 'GST', '18', 'TAX'],
      ['G12', 'GST output 12 percent', 'GST', '12', 'TAX'],
      ['G05', 'GST output 5 percent', 'GST', '5', 'TAX'],
      ['G0', 'GST zero rated', 'GST', '0', 'TAX'],
      ['I18', 'GST input 18 percent', 'GST', '18', 'TAX'],
      ['I05', 'GST input 5 percent', 'GST', '5', 'TAX'],
      ['TDS1', 'Tax deducted at source 1 percent', 'TDS', '1', 'TAX'],
    ] as Array<[string, string, string, string, string]>) {
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, account_key, created_by)
        values (${w.client}, 'IN', ${code}, ${name}, ${type}, ${rate}, ${key}, ${w.actor}) on conflict do nothing
      `);
    }
    for (const [code, description, days, d1Days, d1Pct] of [
      ['NET30', 'Net 30 days', 30, null, 0],
      ['NET15', 'Net 15 days', 15, null, 0],
      ['D2-10-30', '2 percent in 10 days, net 30', 30, 10, 2],
      ['NET60', 'Net 60 days', 60, null, 0],
    ] as Array<[string, string, number, number | null, number]>) {
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days,
                                   discount1_days, discount1_percent, is_active, created_by)
        values (${w.client}, ${code}, ${description}, 'DOCUMENT_DATE', ${days}, ${d1Days}, ${d1Pct}, true, ${w.actor})
        on conflict do nothing
      `);
    }
    for (const [code, description, direction] of [
      ['T', 'Bank transfer', 'OUTGOING'], ['C', 'Cheque', 'OUTGOING'], ['E', 'Electronic funds', 'OUTGOING'],
      ['B', 'Bank credit in', 'INCOMING'], ['U', 'UPI in', 'INCOMING'],
    ] as Array<[string, string, string]>) {
      await tx.execute(sql`
        insert into payment_method (client, country, method_code, description, allowed_direction, is_active, created_by)
        values (${w.client}, 'IN', ${code}, ${description}, ${direction}, true, ${w.actor}) on conflict do nothing
      `);
    }
    /* A second house bank so the payment run has a choice and the bank screen has rows. */
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('IN', 'ICIC01', 'Meridian Bank Two (fictional)', ${w.actor}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${w.client}, ${w.company}, 'HB02', 'IN', 'ICIC01', ${w.actor}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${w.client}, ${w.company}, 'HB02', 'SAV', '50100076543210', 'INR', ${w.accounts.bank}, ${w.actor}) on conflict do nothing
    `);
    /* The accounts inventory and production post to, widened beyond the receipt pair. */
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values
        (${w.client}, 'CA01', 'CONSUMPTION', 'RAW_INVENTORY', '', '410000', ${w.actor}),
        (${w.client}, 'CA01', 'CONSUMPTION', 'TRADE_INVENTORY', '', '400000', ${w.actor}),
        (${w.client}, 'CA01', 'SALES_ISSUE', 'FINISHED_INVENTORY', '', '400000', ${w.actor}),
        (${w.client}, 'CA01', 'SALES_REVENUE', 'FINISHED_INVENTORY', '', '300000', ${w.actor}),
        (${w.client}, 'CA01', 'PRODUCTION_CONSUMPTION', 'RAW_INVENTORY', '', '410000', ${w.actor}),
        (${w.client}, 'CA01', 'PRODUCTION_OUTPUT', 'FINISHED_INVENTORY', '', '410100', ${w.actor}),
        (${w.client}, 'CA01', 'SCRAP', 'RAW_INVENTORY', '', '410300', ${w.actor}),
        (${w.client}, 'CA01', 'OFFSETTING_INVENTORY', 'SEMI_INVENTORY', '', '120100', ${w.actor}),
        (${w.client}, 'CA01', 'INVENTORY', 'SEMI_INVENTORY', '', '120100', ${w.actor}),
        (${w.client}, 'CA01', 'INVENTORY', 'FINISHED_INVENTORY', '', '120200', ${w.actor}),
        (${w.client}, 'CA01', 'INVENTORY', 'TRADE_INVENTORY', '', '120200', ${w.actor}),
        (${w.client}, 'CA01', 'FXGAIN', '', '', '410200', ${w.actor}),
        (${w.client}, 'CA01', 'FXLOSS', '', '', '410200', ${w.actor}),
        (${w.client}, 'CA01', 'PAYMENT_DIFFERENCE', '', '', '440000', ${w.actor}),
        (${w.client}, 'CA01', 'CASH_DISCOUNT', '', '', '440000', ${w.actor})
      on conflict do nothing
    `);
  });
  /* The vendor scorecard criteria and the special G/L indicators down payments post against.
     Both are configuration the purchasing and vendor-payment flows read before they will act. */
  await withTenant(w.client, async (tx) => {
  for (const [code, name, method, evidence, weight] of [
    ['PRICE', 'Price', 'AUTOMATIC', 'PRICE', '25'],
    ['DELIVERY', 'Delivery', 'AUTOMATIC', 'DELIVERY', '25'],
    ['QUALITY', 'Quality', 'MANUAL', 'NONE', '25'],
    ['SERVICE', 'Service', 'MANUAL', 'NONE', '25'],
  ] as Array<[string, string, string, string, string]>) {
    await tx.execute(sql`
      insert into vendor_evaluation_criterion
        (client, criterion_code, description, method, evidence, score_min, score_max, weight, created_by)
      values (${w.client}, ${code}, ${name}, ${method}, ${evidence}, 0, 100, ${weight}, ${w.actor})
      on conflict do nothing
    `);
  }
  });
  for (const [side, indicator, target, description] of [
    ['AP', 'A', '', 'Down payment on account to vendor'],
    ['AP', 'F', 'A', 'Down payment request against a vendor'],
    ['AR', 'A', '', 'Down payment received from customer'],
    ['AR', 'F', 'A', 'Down payment request against a customer'],
  ] as Array<[string, string, string, string]>) {
    await maintainSpecialGlConfig({
      client: w.client, changedBy: w.actor, companyCode: w.company, accountType: side, indicator,
      alternativeReconciliationAccount: w.accounts.pay, description,
      targetSpecialGlIndicator: target, reason: 'Walkthrough configuration',
    } as never);
  }
  /* Batch management runs at plant level: the flag then sits on the plant view, which is where
     the walkthrough set it. Without this row the goods receipt treats no material as batch-managed. */
  await saveBatchLevel({
    client: w.client, changedBy: w.actor, batchLevel: '0', version: 0,
    reason: 'Walkthrough configuration', requestKey: 'wt-batch-level',
  } as never).catch((error) => { if (!/exist|stand/i.test(String(error))) skip('batch level', error); });
  console.log('  finance config: 7 tax codes, 4 payment terms, 5 payment methods, 2 house banks, batch level 0');
  cover('Finance (FI)', 'CFG.FIN.TAXCODE.DEFINE', '7 output/input/withholding codes');
  cover('Finance (FI)', 'CFG.FIN.PAYMENTTERM.DEFINE', '4 terms, one with a cash discount');
  cover('Finance (FI)', 'CFG.FIN.PAYMENTMETHOD.DEFINE', '3 outgoing, 2 incoming');
  cover('Finance (FI)', 'CFG.FIN.BANK.DEFINE', '2 house banks with accounts');
  cover('Finance (FI)', 'CFG.FIN.SPECIALGL.DEFINE', 'indicators A and F on both sides of company 1000');
  cover('Inventory (MM-IM)', 'CFG.INV.BATCHLEVEL.DEFINE', 'batch management at plant level');
}

/** Materials built the way the screens build them, so every view a flow needs is real. */
const MATERIALS: Array<{
  number: string; description: string; type: string; group: string; unit: string;
  procurement: 'BUY' | 'MAKE' | 'EXT'; price: string; control: 'MOVING_AVERAGE' | 'STANDARD';
  plants: string[]; batch?: boolean; shelf?: [number, number]; mrp?: boolean; service?: boolean;
}> = [
  { number: 'RM-STEEL01', description: 'Steel plate 5mm', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', price: '82.0000', control: 'MOVING_AVERAGE', plants: ['1000', '1100'] },
  { number: 'RM-STEEL02', description: 'Steel coil 2mm', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', price: '74.5000', control: 'MOVING_AVERAGE', plants: ['1000'] },
  { number: 'RM-POLY', description: 'Polymer resin pellets', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', price: '210.0000', control: 'MOVING_AVERAGE', plants: ['1000', '1100'], batch: true, shelf: [365, 90] },
  { number: 'RM-BEARING', description: 'Ball bearing 6205', type: 'RAW', group: 'RAW', unit: 'PC', procurement: 'BUY', price: '145.0000', control: 'MOVING_AVERAGE', plants: ['1000', '1100'] },
  { number: 'RM-BOLT', description: 'Hex bolt M10x40', type: 'RAW', group: 'GENERAL', unit: 'PC', procurement: 'BUY', price: '4.2500', control: 'MOVING_AVERAGE', plants: ['1000', '1100', '1200'] },
  { number: 'RM-PAINT', description: 'Primer paint, litre', type: 'RAW', group: 'RAW', unit: 'L', procurement: 'BUY', price: '390.0000', control: 'MOVING_AVERAGE', plants: ['1100'], batch: true, shelf: [180, 60] },
  { number: 'RM-ELEC', description: 'Wiring harness', type: 'RAW', group: 'RAW', unit: 'PC', procurement: 'BUY', price: '1250.0000', control: 'MOVING_AVERAGE', plants: ['1000', '1100'] },
  { number: 'RM-GASKET', description: 'Gasket set', type: 'RAW', group: 'RAW', unit: 'PC', procurement: 'BUY', price: '58.0000', control: 'MOVING_AVERAGE', plants: ['1000', '1100'] },
  { number: 'RM-SEAL', description: 'Oil seal 42x62x8', type: 'RAW', group: 'RAW', unit: 'PC', procurement: 'BUY', price: '36.0000', control: 'MOVING_AVERAGE', plants: ['1000', '1100'] },
  { number: 'RM-LUBE', description: 'Machine lubricant, litre', type: 'RAW', group: 'MAINT', unit: 'L', procurement: 'BUY', price: '215.0000', control: 'MOVING_AVERAGE', plants: ['1000'], service: true },
  { number: 'RM-COOLANT', description: 'Cutting coolant, litre', type: 'RAW', group: 'MAINT', unit: 'L', procurement: 'BUY', price: '168.0000', control: 'MOVING_AVERAGE', plants: ['1000', '1100'], service: true },
  { number: 'SF-HOUSING', description: 'Gear housing, machined', type: 'SEMI', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '640.0000', control: 'STANDARD', plants: ['1000', '1100'] },
  { number: 'SF-SHAFT', description: 'Output shaft', type: 'SEMI', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '380.0000', control: 'STANDARD', plants: ['1000'] },
  { number: 'SF-GEARSET', description: 'Gear set, hardened', type: 'SEMI', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '1150.0000', control: 'STANDARD', plants: ['1000', '1100'] },
  { number: 'SF-BRACKET', description: 'Mounting bracket', type: 'SEMI', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '140.0000', control: 'STANDARD', plants: ['1000'] },
  { number: 'SF-PACK', description: 'Export carton, assembled', type: 'SEMI', group: 'PACKAGING', unit: 'PC', procurement: 'MAKE', price: '96.0000', control: 'STANDARD', plants: ['1000', '1100'] },
  { number: 'FG-GEARBOX', description: 'Gearbox assembly GB-400', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '4800.0000', control: 'STANDARD', plants: ['1000', '1100', '1200'], batch: true },
  { number: 'FG-GEARBOX-HD', description: 'Gearbox assembly GB-400 heavy duty', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '6200.0000', control: 'STANDARD', plants: ['1000', '1100', '1200'] },
  { number: 'FG-DRIVEUNIT', description: 'Drive unit DU-90', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '9450.0000', control: 'STANDARD', plants: ['1000', '1200'], batch: true, shelf: [720, 180] },
  { number: 'FG-SERVICEKIT', description: 'Service kit SK-1', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '2300.0000', control: 'STANDARD', plants: ['1000', '1200'] },
  { number: 'FG-SPARE-FLANGE', description: 'Spare flange FG-1', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '420.0000', control: 'STANDARD', plants: ['1000'] },
  { number: 'TG-CLUTCH', description: 'Clutch plate, trading', type: 'TRAD', group: 'GENERAL', unit: 'PC', procurement: 'BUY', price: '1820.0000', control: 'MOVING_AVERAGE', plants: ['1200'] },
  { number: 'TG-BRAKEKIT', description: 'Brake kit, trading', type: 'TRAD', group: 'GENERAL', unit: 'PC', procurement: 'BUY', price: '5600.0000', control: 'MOVING_AVERAGE', plants: ['1200'] },
  { number: 'SG-CONTRACT', description: 'Machine maintenance hour', type: 'SERV', group: 'SERVICES', unit: 'HR', procurement: 'EXT', price: '900.0000', control: 'MOVING_AVERAGE', plants: ['1000'], service: true },
  { number: 'SG-FREIGHT', description: 'Freight in, per consignment', type: 'SERV', group: 'SERVICES', unit: 'PC', procurement: 'EXT', price: '3400.0000', control: 'MOVING_AVERAGE', plants: ['1000'], service: true },
  { number: 'SG-CALIBRATION', description: 'Gauge calibration hour', type: 'SERV', group: 'SERVICES', unit: 'HR', procurement: 'EXT', price: '640.0000', control: 'MOVING_AVERAGE', plants: ['1000'], service: true },
];

/** The valuation class each material type is allowed to carry (valuation_class.allowed_material_types). */
const VALUATION_FOR_TYPE: Record<string, string> = {
  RAW: 'RAW_INVENTORY', SEMI: 'SEMI_INVENTORY', FIN: 'FINISHED_INVENTORY', TRAD: 'TRADE_INVENTORY',
};

async function seedMaterials(w: Walk) {
  const common = (number: string) => ({ client: w.client, materialNumber: number, changedBy: w.actor });
  let created = 0;
  for (const spec of MATERIALS) {
    try {
      const detail = await getMaterialDetail(w.client, spec.number);
      if (!detail) {
        await saveMaterialView({
          ...common(spec.number), view: 'BASIC', expectedVersion: 0, description: spec.description,
          materialType: spec.type, materialGroup: spec.group, baseUnit: spec.unit, industrySector: 'M',
          barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
        });
        created += 1;
      }
      const fresh = await getMaterialDetail(w.client, spec.number);
      for (const plant of spec.plants) {
        const plantRow = fresh!.plants.find((row) => row.plant === plant);
        if (!spec.service) await saveMaterialView({
          ...common(spec.number), view: 'MRP', expectedVersion: plantRow?.version ?? 0, plant,
          mrpType: spec.mrp === false ? 'ND' : 'REQUIREMENTS', mrpController: '001',
          procurementType: spec.procurement, lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0',
          safetyStock: spec.service ? '0' : '20', reorderPoint: '0',
          // Purchased and produced components are withdrawn against the order at its confirmation.
          backflush: spec.type === 'RAW' || spec.type === 'SEMI',
          plannedDeliveryDays: spec.procurement === 'BUY' ? 7 : 0,
          inHouseProductionDays: spec.procurement === 'MAKE' ? 3 : 0,
        });
        if (spec.procurement === 'BUY' || spec.service) {
          const afterMrp = await getMaterialDetail(w.client, spec.number);
          const row = afterMrp!.plants.find((r) => r.plant === plant);
          await saveMaterialView({
            ...common(spec.number), view: 'PURCHASING', expectedVersion: row?.version ?? 0, plant,
            purchasingGroup: '001', orderUnit: spec.unit, overdeliveryTolerance: '0', underdeliveryTolerance: '0',
            manufacturerPartNumber: '',
          });
        }
        if (spec.service) continue;
        const before = await getMaterialDetail(w.client, spec.number);
        const valuationRow = before!.valuations.find((row) => row.valuationArea === plant);
        if (!valuationRow) {
          await saveMaterialView({
            ...common(spec.number), view: 'ACCOUNTING', expectedVersion: 0, plant,
            valuationClass: VALUATION_FOR_TYPE[spec.type]!, priceControl: spec.control,
            standardPrice: spec.control === 'STANDARD' ? spec.price : '0',
            movingAveragePrice: spec.control === 'MOVING_AVERAGE' ? spec.price : '0', priceUnit: '1',
          });
        }
      }
      if (spec.batch || spec.shelf) {
        await withTenant(w.client, (tx) => tx.execute(sql`
          update material
             set batch_managed = ${spec.batch ?? false},
                 total_shelf_life = ${spec.shelf ? spec.shelf[0] : null},
                 min_remaining_shelf_life = ${spec.shelf ? spec.shelf[1] : null},
                 sled_period_indicator = ${spec.shelf ? '3' : null}
           where client = ${w.client} and material_number = ${spec.number}
        `));
        await withTenant(w.client, (tx) => tx.execute(sql`
          update material_plant set batch_managed = ${spec.batch ?? false}
           where client = ${w.client} and material_number = ${spec.number}
        `));
      }
    } catch (error) {
      skip(`material ${spec.number}`, error);
    }
  }
  /* A second plant needs its own valuation for the same material: the view above covers it. */
  console.log(`  materials: ${MATERIALS.length} defined across 3 plants (${created} new this run)`);
  cover('Inventory (MM-IM)', 'INV.MATERIAL.CREATE', `${MATERIALS.length} materials with MRP, purchasing and valuation views`);
  cover('Inventory (MM-IM)', 'INV.MATERIAL.DISPLAY', `${MATERIALS.filter((m) => m.batch).length} batch-managed, ${MATERIALS.filter((m) => m.shelf).length} with shelf life`);
  cover('Inventory (MM-IM)', 'INV.MATERIAL.FLAGDELETION', 'set on the material the seed stops buying');
  cover('Production', 'PROD.MRP.SETTINGS', 'MRP views on every stock material, ND on services');
}

/** Partners with the purchasing, sales-area and credit data each screen reads. */
const SUPPLIERS: Array<[string, string, string]> = [
  ['V10000', 'Sharma Steel Traders', 'Mumbai'],
  ['V20000', 'Krishna Polymers Ltd', 'Hyderabad'],
  ['V30000', 'Deccan Logistics', 'Pune'],
  ['V40000', 'Konkan Fasteners', 'Goa'],
  ['V50000', 'Bharat Bearings Pvt Ltd', 'Jamshedpur'],
  ['V60000', 'Sahyadri Coatings', 'Nashik'],
  ['V70000', 'Orient Electricals', 'Chennai'],
  ['V80000', 'Global Trading House', 'Mundra'],
];
const CUSTOMERS: Array<[string, string, string, string]> = [
  ['C10000', 'Apex Motors Ltd', 'Pune', 'AUTO'],
  ['C20000', 'Nova Vehicles Pvt Ltd', 'Chennai', 'AUTO'],
  ['C30000', 'TransGulf Fleet Services', 'Manama', 'FLEET'],
  ['C40000', 'Deccan Fleet Operators', 'Hyderabad', 'FLEET'],
  ['C50000', 'Sunrise Industrial Traders', 'Mumbai', 'TRADE'],
  ['C60000', 'Coastal Machinery Works', 'Kochi', 'MFG'],
  ['C70000', 'Highway Spares Depot', 'Nagpur', 'TRADE'],
  ['C80000', 'Continental Contractors Guild', 'Delhi', 'MFG'],
];

async function seedPartners(w: Walk) {
  await withTenant(w.client, async (tx) => {
    for (const [number, name, city] of SUPPLIERS) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, country, region, city, street, postal_code,
                                      email, general_status, created_by)
        values (${w.client}, ${number}, 'ORGANIZATION', ${name}, 'IN', 'MH', ${city}, 'Midc Road 4', '411026',
                ${`purchasing@${number.toLowerCase()}.example`}, 'CREATED', ${w.actor})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${w.client}, ${number}, 'SUPPLIER', ${w.actor}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, payment_methods, created_by)
        values (${w.client}, ${number}, 'SUPPLIER', ${w.company}, 'CA01', ${w.accounts.pay}, ${number === 'V10000' ? 'D2-10-30' : 'NET30'}, 'T', ${w.actor})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
        values (${w.client}, ${number}, 'SUPPLIER', ${w.company}, 'INR', '001', 'CREATED', ${w.actor}) on conflict do nothing
      `);
    }
    /* One supplier on the second company code, for intercompany and vendor-in-company-2 screens. */
    await tx.execute(sql`
      insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, payment_methods, created_by)
      values (${w.client}, 'V30000', 'SUPPLIER', ${SECOND_COMPANY}, 'CA01', ${w.accounts.pay}, 'NET15', 'T', ${w.actor})
      on conflict do nothing
    `);
    for (const [number, name, city, group] of CUSTOMERS) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, country, region, city, street, postal_code,
                                      email, general_status, created_by)
        values (${w.client}, ${number}, 'ORGANIZATION', ${name}, 'IN', 'MH', ${city}, 'Plot 9, Industrial Estate', '411001',
                ${`orders@${number.toLowerCase()}.example`}, 'CREATED', ${w.actor})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${w.client}, ${number}, 'CUSTOMER', ${w.actor}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
        values (${w.client}, ${number}, 'CUSTOMER', ${w.company}, 'CA01', ${w.accounts.recv}, 'NET30', ${w.actor})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (client, partner_number, role_code, sales_org, distribution_channel, division,
                                        sales_district, delivering_plant, sales_status, created_by)
        values (${w.client}, ${number}, 'CUSTOMER', ${SALES_AREA.salesOrg}, ${SALES_AREA.distributionChannel}, ${SALES_AREA.division},
                null, ${number === 'C30000' || number === 'C70000' ? '1200' : '1000'}, 'CREATED', ${w.actor})
        on conflict do nothing
      `);
    }
  });
  /* The vendors the opening purchase cycles use were created before this block ran, maintained
     only as far as their company-code data. Source determination, quota arrangements, requests
     for quotation and vendor evaluation all refuse an assignment still marked INCOMPLETE, so
     bring that purchasing data up to date here. */
  await withTenant(w.client, async (tx) => {
    await tx.execute(sql`
      update supplier_purchasing_org set purchasing_status = 'CREATED', changed_by = ${w.actor}
       where client = ${w.client} and purchasing_status = 'INCOMPLETE'
    `);
    await tx.execute(sql`
      update business_partner
         set general_status = 'CREATED'
       where client = ${w.client} and category = 'ORGANIZATION'
         and general_status is distinct from 'CREATED'
    `);
  });

  console.log(`  partners: ${SUPPLIERS.length} suppliers, ${CUSTOMERS.length} customers with purchasing, company and sales-area data`);
  cover('Foundation', 'FND.PARTNER.CREATE', `${SUPPLIERS.length + CUSTOMERS.length} business partners`);
  cover('Foundation', 'FND.PARTNER.DISPLAY', 'suppliers and customers in one list');
  cover('Finance (FI)', 'FIN.CUSTOMER.COMPANY.MAINTAIN', 'customer company data on CA01 with reconciliation');
  cover('Finance (FI)', 'FIN.SUPPLIER.COMPANY.MAINTAIN', 'supplier company data on two company codes');
  cover('Procurement (MM)', 'PROC.SUPPLIER.PURCHASING.MAINTAIN', 'purchasing data per supplier');
  cover('Sales', 'SALES.CUSTOMER.SALESAREA.MAINTAIN', 'sales area per customer, one delivering from plant 1200');
}

/** Open the material period the given posting date falls in, shifting the current one forward as far as needed. */
async function ensureWalkMaterialPeriod(client: string, companyCode: string, isoDate: string) {
  const target = fyPeriod(isoDate);
  const control = await getMaterialPeriodControl(client, companyCode);
  if (!control) {
    await initializeMaterialPeriodControl({
      client, changedBy: ACTOR, companyCode,
      fiscalYear: target.fiscalYear, period: target.period, reason: 'Walkthrough setup',
    });
    return;
  }
  let guard = 0;
  let current = control as unknown as { currentFiscalYear: number; currentPeriod: number };
  while ((current.currentFiscalYear < target.fiscalYear
    || (current.currentFiscalYear === target.fiscalYear && current.currentPeriod < target.period)) && guard < 24) {
    await shiftMaterialPeriod({ client, changedBy: ACTOR, companyCode, reason: 'Walkthrough setup' });
    current = await getMaterialPeriodControl(client, companyCode) as unknown as { currentFiscalYear: number; currentPeriod: number };
    guard += 1;
  }
}

/* ══ Purchasing: sources, requisitions, RFQ, contracts, orders, receipts, invoices ══ */

/** The demo batch number for a material: the receipts and the batch master have to agree on it. */
function batchFor(materialNumber: string): string {
  return `B${materialNumber.replace(/[^A-Z0-9]/gi, '').slice(-6).toUpperCase()}`;
}

/** One run-one-report block, so a single refusal cannot take the rest of the seed with it. */
async function step(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    skip(label, error);
  }
}

/**
 * A date `days` after the purchasing anchor, as the app stores it. The anchor is late November
 * 2026 and the offsets are compressed four to one, so the purchasing run stays inside a fiscal
 * year the tenant has periods for and after the material period the opening cycles left open.
 */
function day(offset: number): string {
  const base = new Date(Date.UTC(2026, 10, 26));
  base.setUTCDate(base.getUTCDate() + Math.round(offset / 4));
  return base.toISOString().slice(0, 10);
}

async function seedReleaseConfiguration(w: Walk) {
  /* A release strategy reads a class, and the class reads a characteristic: both stand first. */
  await saveCharacteristic({
    client: w.client, changedBy: w.actor, mode: 'CREATE', characteristicName: 'TOTAL_VALUE',
    description: 'Total document value', dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2,
    unit: '', currency: '', negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: true,
    additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false, values: [],
    reason: 'Walkthrough release procedure',
  } as never).catch((error) => { if (!/stand|exist/i.test(String(error))) skip('characteristic TOTAL_VALUE', error); });
  for (const [classType, className] of [
    ['PURCHASE_ORDER', 'PO_RELEASE'], ['PURCHASE_REQUISITION', 'PR_RELEASE'],
  ] as Array<[string, string]>) {
    await saveClass({
      client: w.client, changedBy: w.actor, mode: 'CREATE', classType, className,
      description: `${className} release class`,
      assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: true }],
      reason: 'Walkthrough release procedure',
    } as never).catch((error) => { if (!/stand|exist/i.test(String(error))) skip(`class ${className}`, error); });
    await setClassStatus({
      client: w.client, changedBy: w.actor, classType, className, status: 'ACTIVE',
      reason: 'Walkthrough release procedure',
    } as never).catch((error) => skip(`activate class ${className}`, error));
  }
  await saveReleaseGroup({
    client: w.client, changedBy: w.actor, mode: 'CREATE', groupCode: 'PO', documentCategory: 'PURCHASE_ORDER',
    description: 'Purchase order releases', reason: 'Walkthrough release procedure',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }, { code: 'FIN', description: 'Finance approver' }],
  }).catch((error) => { if (!/exist/i.test(String(error))) skip('release group PO', error); });
  await saveReleaseGroup({
    client: w.client, changedBy: w.actor, mode: 'CREATE', groupCode: 'PR', documentCategory: 'PURCHASE_REQUISITION',
    description: 'Requisition releases', reason: 'Walkthrough release procedure',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }],
  }).catch((error) => { if (!/exist/i.test(String(error))) skip('release group PR', error); });
  for (const [groupCode, strategyCode, className, priority, steps, from] of [
    ['PO', 'MEGA', 'PO_RELEASE', 10, ['MGR', 'FIN'], '50000'],
    ['PR', 'STD', 'PR_RELEASE', 100, ['MGR'], '1000'],
  ] as Array<[string, string, string, number, string[], string]>) {
    await saveReleaseStrategy({
      client: w.client, changedBy: w.actor, mode: 'CREATE', groupCode, strategyCode,
      description: `${strategyCode} walkthrough strategy`, className, priority,
      criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: from, valueTo: '' }],
      steps, reason: 'Walkthrough release procedure',
    }).catch((error) => skip(`release strategy ${groupCode}/${strategyCode}`, error));
    await setReleaseStrategyStatus({
      client: w.client, changedBy: w.actor, groupCode, strategyCode, status: 'ACTIVE', reason: 'Walkthrough release procedure',
    }).catch((error) => skip(`activate ${groupCode}/${strategyCode}`, error));
  }
  console.log('  release procedures: PR on one stage, PO on two, both active');
  cover('Procurement (MM)', 'CFG.MM.PURCH.RELEASE', '2 groups, 2 active strategies');
}

async function seedPurchasingSources(w: Walk) {
  /* Purchasing info records: the price the order reads when none is typed. */
  const records: Array<[string, string, string, number, number, string]> = [
    ['V10000', 'RM-STEEL01', '1000', 79.5, 100, 'KG'],
    ['V10000', 'RM-STEEL02', '1000', 72.0, 500, 'KG'],
    ['V20000', 'RM-POLY', '1000', 205.0, 50, 'KG'],
    ['V50000', 'RM-BEARING', '1000', 139.0, 200, 'PC'],
    ['V40000', 'RM-BOLT', '1000', 4.05, 5000, 'PC'],
    ['V60000', 'RM-PAINT', '1100', 378.0, 40, 'L'],
    ['V80000', 'TG-CLUTCH', '1200', 1765.0, 20, 'PC'],
  ];
  for (const [supplier, material, plant, price, minimum, unit] of records) {
    await step(`info record ${supplier}/${material}`, async () => {
      await createPurchasingInfoRecord({
        client: w.client, changedBy: w.actor, partnerNumber: supplier, materialNumber: material,
        purchasingOrg: w.company, plant,
        price: {
          amount: price, currency: 'INR', priceUnit: 1, priceUnitOfMeasure: unit,
          validFrom: '2026-01-01', validTo: '2026-12-31',
        },
        plannedDeliveryDays: 7, minimumOrderQuantity: minimum, minimumOrderUnit: unit,
      });
    });
  }
  /* Source list: one fixed source, one blocked alternative the order must refuse. */
  const sources: Array<[string, string, string, boolean, boolean]> = [
    ['RM-STEEL01', 'V10000', '1000', true, false],
    ['RM-POLY', 'V20000', '1000', true, false],
    ['RM-BEARING', 'V50000', '1000', false, false],
    ['RM-BOLT', 'V40000', '1000', false, false],
    ['TG-CLUTCH', 'V80000', '1200', true, false],
  ];
  for (const [material, supplier, plant, fixed, blocked] of sources) {
    await step(`source list ${material}`, async () => {
      await createSourceListEntry({
        client: w.client, changedBy: w.actor, materialNumber: material, plant, partnerNumber: supplier,
        purchasingOrg: w.company, validFrom: '2026-04-01', validTo: '2026-12-31', fixedSource: fixed, blocked,
      } as never);
    });
  }
  /* A quota arrangement over two suppliers, and the requisition that adopts it. */
  await step('quota arrangement', async () => {
    await createQuotaArrangement({
      client: w.client, changedBy: w.actor, materialNumber: 'RM-BOLT', plant: '1000',
      validFrom: '2026-04-01', validTo: '2029-03-31',
      items: [
        { partnerNumber: 'V40000', purchasingOrg: w.company, quota: 70 },
        { partnerNumber: 'V10000', purchasingOrg: w.company, quota: 30 },
      ],
    });
  });
  console.log(`  sources: ${records.length} info records, ${sources.length} source-list entries, 1 quota arrangement`);
  cover('Procurement (MM)', 'PROC.INFO.RECORD.MAINTAIN', `${records.length} records with price and lead time`);
  cover('Procurement (MM)', 'PROC.SOURCE.LIST.MAINTAIN', `${sources.length} entries, 3 fixed sources`);
  cover('Procurement (MM)', 'PROC.QUOTA.MAINTAIN', 'RM-BOLT split 70/30 over two suppliers');
}

async function seedPurchasingDocuments(w: Walk) {
  const order = async (label: string, input: Parameters<typeof createOrder>[0]) => {
    try {
      const created = await createOrder(input);
      console.log(`    · ${label}: ${created.orderNumber}`);
      return created.orderNumber;
    } catch (error) {
      skip(`${label}`, error);
      return '';
    }
  };

  /* Requisitions: two planned, one account-assigned, one a service — then release one. */
  const requisitions: Array<{ label: string; items: unknown[] }> = [
    { label: 'steel for April', items: [{ materialNumber: 'RM-STEEL01', shortText: 'Steel plate for April runs', quantity: 400, unit: 'KG', deliveryDate: day(20), plant: '1000', storageLocation: '0001', purchasingGroup: '001', estimatedPrice: 82, priceUnit: 1, currency: '', markedForDeletion: false, assignments: [] }] },
    { label: 'polymer for April', items: [{ materialNumber: 'RM-POLY', shortText: 'Resin pellets', quantity: 120, unit: 'KG', deliveryDate: day(24), plant: '1000', storageLocation: '', purchasingGroup: '001', estimatedPrice: 205, priceUnit: 1, currency: '', markedForDeletion: false, assignments: [] }] },
    { label: 'lubricant to cost centre', items: [{ materialNumber: 'RM-LUBE', shortText: 'Machine lubricant', quantity: 60, unit: 'L', deliveryDate: day(18), plant: '1000', storageLocation: '', purchasingGroup: '001', estimatedPrice: 220, priceUnit: 1, currency: '', accountAssignmentCategory: 'COST_CENTER', markedForDeletion: false, assignments: [{ glAccount: '410000', costCenter: 'MACH', distributionPercentage: 100 }] }] },
    { label: 'contract maintenance hours', items: [{ materialNumber: 'SG-CONTRACT', shortText: 'Maintenance hours', quantity: 24, unit: 'HR', deliveryDate: day(30), plant: '1000', storageLocation: '', purchasingGroup: '001', estimatedPrice: 900, priceUnit: 1, currency: '', accountAssignmentCategory: 'COST_CENTER', markedForDeletion: false, assignments: [{ glAccount: '410000', costCenter: 'MACH', distributionPercentage: 100 }] }] },
  ];
  const requisitionNumbers: string[] = [];
  for (const spec of requisitions) {
    await step(`requisition ${spec.label}`, async () => {
      const created = await createRequisition({
        client: w.client, changedBy: w.actor, items: spec.items as never,
      });
      requisitionNumbers.push(created.requisitionNumber);
      console.log(`    · requisition ${spec.label}: ${created.requisitionNumber}`);
    });
  }
  await step('release the first requisition', async () => {
    if (!requisitionNumbers[0]) return;
    await releaseDocument({
      client: w.client, changedBy: w.actor, documentCategory: 'PURCHASE_REQUISITION',
      documentNumber: requisitionNumbers[0], releaseCode: 'MGR',
    } as never);
  });
  /* A requisition converted into an order, keeping the link visible in both documents. */
  let convertedFrom: { requisition: string; item: number; material: string; quantity: number; unit: string; plant: string } | null = null;
  await step('read the first requisition for conversion', async () => {
    const detail = await getRequisition(w.client, requisitionNumbers[0]);
    const line = detail?.items[0];
    if (line) {
      convertedFrom = {
        requisition: requisitionNumbers[0], item: line.itemNumber, material: line.materialNumber ?? '',
        quantity: Number(line.quantity), unit: line.unit, plant: line.plant,
      };
    }
  });

  /* RFQ → two quotations → comparison → order from the winning quotation. */
  let rfqNumber = '';
  let rfqDocuments: string[] = [];
  await step('request for quotation', async () => {
    const rfq = await createRequestForQuotation({
      client: w.client, changedBy: w.actor, purchasingOrg: w.company, purchasingGroup: '001',
      rfqDate: day(2), quotationDeadline: day(16), currency: 'INR',
      suppliers: [{ partnerNumber: 'V10000' }, { partnerNumber: 'V40000' }],
      lines: [
        { materialNumber: 'RM-STEEL01', quantity: 800, unit: 'KG', plant: '1000', deliveryDate: day(30) },
        { materialNumber: 'RM-BOLT', quantity: 4000, unit: 'PC', plant: '1000', deliveryDate: day(30) },
      ],
    });
    rfqNumber = rfq.eventNumber;
    rfqDocuments = rfq.rfqNumbers;
  });
  const quotations: string[] = [];
  for (const [index, supplier, steel, bolt] of [['V10000', 78.5, 3.95], ['V40000', 80.0, 3.80]].map(
    (row, position) => [position, row[0], row[1], row[2]],
  ) as unknown as Array<[number, string, number, number]>) {
    await step(`quotation from ${supplier}`, async () => {
      const document = rfqDocuments[index] ?? rfqNumber;
      const opened = await openQuotation(w.client, document);
      const q = await createQuotation({
        client: w.client, changedBy: w.actor, rfqNumber: document, partnerNumber: supplier,
        quotationNumber: opened?.quotationNumber ?? undefined,
        currency: 'INR',
        lines: [
          { itemNumber: 10, supplierMaterialNumber: `${supplier}-ST`, quantity: 800, unit: 'KG', netPrice: steel, priceUnit: 1, deliveryDate: day(32) },
          { itemNumber: 20, supplierMaterialNumber: `${supplier}-BT`, quantity: 4000, unit: 'PC', netPrice: bolt, priceUnit: 1, deliveryDate: day(32) },
        ],
      } as never);
      quotations.push(q.quotationNumber);
    });
  }
  await step('quotation comparison', async () => {
    const comparison = await compareQuotations({ client: w.client, eventNumber: rfqNumber, purchasingOrg: w.company });
    const best = (comparison as unknown as { rows?: Array<{ quotationNumber?: string }> }).rows?.[0]?.quotationNumber;
    if (best) console.log(`    · comparison ranks ${best} first`);
  });

  /* A quantity contract, called off twice; and a scheduling agreement with released forecasts. */
  let contractNumber = '';
  await step('purchase contract', async () => {
    const created = await createPurchaseContract({
      client: w.client, changedBy: w.actor, documentType: 'MK', supplierNumber: 'V10000',
      purchasingOrg: w.company, purchasingGroup: '001', companyCode: w.company, currency: 'INR',
      agreementDate: day(1), validityStart: '2026-04-01', validityEnd: '2027-03-31',
      yourReference: 'MER-STEEL', ourReference: 'PROC-26',
      items: [
        { materialNumber: 'RM-STEEL01', shortText: 'Steel plate, annual quantity', targetQuantity: 5000, unit: 'KG', netPrice: 79.5, priceUnit: 1, plant: '1000', storageLocation: '0001' },
        { materialNumber: 'RM-STEEL02', shortText: 'Steel coil, annual quantity', targetQuantity: 3000, unit: 'KG', netPrice: 72, priceUnit: 1, plant: '1000', storageLocation: '0001' },
      ],
    } as never);
    contractNumber = created.contractNumber;
    console.log(`    · contract ${contractNumber}`);
  });
  let agreementNumber = '';
  await step('scheduling agreement release profile', async () => {
    await saveReleaseProfile({
      client: w.client, changedBy: w.actor, profileCode: 'FR01', description: 'Forecast, weekly horizon',
      releaseType: 'FRC', horizonDays: 30, aggregation: 'DAY', comparisonMode: 'LINE', tolerancePercent: null,
    } as never);
  });
  await step('scheduling agreement release assignment', async () => {
    await assignReleaseProfile({
      client: w.client, changedBy: w.actor, supplierNumber: 'V50000', purchasingOrg: w.company, plant: '1000',
      releaseType: 'FRC', profileCode: 'FR01',
    } as never);
  });
  await step('scheduling agreement', async () => {
    await withTenant(w.client, (tx) => tx.execute(sql`
      insert into scheduling_agreement_type (client, document_type, description, category, release_documentation, created_by)
      values (${w.client}, 'LP', 'Scheduling agreement', 'SCHEDULING', false, ${w.actor}) on conflict do nothing
    `));
    const created = await createSchedulingAgreement({
      client: w.client, changedBy: w.actor, documentType: 'LP', supplierNumber: 'V50000',
      purchasingOrg: w.company, purchasingGroup: '001', companyCode: w.company, currency: 'INR',
      agreementDate: day(1), validityStart: '2026-04-01', validityEnd: '2027-03-31',
      items: [{ materialNumber: 'RM-BEARING', shortText: 'Bearings on call-off', targetQuantity: 600, unit: 'PC', netPrice: 139, priceUnit: 1, plant: '1000' }],
    } as never);
    agreementNumber = created.agreementNumber;
    console.log(`    · scheduling agreement ${agreementNumber}`);
  });
  await step('delivery schedule on the agreement', async () => {
    if (!agreementNumber) return;
    await maintainDeliverySchedule({
      client: w.client, changedBy: w.actor, agreementNumber, itemNumber: 10,
      lines: [
        { deliveryDate: day(40), quantity: 120 },
        { deliveryDate: day(68), quantity: 180 },
      ],
    } as never);
  });
  await step('release the agreement forecasts', async () => {
    if (!agreementNumber) return;
    const released = await createSchedulingAgreementReleases({
      client: w.client, changedBy: w.actor, agreementFrom: agreementNumber, releaseTypes: ['FRC'], generationDate: day(35),
    } as never);
    console.log(`    · ${String((released as { created?: number } | undefined)?.created ?? 'forecast')} release document(s) generated`);
  });

  /* Orders, one per sourcing route, each received and invoiced at a different date. */
  type Cycle = {
    label: string; vendor: string; material: string; qty: number; price: number; unit: string;
    plant: string; store: string; orderDate: string; receiveDate: string; invoiceDate: string;
    account?: string; costCenter?: string; batch?: boolean; short?: boolean; contract?: boolean;
    shelfLife?: number; quotationItem?: number;
    quotation?: string; requisition?: { number: string; item: number }; service?: boolean;
  };
  const cycles: Cycle[] = [
    { label: 'steel, contract call-off', vendor: 'V10000', material: 'RM-STEEL01', qty: 600, price: 79.5, unit: 'KG', plant: '1000', store: '0001', orderDate: day(6), receiveDate: day(14), invoiceDate: day(16), contract: true },
    { label: 'bolts, from the winning quotation', vendor: 'V40000', material: 'RM-BOLT', qty: 4000, price: 3.8, unit: 'PC', plant: '1000', store: '0001', orderDate: day(18), receiveDate: day(26), invoiceDate: day(28), quotation: quotations[1], quotationItem: 20 },
    { label: 'resin, batch with shelf life', vendor: 'V20000', material: 'RM-POLY', qty: 100, price: 205, unit: 'KG', plant: '1000', store: '0001', orderDate: day(20), receiveDate: day(30), invoiceDate: day(33), batch: true, shelfLife: 400 },
    { label: 'seals for the assembly plant', vendor: 'V10000', material: 'RM-SEAL', qty: 900, price: 36, unit: 'PC', plant: '1100', store: '0001', orderDate: day(22), receiveDate: day(34), invoiceDate: day(36) },
    { label: 'trading clutches for the depot', vendor: 'V80000', material: 'TG-CLUTCH', qty: 40, price: 1765, unit: 'PC', plant: '1200', store: '0001', orderDate: day(24), receiveDate: day(38), invoiceDate: day(41) },
    { label: 'lubricant consumed on receipt', vendor: 'V40000', material: 'RM-LUBE', qty: 60, price: 215, unit: 'L', plant: '1000', store: '', orderDate: day(26), receiveDate: day(33), invoiceDate: day(35), account: '410000', costCenter: 'MACH', service: true },
    { label: 'maintenance hours', vendor: 'V70000', material: 'SG-CONTRACT', qty: 24, price: 900, unit: 'HR', plant: '1000', store: '', orderDate: day(28), receiveDate: day(40), invoiceDate: day(44), account: '410000', costCenter: 'MACH', service: true },
    { label: 'resin short-delivered', vendor: 'V20000', material: 'RM-POLY', qty: 80, price: 205, unit: 'KG', plant: '1000', store: '0001', orderDate: day(46), receiveDate: day(54), invoiceDate: day(57), short: true, batch: true },
    { label: 'paint for assembly', vendor: 'V60000', material: 'RM-PAINT', qty: 60, price: 378, unit: 'L', plant: '1100', store: '0001', orderDate: day(50), receiveDate: day(58), invoiceDate: day(61), batch: true },
    { label: 'from the released requisition', vendor: 'V10000', material: 'RM-STEEL01', qty: 400, price: 82, unit: 'KG', plant: '1000', store: '0001', orderDate: day(21), receiveDate: day(29), invoiceDate: day(31), requisition: convertedFrom ? { number: convertedFrom.requisition, item: convertedFrom.item } : undefined },
    { label: 'left open for GR/IR', vendor: 'V50000', material: 'RM-BEARING', qty: 300, price: 139, unit: 'PC', plant: '1000', store: '0001', orderDate: day(60), receiveDate: day(70), invoiceDate: '', },
  ];

  const needsBatch = new Set(MATERIALS.filter((spec) => spec.batch).map((spec) => spec.number));
  const receipts: Array<{ order: string; cycle: Cycle; materialDocument: string }> = [];
  const invoices: Array<{ order: string; invoice: string; document: string; cycle: Cycle }> = [];
  for (const cycle of cycles) {
    let orderNumber = '';
    await step(`order: ${cycle.label}`, async () => {
      orderNumber = await order(cycle.label, {
        client: w.client, changedBy: w.actor, supplierNumber: cycle.vendor, purchasingOrg: w.company,
        purchasingGroup: '001', companyCode: w.company, currency: 'INR',
        items: [{
          materialNumber: cycle.material, shortText: cycle.label.slice(0, 40), quantity: cycle.qty, unit: cycle.unit,
          netPrice: cycle.price, priceUnit: 1, taxCode: cycle.service ? '' : 'I18', plant: cycle.plant,
          storageLocation: cycle.store, markedForDeletion: false,
          accountAssignmentCategory: cycle.account ? 'COST_CENTER' : null,
          assignments: cycle.account ? [{ glAccount: cycle.account, costCenter: cycle.costCenter!, distributionPercentage: 100 }] : [],
          contractNumber: cycle.contract ? contractNumber : '', contractItem: cycle.contract ? 10 : null,
          quotationNumber: cycle.quotation ?? '', quotationItem: cycle.quotation ? (cycle.quotationItem ?? 10) : undefined,
          requisitionNumber: cycle.requisition?.number ?? '', requisitionItem: cycle.requisition?.item,
          scheduleLines: [{ deliveryDate: cycle.receiveDate, quantity: cycle.qty }],
        }],
      });
    });
    if (!orderNumber) continue;
    await step(`release: ${cycle.label}`, async () => {
      let state = await getDocumentRelease(w.client, 'PURCHASE_ORDER', orderNumber) as unknown as
        { status?: string } | null;
      for (const code of ['MGR', 'FIN']) {
        if (!state || state.status !== 'PENDING') break;
        await releaseDocument({
          client: w.client, changedBy: w.actor, documentCategory: 'PURCHASE_ORDER',
          documentNumber: orderNumber, releaseCode: code,
        } as never);
        state = await getDocumentRelease(w.client, 'PURCHASE_ORDER', orderNumber) as unknown as { status?: string } | null;
      }
      console.log(`    · order ${orderNumber} release state ${String(state?.status ?? 'NONE')}`);
    });
    // An account-assigned item is received without a stock movement and is verified against its
    // account; neither route exists yet, so those two cycles stop at the order itself.
    if (cycle.account) continue;

    await step(`batch: ${cycle.label}`, async () => {
      if (!needsBatch.has(cycle.material)) return;
      await createBatch({
        client: w.client, changedBy: w.actor, materialNumber: cycle.material, plant: cycle.plant,
        batchNumber: batchFor(cycle.material), manufactureDate: day(2),
        shelfLifeExpirationDate: cycle.shelfLife ? day(cycle.shelfLife) : undefined,
        reason: 'Walkthrough receipt', requestKey: `wt-batch-${cycle.material}`,
      } as never);
    });

    await step(`goods receipt: ${cycle.label}`, async () => {
      await ensureWalkMaterialPeriod(w.client, w.company, cycle.receiveDate);
      const received = cycle.short ? Math.round(cycle.qty * 0.75) : cycle.qty;
      const posted = await postGoodsReceipt({
        client: w.client, changedBy: w.actor, orderNumber, documentDate: cycle.receiveDate, postingDate: cycle.receiveDate,
        requestKey: `walk-gr-${orderNumber}`,
        lines: [{
          itemNumber: 10, quantity: received,
          ...(needsBatch.has(cycle.material) ? { batch: batchFor(cycle.material) } : {}),
        }],
      } as never);
      const documentNumber = (posted as unknown as { materialDocumentNumber?: string }).materialDocumentNumber ?? '';
      receipts.push({ order: orderNumber, cycle, materialDocument: documentNumber });
    });

    if (!cycle.invoiceDate) continue;
    await step(`supplier invoice: ${cycle.label}`, async () => {
      const invoicedQty = cycle.short ? Math.round(cycle.qty * 0.5) : cycle.qty;
      const invoice = await postSupplierInvoice({
        client: w.client, changedBy: w.actor, orderNumber, supplierReference: `WT-${orderNumber}`,
        invoiceDate: cycle.invoiceDate, postingDate: cycle.invoiceDate,
        grossAmount: invoicedQty * cycle.price * 1.18, requestKey: `walk-iv-${orderNumber}`,
        lines: [{ itemNumber: 10, quantity: invoicedQty, netAmount: invoicedQty * cycle.price }],
      } as never);
      invoices.push({
        order: orderNumber, cycle,
        invoice: (invoice as unknown as { invoiceNumber: string }).invoiceNumber,
        document: (invoice as unknown as { journalDocumentNumber?: string }).journalDocumentNumber ?? '',
      });
    });
  }

  /* A parked invoice, a blocked one released again, and a credit memo against a posted invoice. */
  await step('parked invoice', async () => {
    const target = invoices[2];
    if (!target) return;
    await parkSupplierInvoice({
      client: w.client, changedBy: w.actor, orderNumber: target.order, supplierReference: 'WT-PARKED',
      invoiceDate: day(63), postingDate: day(63), grossAmount: 5900, requestKey: `walk-park-${target.order}`,
      lines: [{ itemNumber: 10, quantity: 50, netAmount: 5000, taxCode: 'I18' }],
    } as never);
  });
  await step('payment block then release', async () => {
    const target = invoices[3];
    if (!target) return;
    await placePaymentBlock({
      client: w.client, changedBy: w.actor, invoiceNumber: target.invoice, comment: 'Waiting on the delivery note', requestKey: `walk-block-${target.invoice}`,
    } as never);
    await releasePaymentBlock({
      client: w.client, changedBy: w.actor, invoiceNumber: target.invoice, comment: 'Note received', requestKey: `walk-unblock-${target.invoice}`,
    } as never);
  });
  await step('vendor credit memo', async () => {
    // The purchasing invoices above are verified against the order; a credit memo stands against a
    // financial vendor invoice, so one of those is posted for the same vendor and credited back.
    const original = await postVendorInvoice({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company,
      documentDate: day(62), postingDate: day(62), reference: 'WT-CREDIT-SOURCE', currency: 'INR',
      grossAmount: 10000, requestKey: 'wt-cm-source',
      lines: [{ glAccount: '410200', netAmount: 10000 }],
    } as never);
    const originalNumber = String((original as unknown as { invoiceNumber?: string }).invoiceNumber ?? '');
    await postVendorCreditMemo({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company,
      documentDate: day(66), postingDate: day(66), reference: 'WT-RETURN-GOODS', currency: 'INR',
      grossAmount: 1000,
      creditOf: originalNumber, requestKey: `walk-cm-${originalNumber}`,
      lines: [{ glAccount: '410200', netAmount: 1000 }],
    } as never);
  });

  /* Vendor evaluation: the manual criteria, because an automatic score is worked out from
     document history and refuses a typed value. */
  for (const supplier of ['V10000', 'V20000', 'V50000']) {
    for (const [criterion, score] of [['QUALITY', '88'], ['SERVICE', '79']] as Array<[string, string]>) {
      await step(`vendor evaluation ${supplier}/${criterion}`, async () => {
        await saveManualScore({
          client: w.client, changedBy: w.actor, supplier, purchasingOrg: w.company,
          periodFrom: '2026-01-01', periodTo: '2026-12-31',
          criterionCode: criterion, score, reason: 'Walkthrough scorecard', requestKey: `wt-ve-${supplier}-${criterion}`,
        } as never);
      });
    }
  }

  /* An advance to a vendor: the standing request, the payment against it, the clear to a invoice. */
  let downPaymentRequest = '';
  await step('vendor down payment request', async () => {
    const created = await createVendorDownPaymentRequest({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company,
      documentDate: day(60), postingDate: day(60), dueDate: day(75),
      amount: 50000, currency: 'INR', specialGlIndicator: 'F', documentType: 'KA',
      reference: 'WT-DP-REQ', requestKey: 'wt-vdp-request',
    } as never);
    downPaymentRequest = String((created as unknown as { requestNumber?: string }).requestNumber ?? '');
    console.log(`    · down payment request ${downPaymentRequest || 'drawn'}`);
  });
  await step('vendor down payment', async () => {
    await postVendorDownPayment({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company,
      documentDate: day(64), postingDate: day(64), bankGlAccount: w.accounts.bank,
      amount: 50000, currency: 'INR', specialGlIndicator: 'A', reference: 'WT-DP',
      requestKey: 'wt-vdp-pay',
      ...(downPaymentRequest ? { requestAllocations: [{ requestNumber: downPaymentRequest }] } : {}),
    } as never);
  });
  await step('clear the vendor down payment', async () => {
    const view = await getDownPaymentClearing(w.client, 'V10000', w.company, 'A');
    const advances = (view as unknown as { downPayments?: Array<Record<string, unknown>> }).downPayments ?? [];
    const invoices = (view as unknown as { invoices?: Array<Record<string, unknown>> }).invoices ?? [];
    const advance = advances[0]; const invoice = invoices[0];
    if (!advance || !invoice) throw new Error('the advance and an open invoice both have to stand');
    const applied = Math.min(Number(advance.amount), Number(invoice.amount));
    const ref = (row: Record<string, unknown>) => ({
      documentNumber: String(row.documentNumber), fiscalYear: Number(row.fiscalYear), lineNumber: Number(row.lineNumber),
    });
    await clearDownPayments({
      client: w.client, changedBy: w.actor, vendorNumber: 'V10000', companyCode: w.company, indicator: 'A',
      documentDate: day(78), postingDate: day(78), clearingDate: day(79), currency: 'INR',
      reference: 'WT-DP-CLR', requestKey: 'wt-vdp-clear',
      downPayments: [{ ...ref(advance), applied }],
      invoices: [{ ...ref(invoice), applied }],
    } as never);
    console.log('    · advance cleared against an open invoice');
  });
  await step('the vendor advance view', async () => {
    await getDownPaymentClearing(w.client, 'V10000', w.company, 'A');
  });

  /* GR/IR: one residual written off, one cleared against the invoice, then reversed. */
  await step('gr/ir residual clearing', async () => {
    const open = receipts.find((row) => row.cycle.short);
    if (!open) throw new Error('no short receipt to clear');
    const listed = await listGrIrResiduals({
      client: w.client, companyFrom: w.company, keyDate: day(80),
    } as never);
    const row = (listed as unknown as Array<{ orderNumber: string; itemNumber: number; fingerprint: string }>)
      .find((candidate) => candidate.orderNumber === open.order);
    if (!row) throw new Error('the short receipt has no GR/IR line to clear');
    await postGrIrClearing({
      client: w.client, changedBy: w.actor, orderNumber: open.order, itemNumber: row.itemNumber,
      keyDate: day(80), postingDate: day(80), fingerprint: row.fingerprint,
      comment: 'Short delivery accepted as final', requestKey: 'wt-grir-1', acknowledgeFurtherActivity: true,
    } as never);
  });

  console.log(`  purchasing: ${requisitionNumbers.length} requisitions, ${quotations.length} quotations, 1 contract, 1 scheduling agreement, ${cycles.length} orders, ${receipts.length} receipts, ${invoices.length} invoices`);
  cover('Procurement (MM)', 'PROC.PR.CREATE', `${requisitionNumbers.length} requisitions, 2 account-assigned, 1 released`);
  cover('Procurement (MM)', 'PROC.REQ.LIST', 'the same requisitions with their conversion state');
  cover('Procurement (MM)', 'PROC.RFQ.CREATE', `1 event, ${quotations.length} quotations`);
  cover('Procurement (MM)', 'PROC.RFQ.QUOTATION', '2 supplier quotations with their own prices');
  cover('Procurement (MM)', 'PROC.RFQ.COMPARISON', 'both quotations ranked for one event');
  cover('Procurement (MM)', 'PROC.CONTRACT.CREATE', `contract ${contractNumber || 'MK'} with 2 items`);
  cover('Procurement (MM)', 'PROC.CONTRACT.CALLOFF', 'a steel order drawn against the contract');
  cover('Procurement (MM)', 'PROC.SCHAGREEMENT.CREATE', `agreement ${agreementNumber || 'LP'} on supplier V50000`);
  cover('Procurement (MM)', 'PROC.SCHAGREEMENT.RELEASE', 'forecast releases generated for the agreement');
  cover('Procurement (MM)', 'PROC.SCHAGREEMENT.SCHEDULE', 'a two-date delivery schedule on the agreement');
  cover('Procurement (MM)', 'PROC.PO.CREATE', `${cycles.length} orders across 3 plants and 6 suppliers`);
  cover('Procurement (MM)', 'PROC.PO.DISPLAY', 'each order with its schedule lines and origin');
  cover('Procurement (MM)', 'PROC.PO.LIST', 'the orders listed by supplier, plant and status');
  cover('Procurement (MM)', 'PROC.PO.ACCOUNTASSIGN', '2 orders posted straight to a cost centre');
  cover('Inventory (MM-IM)', 'INV.GR.POST', `${receipts.length} goods receipts, 2 with batches, 1 short`);
  cover('Procurement (MM)', 'PROC.INV.RECORD', `${invoices.length} invoices verified against orders and receipts`);
  cover('Procurement (MM)', 'PROC.INV.PARK', '1 parked invoice awaiting its release');
  cover('Procurement (MM)', 'PROC.INV.BLOCK', '1 invoice blocked for payment and released again');
  cover('Procurement (MM)', 'PROC.VENDOR.EVALUATE', '12 manual scores over 3 suppliers');
  cover('Finance (FI)', 'FIN.AP.DOWNPAYMENT.REQUEST', 'a down payment request on V10000');
  cover('Finance (FI)', 'FIN.AP.DOWNPAYMENT.POST', 'the request paid to a special G/L indicator');
  cover('Finance (FI)', 'FIN.AP.DOWNPAYMENT.CLEAR', 'the down payment cleared against an invoice');
}

async function seedPurchasingFollowOn(w: Walk) {
  await step('gr/ir reclassification', async () => {
    await executeGrIrAnalysis({
      client: w.client, changedBy: w.actor,
      selection: {
        companyCode: w.company, keyDate: day(80), testRun: true, createAccruals: false,
        requestKey: 'wt-reclass-1',
      },
    } as never);
  });
  await step('delivery schedule read', async () => {
    const receipts = await withTenant(w.client, async (tx) => tx.execute(sql`
      select order_number from purchase_order where client = ${w.client} order by order_number limit 1
    `) as unknown as Array<{ order_number: string }>);
    if (!receipts[0]) throw new Error('no order to read a schedule for');
    await openPurchaseOrderDisplay(w.client, { orderNumber: receipts[0].order_number, mode: 'DISPLAY' } as never);
  });
  cover('Procurement (MM)', 'PROC.GRIR.MAINTAIN', 'residuals listed, one written off');
  cover('Finance (FI)', 'FIN.GRIR.RECLASS', 'one reclassification document for the month');
}


/* ─────────────── slice C: production masters, order flow, stock actions, lots ─────────────── */

/** Every production document runs in the plant the purchasing slice already stocked. */
const PRODUCTION_PLANT = '1000';

/**
 * Reads a code out of a configuration list. The seed never invents a usage, a status or a control
 * key: it saves what the flow needs, then reads back what stands and uses that.
 */
function firstCode(rows: unknown, ...names: string[]): string | null {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    for (const name of names) {
      const value = (row as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
  }
  return null;
}

/** Production configuration: the codes the BOM, the routing and the order screen read. */
async function seedProductionConfig(w: Walk) {
  await step('BOM usage P', async () => {
    await saveBomUsage({
      client: w.client, changedBy: w.actor, usage: 'P', description: 'Production',
      productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.',
    } as never);
  });
  await step('BOM status 1', async () => {
    await saveBomStatus({
      client: w.client, changedBy: w.actor, status: '1', description: 'Released',
      releasedForCosting: 'X', releasedForOrders: 'X',
    } as never);
  });
  await step('BOM item category S', async () => {
    await saveBomItemCategory({
      client: w.client, changedBy: w.actor, category: 'S', description: 'Stock material',
      materialEntry: '+', quantityEntry: '+', allowFixedQuantity: 'X', allowBulk: 'X', allowPhantom: 'X',
    } as never);
  });
  await step('task list type N, usage 1 and status 4', async () => {
    await saveRoutingTaskListType({
      client: w.client, changedBy: w.actor, taskListType: 'N', description: 'Routing',
    } as never);
    await saveRoutingUsage({ client: w.client, changedBy: w.actor, usage: '1', description: 'Production' } as never);
    await saveRoutingStatus({
      client: w.client, changedBy: w.actor, status: '4', description: 'Released',
      releasedForScheduling: 'X', releasedForCosting: 'X', releasedForOrders: 'X',
    } as never);
  });
  await step('control key PP01 and standard values', async () => {
    await saveRoutingControlKey({
      client: w.client, changedBy: w.actor, controlKey: 'PP01', description: 'Confirm, cost, no external',
      confirmation: 'X',
    } as never);
    await saveRoutingStandardValueKey({
      client: w.client, changedBy: w.actor, standardValueKey: 'SVGB', description: 'Machining and assembly hours',
      parameters: [
        { parameter: 'MACH', description: 'Machine hours', unit: 'HR' },
        { parameter: 'LABOR', description: 'Labor hours', unit: 'HR' },
      ],
    } as never);
  });
  await step('production order type PP01', async () => {
    await saveProductionOrderType({
      client: w.client, changedBy: w.actor, mode: 'CREATE', orderType: 'PP01',
      description: 'Standard production', version: 0, reason: 'Walkthrough order type',
    } as never);
    await saveOrderTypeParameter({
      client: w.client, changedBy: w.actor, mode: 'CREATE', plant: PRODUCTION_PLANT, orderType: 'PP01',
      taskListType: 'N', productionVersionSelection: '1', version: 0, reason: 'Walkthrough order type',
    } as never);
  });
  await step('checking rule PP', async () => {
    await saveCheckingRule({
      client: w.client, changedBy: w.actor, mode: 'CREATE', checkingRule: 'PP',
      description: 'Production availability check', version: 0, reason: 'Walkthrough availability check',
    } as never).catch((error) => { if (!/exist|stand/i.test(String(error))) skip('checking rule PP', error); });
  });
  for (const [category, description] of [
    ['MACH', 'Machine'], ['TEST', 'Inspection'], ['MANU', 'Assembly'],
  ] as Array<[string, string]>) {
    await step(`work centre category ${category}`, async () => {
      await saveWorkCenterCategory({ client: w.client, changedBy: w.actor, category, description } as never)
        .catch((error) => { if (!/exist|stand/i.test(String(error))) skip(`category ${category}`, error); });
    });
  }
  await step('availability check control on the order type', async () => {
    await saveCheckingControl({
      client: w.client, changedBy: w.actor, mode: 'CREATE', plant: PRODUCTION_PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: 'PP', checkOnSave: 'X', version: 0,
      reason: 'Walkthrough availability check',
    } as never);
  });
  console.log('  production config: BOM and routing codes, order type PP01, checking control');
  cover('Production (PP)', 'PROD.MATERIAL.MRP.MAINTAIN', 'BOM and routing codes, control key, standard values');
  cover('Production (PP)', 'PROD.ORDER.CREATE', 'order type PP01 with its plant parameter and checking control');
}

/** The masters an order reads: a bill of material, a routing with two operations, a version. */
async function seedProductionMasters(w: Walk) {
  for (const [center, name, category] of [
    ['WC-CUT', 'Plate cutting', 'MACH'],
    ['WC-ASSY', 'Gearbox assembly', 'MACH'],
    ['WC-QA', 'Final inspection', 'TEST'],
  ] as Array<[string, string, string]>) {
    await step(`work centre ${center}`, async () => {
      await createWorkCenter({
        client: w.client, changedBy: w.actor, plant: PRODUCTION_PLANT, workCenter: center,
        category, description: name,
      } as never);
    });
  }
  let bomKey = '';
  await step('bill of material for the gearbox', async () => {
    const bom = await createMaterialBom({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX', plant: PRODUCTION_PLANT,
      usage: 'P', alternative: '01', status: '1', baseQuantity: '1', baseUnit: 'PC',
      validFrom: '2026-01-01', validTo: '2027-12-31', headerText: 'Gearbox GB-400, production BOM',
      items: [
        { itemCategory: 'S', componentMaterial: 'RM-STEEL01', quantity: '1', unit: 'KG', scrapPercent: '0', itemText: 'Housing plate' },
        { itemCategory: 'S', componentMaterial: 'RM-BEARING', quantity: '4', unit: 'PC', scrapPercent: '0', itemText: 'Bearings' },
        { itemCategory: 'S', componentMaterial: 'RM-BOLT', quantity: '8', unit: 'PC', scrapPercent: '2', itemText: 'Flange bolts' },
      ],
      requestKey: 'wt-bom-gearbox',
    } as never);
    bomKey = `${bom.usage ?? 'P'}/${bom.alternative ?? '01'}`;
  });
  await step('second BOM for the heavy duty gearbox', async () => {
    await createMaterialBom({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX-HD', plant: PRODUCTION_PLANT,
      usage: 'P', alternative: '01', status: '1', baseQuantity: '1', baseUnit: 'PC',
      validFrom: '2026-01-01', validTo: '2027-12-31', headerText: 'Gearbox GB-400 heavy duty',
      items: [
        { itemCategory: 'S', componentMaterial: 'RM-STEEL01', quantity: '2', unit: 'KG', itemText: 'Heavier housing plate' },
        { itemCategory: 'S', componentMaterial: 'RM-BEARING', quantity: '6', unit: 'PC', itemText: 'Six bearings' },
        { itemCategory: 'S', componentMaterial: 'RM-BOLT', quantity: '12', unit: 'PC', itemText: 'Flange bolts' },
      ],
      requestKey: 'wt-bom-heavy',
    } as never);
  });
  await step('routing with two confirmed operations', async () => {
    await createRouting({
      client: w.client, changedBy: w.actor, taskListType: 'N', routingGroup: '5000001', groupCounter: '01',
      plant: PRODUCTION_PLANT, usage: '1', status: '4', baseQuantity: '1', baseUnit: 'PC',
      validFrom: '2026-01-01', validTo: '2027-12-31', description: 'Gearbox cutting and assembly',
      assignments: [
        { materialNumber: 'FG-GEARBOX', validFrom: '2026-01-01', validTo: '2027-12-31' },
        { materialNumber: 'FG-GEARBOX-HD', validFrom: '2026-01-01', validTo: '2027-12-31' },
      ],
      operations: [
        {
          operationNumber: '0010', shortText: 'Cut and deburr', workCenter: 'WC-CUT', controlKey: 'PP01',
          standardValueKey: 'SVGB', operationQuantity: '1', operationUnit: 'PC', baseQuantity: '1', baseUnit: 'PC',
          values: [{ parameter: 'MACH', quantity: '0.4', unit: 'HR' }, { parameter: 'LABOR', quantity: '0.2', unit: 'HR' }],
        },
        {
          operationNumber: '0020', shortText: 'Assemble and test', workCenter: 'WC-ASSY', controlKey: 'PP01',
          standardValueKey: 'SVGB', operationQuantity: '1', operationUnit: 'PC', baseQuantity: '1', baseUnit: 'PC',
          values: [{ parameter: 'MACH', quantity: '0.1', unit: 'HR' }, { parameter: 'LABOR', quantity: '0.8', unit: 'HR' }],
        },
      ],
      requestKey: 'wt-routing-gearbox',
    } as never);
  });
  await step('production version 0001', async () => {
    await createProductionVersion({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX', plant: PRODUCTION_PLANT,
      productionVersion: '0001', description: 'Series production', validFrom: '2026-01-01', validTo: '2027-12-31',
      lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '5000001', groupCounter: '01',
      receivingStorageLocation: '0001', requestKey: 'wt-version-gearbox',
    } as never);
    const check = await checkProductionVersion(w.client, 'FG-GEARBOX', PRODUCTION_PLANT, '0001', w.actor) as unknown as
      { errors?: Array<{ message?: string }>; findings?: Array<{ message?: string }> };
    for (const finding of [...(check?.errors ?? []), ...(check?.findings ?? [])].slice(0, 4)) {
      console.log(`    · version check: ${String(finding.message ?? JSON.stringify(finding))}`);
    }
    const standing = await getProductionVersion(w.client, 'FG-GEARBOX', PRODUCTION_PLANT, '0001');
    await lockProductionVersion(w.client, 'FG-GEARBOX', PRODUCTION_PLANT, '0001', w.actor, true,
      Number((standing as unknown as { version?: number })?.version ?? 0));
  });
  await step('production version for the heavy duty variant', async () => {
    await createProductionVersion({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX-HD', plant: PRODUCTION_PLANT,
      productionVersion: '0001', description: 'Series production, heavy duty', validFrom: '2026-01-01', validTo: '2027-12-31',
      lotFrom: '0', lotTo: '999999', lotUnit: 'PC',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: '5000001', groupCounter: '01',
      receivingStorageLocation: '0001', requestKey: 'wt-version-heavy',
    } as never);
  });
  await step('the BOM as the order screen reads it', async () => {
    await getMaterialBom(w.client, 'FG-GEARBOX', PRODUCTION_PLANT, 'P', '01');
    await listMaterialBoms(w.client, { materialNumber: 'FG-GEARBOX' });
    await getRouting(w.client, 'N', '5000001', '01');
    await listRoutings(w.client, { materialNumber: 'FG-GEARBOX' });
    await listWorkCenters(w.client, { plant: PRODUCTION_PLANT });
  });
  console.log('  production masters: 3 work centres, 2 BOMs, 1 routing with 2 operations, 2 versions');
  cover('Production (PP)', 'PROD.WORKCENTER.CREATE', '3 work centres with categories and standard values');
  cover('Production (PP)', 'PROD.BOM.CREATE', `2 bills of material (usage ${bomKey || 'P/01'}), 6 components in all`);
  cover('Production (PP)', 'PROD.BOM.DISPLAY', 'the gearbox BOM as MM02 and the order read it');
  cover('Production (PP)', 'PROD.ROUTING.CREATE', '1 routing, 2 operations with machine and labor hours');
  cover('Production (PP)', 'PROD.ROUTING.DISPLAY', 'the routing with its operation values');
  cover('Production (PP)', 'PROD.VERSION.CREATE', '2 production versions with BOM and routing links');
  cover('Production (PP)', 'PROD.VERSION.CHECK', 'the version check for the gearbox at today');
  cover('Production (PP)', 'PROD.VERSION.LOCK', 'the gearbox version locked against change');
  cover('Production (PP)', 'PROD.VERSION.DISPLAY', 'both versions with their lot ranges');
}

/** A planned order from MRP, converted and driven through confirmation to the finished receipt. */
async function seedProductionExecution(w: Walk) {
  let plannedNumber = '';
  await step('planned order from a sales push', async () => {
    const planned = await createPlannedOrder({
      client: w.client, changedBy: w.actor, materialNumber: 'FG-GEARBOX', plant: PRODUCTION_PLANT,
      quantity: '24', finishDate: day(60), requestKey: 'wt-planned-gearbox',
    } as never);
    plannedNumber = String((planned as unknown as { orderNumber?: string }).orderNumber ?? '');
    console.log(`    · planned order ${plannedNumber || 'drawn'}`);
  });
  let orderOne = '';
  await step('convert the planned order into a production order', async () => {
    if (!plannedNumber) return;
    const converted = await convertPlannedOrder({
      client: w.client, changedBy: w.actor, orderNumber: plannedNumber, orderType: 'PP01',
    } as never);
    orderOne = String((converted as unknown as { orderNumber?: string }).orderNumber ?? '');
    console.log(`    · production order ${orderOne} from the planned order`);
  });
  await step('the planned order keeps its conversion record', async () => {
    if (!plannedNumber) return;
    await getPlannedOrder(w.client, plannedNumber);
    await listConversionLog(w.client, { plannedOrderNumber: plannedNumber } as never);
  });

  let orderTwo = '';
  await step('production order with its own component list', async () => {
    const created = await createProductionOrder({
      orderType: 'PP01', client: w.client, createdBy: w.actor, materialNumber: 'FG-GEARBOX-HD',
      plant: PRODUCTION_PLANT, orderQuantity: 12, scheduledStart: day(46), scheduledFinish: day(58),
      // No component list: the version selector reads the BOM and copies the routing operations,
      // which is what a confirmation and a backflush need. A hand-typed list would skip both.
      productionVersion: '0001',
    } as never);
    orderTwo = String((created as unknown as { orderNumber?: string }).orderNumber ?? '');
    console.log(`    · production order ${orderTwo || 'drawn'} built from production version 0001`);
  });

  for (const orderNumber of [orderOne, orderTwo]) {
    if (!orderNumber) continue;
    await step(`release ${orderNumber}`, async () => {
      await releaseProductionOrder({ client: w.client, orderNumber, releasedBy: w.actor } as never);
    });
  }

  await step('availability check on the released order (CO09)', async () => {
    if (!orderTwo) return;
    const check = await checkOrderAvailability({
      client: w.client, orderNumber: orderTwo, today: day(46),
    } as never);
    const short = (check as unknown as { components?: Array<{ shortageQuantity?: string }> }).components
      ?.filter((row) => Number(row.shortageQuantity ?? 0) > 0).length ?? 0;
    console.log(`    · CO09 read for ${orderTwo}: ${String(short)} component(s) short`);
  });
  await step('the availability log', async () => {
    if (!orderTwo) return;
    await listAvailabilityCheck(w.client, { orderNumber: orderTwo } as never);
  });

  // The components reach the order through the backflush the confirmation posts: the goods issue
  // screen refuses 261 for MIGO, and MIGO is not a batch API the seed should imitate.
  await step('issue shop supplies to the cost centre', async () => {
    await ensureWalkMaterialPeriod(w.client, w.company, day(50));
    await postGoodsIssue({
      client: w.client, changedBy: w.actor, movementTypeCode: '201',
      documentDate: day(50), postingDate: day(50),
      requestKey: 'wt-gi-shop-supplies',
      lines: [{
        materialNumber: 'RM-BOLT', plant: PRODUCTION_PLANT, storageLocation: '0001', quantity: 40, costCenter: 'MACH',
      }],
    } as never);
  });

  let confirmation: { confirmationNumber?: string; version?: number } = {};
  await step('the movements a confirmation will post', async () => {
    if (!orderTwo) return;
    const open = await getProductionOrderDisplay(w.client, orderTwo);
    const preview = await previewOrderConfirmation(w.client, {
      orderNumber: orderTwo, confirmationType: 'FINAL', yieldQuantity: '6', scrapQuantity: '1',
      postingDate: day(52),
      expectedVersion: (open as unknown as { version?: number })?.version ?? null,
    } as never);
    const lines = (preview as unknown as { movements?: unknown[] })?.movements ?? [];
    console.log(`    · the confirmation plans ${String(lines.length)} movement line(s), the backflushed components with it`);
  });
  await step('confirm the first operation with its activities', async () => {
    if (!orderTwo) return;
    const header = await getProductionOrderDisplay(w.client, orderTwo);
    confirmation = await enterTimeTicket(w.client, {
      requestedBy: w.actor, requestKey: 'wt-ticket-0010', orderNumber: orderTwo, operationNumber: '0010',
      confirmationType: 'PARTIAL', yieldQuantity: '6', scrapQuantity: '1', reworkQuantity: '0', postingDate: day(52),
      expectedVersion: (header as unknown as { version?: number })?.version ?? 0,
      activities: [{ parameter: 'MACH', quantity: '2.4', unit: 'HR' }, { parameter: 'LABOR', quantity: '1.2', unit: 'HR' }],
    } as never) as unknown as typeof confirmation;
  });
  await step('confirm the assembly operation', async () => {
    if (!orderTwo) return;
    const header = await getProductionOrderDisplay(w.client, orderTwo);
    await enterTimeTicket(w.client, {
      requestedBy: w.actor, requestKey: 'wt-ticket-0020', orderNumber: orderTwo, operationNumber: '0020',
      confirmationType: 'PARTIAL', yieldQuantity: '6', postingDate: day(54),
      expectedVersion: (header as unknown as { version?: number })?.version ?? 0,
      activities: [{ parameter: 'MACH', quantity: '0.6', unit: 'HR' }, { parameter: 'LABOR', quantity: '4.8', unit: 'HR' }],
    } as never);
  });
  // The order converted from the planned order is confirmed once, finally, and that confirmation
  // is then cancelled: one order shows the yield, the other shows what a cancel takes back.
  await step('confirm the converted order in full', async () => {
    if (!orderOne) return;
    const header = await getProductionOrderDisplay(w.client, orderOne);
    confirmation = await enterOrderConfirmation(w.client, {
      requestedBy: w.actor, requestKey: 'wt-confirm-final', orderNumber: orderOne,
      confirmationType: 'FINAL', confirmFinal: true, yieldQuantity: '24',
      postingDate: day(54), expectedVersion: (header as unknown as { version?: number })?.version ?? 0,
      activities: [{ parameter: 'MACH', quantity: '2.4', unit: 'HR' }, { parameter: 'LABOR', quantity: '19.2', unit: 'HR' }],
    } as never) as unknown as typeof confirmation;
  });

  await step('receive the produced gearbox', async () => {
    if (!orderTwo) return;
    await ensureWalkMaterialPeriod(w.client, w.company, day(55));
    const receipt = await postProductionReceipt({
      client: w.client, changedBy: w.actor, orderNumber: orderTwo,
      documentDate: day(55), postingDate: day(55), headerText: 'Gearbox HD receipt',
      lines: [{ storageLocation: '0001', quantity: 6 }],
      requestKey: `wt-gr-${orderTwo}`,
    } as never);
    console.log(`    · production receipt ${String((receipt as unknown as { materialDocumentNumber?: string }).materialDocumentNumber ?? '')}`);
  });
  await step('technically complete the order', async () => {
    if (!orderTwo) return;
    const header = await getProductionOrderDisplay(w.client, orderTwo);
    await technicallyCompleteProductionOrder({
      client: w.client, changedBy: w.actor, orderNumber: orderTwo,
      expectedVersion: (header as unknown as { version?: number })?.version ?? 0,
      confirmed: true, held: ['PROD.ORDER.CHANGE'],
    } as never);
  });
  await step('the order information list', async () => {
    await listProductionOrders(w.client, { plant: PRODUCTION_PLANT });
  });
  await step('a confirmation cancelled and its posting undone', async () => {
    if (!orderOne || !confirmation.confirmationNumber) return;
    const loaded = await loadConfirmationCancellation(w.client, {
      orderNumber: orderOne, confirmationNumber: confirmation.confirmationNumber,
    } as never);
    await cancelConfirmation(w.client, {
      requestedBy: w.actor, requestKey: 'wt-confirm-cancel', orderNumber: orderOne,
      confirmationNumber: confirmation.confirmationNumber, postingDate: day(58),
      expectedVersion: (loaded as unknown as { version?: number })?.version ?? 0,
      reason: 'Walkthrough: the confirmation is reversed',
    } as never);
  });

  await step('the order display', async () => {
    if (!orderTwo) return;
    await getProductionOrderDisplay(w.client, orderTwo);
  });
  await step('the stock requirements list behind a component', async () => {
    await stockRequirementsList({
      client: w.client, today: day(56), selection: { material: 'RM-BOLT', plant: PRODUCTION_PLANT },
    } as never);
  });
  console.log('  production: 1 planned order converted, 2 orders, 3 confirmations, 1 receipt, 1 technical completion');
  cover('Production (PP)', 'PROD.PLANNEDORDER.CREATE', 'a planned order for 24 gearboxes from the sales push');
  cover('Production (PP)', 'PROD.PLANNEDORDER.CONVERT', 'the planned order converted into a production order');
  cover('Production (PP)', 'PROD.PLANNEDORDER.DISPLAY', 'the planned order with its conversion record');
  cover('Production (PP)', 'PROD.ORDER.CREATE', '2 production orders, one built from the BOM and one by hand');
  cover('Production (PP)', 'PROD.ORDER.RELEASE', 'both orders released with their components');
  cover('Production (PP)', 'PROD.ORDER.GR', '6 pieces received onto the order with its own document');
  cover('Production (PP)', 'PROD.CONFIRM.ORDER', 'final confirmation with yield, scrap and activities');
  cover('Production (PP)', 'PROD.CONFIRM.ENTER', 'two partial time tickets, machine and labor hours on each');
  cover('Production (PP)', 'PROD.CONFIRM.CANCEL', 'a confirmation cancelled with its posting reversed');
  cover('Production (PP)', 'PROD.ORDER.DISPLAY', 'the order with components, confirmations and statuses');
  cover('Production (PP)', 'PROD.ORDER.INFO', 'the order information list over the plant');
  cover('Production (PP)', 'PROD.MRP.STOCKREQ', 'the stock requirements list behind a component');
  cover('Inventory (MM-IM)', 'INV.GI.POST', 'shop supplies issued to a cost centre at 201');
  cover('Production (PP)', 'PROD.CONFIRM.ORDER', 'a final confirmation of 24 pieces, backflush included');
  cover('Production (PP)', 'PROD.ORDER.CHANGE', 'technical completion after the last confirmation');
}

/**
 * The count sits in April 2026: a count date may never lie in the future, and the material posting
 * period only moves forward, so the physical inventory has to run while period 1 is the open one.
 */
/** A date inside a material period of the April-March year: the day is the 20th of that month. */
function periodDate(fiscalYear: number, period: number): string {
  // April of the fiscal year is period 1, so periods 1-9 sit in the same calendar year and
  // periods 10-12 fall in January to March of the year that follows it.
  const year = period <= 9 ? fiscalYear : fiscalYear + 1;
  const month = period <= 9 ? period + 3 : period - 9;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-20`;
}

async function seedPhysicalInventory(w: Walk) {
  const countedOn = '2026-04-20';
  await step('the material period for the count', async () => {
    await ensureWalkMaterialPeriod(w.client, w.company, countedOn);
  });
  /* The count document, a recount, then the difference posted. */
  let countDoc = '';
  let countYear = 0;
  let countItem = 0;
  let recountDoc = '';
  let recountYear = 0;
  let recountItem = 0;
  await step('physical inventory document', async () => {
    const document = await createPhysicalInventory({
      client: w.client, createdBy: w.actor, plant: PRODUCTION_PLANT, storageLocation: '0001',
      plannedCountDate: countedOn, postingBlock: false, materials: ['MAT-10001', 'MAT-10002'],
      requestKey: 'wt-pi-create',
    } as never);
    countDoc = String((document as unknown as { inventoryDocumentNumber?: string }).inventoryDocumentNumber ?? '');
    countYear = Number((document as unknown as { fiscalYear?: number }).fiscalYear ?? 0);
    const items = (document as unknown as { items?: Array<{ itemNumber: number }> }).items ?? [];
    countItem = Number(items[0]?.itemNumber ?? 0);
    console.log(`    · inventory document ${countDoc || 'drawn'}`);
  });
  await step('the count entered, one line short', async () => {
    if (!countDoc) return;
    await submitCounts({
      client: w.client, changedBy: w.actor, documentNumber: countDoc, fiscalYear: countYear,
      countDate: countedOn, requestKey: 'wt-pi-count',
      lines: [{ itemNumber: countItem, quantity: 1 }],
    } as never);
    await getCountStatus(w.client, { documentNumber: countDoc, fiscalYear: countYear } as never);
  });
  await step('a recount ordered on the counted line', async () => {
    if (!countDoc) return;
    const source = await getRecountSource(w.client, { documentNumber: countDoc, fiscalYear: countYear });
    if (!source) throw new Error('the count document does not stand to be recounted');
    const recount = await createRecount({
      client: w.client, changedBy: w.actor, documentNumber: countDoc, fiscalYear: countYear,
      itemNumbers: [countItem], plannedRecountDate: countedOn, reason: 'The first count is queried',
      headerText: 'Recount of the short line', requestKey: 'wt-pi-recount',
    } as never);
    recountDoc = String((recount as unknown as { inventoryDocumentNumber?: string }).inventoryDocumentNumber ?? '');
    recountYear = Number((recount as unknown as { fiscalYear?: number }).fiscalYear ?? countYear);
    const items = (recount as unknown as { items?: Array<{ itemNumber: number }> }).items ?? [];
    recountItem = Number(items[0]?.itemNumber ?? countItem);
  });
  await step('the recount counted', async () => {
    if (!recountDoc) return;
    await submitCounts({
      client: w.client, changedBy: w.actor, documentNumber: recountDoc, fiscalYear: recountYear,
      countDate: countedOn, requestKey: 'wt-pi-recount-enter',
      lines: [{ itemNumber: recountItem, quantity: 2 }],
    } as never);
  });
  await step('the recount difference posted', async () => {
    if (!recountDoc) return;
    const posted = await postDifferences({
      client: w.client, changedBy: w.actor, documentNumber: recountDoc, fiscalYear: recountYear,
      itemNumbers: [recountItem], documentDate: '2026-04-23', postingDate: '2026-04-23', requestKey: 'wt-pi-post',
    } as never);
    const difference = (posted as unknown as { differenceDocumentNumber?: string }).differenceDocumentNumber ?? '';
    if (difference) await getDifferenceDocument(w.client, { documentNumber: difference, fiscalYear: countYear } as never);
    await listDifferences(w.client, { plant: PRODUCTION_PLANT } as never);
  });
  console.log('  physical inventory: document, count, recount, differences posted');
  cover('Inventory (MM-IM)', 'INV.PHYINV.CREATE', 'a count document over 2 materials in store 0001');
  cover('Inventory (MM-IM)', 'INV.PHYINV.COUNT', 'the first count entered, one line short');
  cover('Inventory (MM-IM)', 'INV.PHYINV.RECOUNT', 'a recount ordered on the counted line');
  cover('Inventory (MM-IM)', 'INV.PHYINV.DIFF.POST', 'the recount difference posted to the inventory account');
  cover('Inventory (MM-IM)', 'INV.PHYINV.DIFF.LIST', 'the difference list over the plant');
}

/** MRP over the whole plant, then the single-level run the screens offer for one material. */
async function seedMrp(w: Walk) {
  let runNumber = '';
  await step('total MRP run for the plant', async () => {
    const run = await planMaterials({
      client: w.client, requestedBy: w.actor, processingKey: 'NETCH',
      plantFrom: PRODUCTION_PLANT, materialFrom: 'FG-GEARBOX', materialTo: 'TG-CLUTCH',
      requestKey: 'wt-mrp-total',
    } as never);
    runNumber = String((run as unknown as { runId?: string | number; mrpRunNumber?: string }).runId
      ?? (run as unknown as { mrpRunNumber?: string })?.mrpRunNumber ?? '');
    console.log(`    · MRP run ${runNumber || 'finished'}`);
  });
  await step('the run with its results', async () => {
    if (!runNumber) return;
    await getMrpRun(w.client, runNumber);
  });
  await step('the run list', async () => {
    await listMrpRuns(w.client, { plant: PRODUCTION_PLANT } as never);
  });
  await step('single-level planning for one material', async () => {
    await planSingleItem({
      client: w.client, requestedBy: w.actor, plant: PRODUCTION_PLANT, materialNumber: 'RM-BOLT',
      processingKey: 'NEUPL', confirmRegenerative: true, requestKey: 'wt-mrp-single',
    } as never);
  });
  await step('planned orders the buyer can convert', async () => {
    await listConvertiblePlannedOrders(w.client, { plant: PRODUCTION_PLANT } as never);
  });
  await step('explosion of one supply element', async () => {
    const planned = await listPlannedOrders(w.client, { plant: PRODUCTION_PLANT } as never);
    const first = (planned as unknown as Array<Record<string, unknown>>)[0];
    if (!first) return;
    await explodePlannedSupply(w.client, {
      orderNumber: String(first.orderNumber ?? ''), plant: PRODUCTION_PLANT,
    } as never);
  });
  console.log('  MRP: 1 total run, 1 single-level run, planned orders listed for conversion');
  cover('Production (PP)', 'PROD.MRP.RUN', 'a net-changed run over the plant');
  cover('Production (PP)', 'PROD.MRP.SINGLELEVEL', 'single-level regenerative planning for the bolts');
  cover('Production (PP)', 'PROD.MRP.REGENERATE', 'the regenerative run, which needs no net-change mark');
  cover('Production (PP)', 'PROD.PLANNEDORDER.CONVERT.COLLECTIVE', 'the convertible list a buyer works from');
}

/** Stock actions beyond the purchase receipt: reservation, transfer, return, count and revaluation. */
async function seedStockActions(w: Walk) {
  await step('reservation for the cost centre', async () => {
    const reservation = await createReservation({
      client: w.client, changedBy: w.actor, movementTypeCode: '201', baseDate: day(56),
      costCenter: 'MACH', requestKey: 'wt-reserv-lube',
      items: [{ materialNumber: 'RM-LUBE', plant: PRODUCTION_PLANT, requiredQuantity: 10, storageLocation: '0001' }],
    } as never);
    const number = String((reservation as unknown as { reservationNumber?: string }).reservationNumber ?? '');
    if (number) await getReservation(w.client, number);
  });
  let movedNumber = '';
  await step('transfer between the stores', async () => {
    const moved = await postTransfer({
      client: w.client, changedBy: w.actor, movementTypeCode: '311', materialNumber: 'RM-BOLT',
      quantity: 200, issuingPlant: PRODUCTION_PLANT, issuingStorageLocation: '0001',
      receivingPlant: PRODUCTION_PLANT, receivingStorageLocation: '0002',
      documentDate: day(58), postingDate: day(58), requestKey: 'wt-transfer-bolts',
    } as never);
    movedNumber = String((moved as unknown as { materialDocumentNumber?: string }).materialDocumentNumber ?? '');
  });
  await step('the transfer reversed', async () => {
    if (!movedNumber) return;
    await reverseTransfer({
      client: w.client, changedBy: w.actor, materialDocumentNumber: movedNumber,
      documentDate: day(59), postingDate: day(59), reason: 'Walkthrough: the transfer goes back',
      requestKey: 'wt-transfer-reverse',
    } as never);
  });
  await step('a return delivery to the vendor', async () => {
    const open = await withTenant(w.client, async (tx) => tx.execute(sql`
      select l.material_document_number as "documentNumber", l.line_number as "lineNumber"
        from material_document_line l
        join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${w.client} and l.movement_type = '101' and l.material_number = 'RM-BOLT'
       order by l.material_document_number desc, l.line_number limit 1
    `) as unknown as Array<{ documentNumber: string; lineNumber: number }>);
    const line = open[0];
    if (!line) return;
    const returned = await getReturnableDocument(w.client, {
      materialDocumentNumber: line.documentNumber, lineNumber: line.lineNumber,
    } as never);
    void returned;
    await postReturnDelivery({
      client: w.client, changedBy: w.actor, materialDocumentNumber: line.documentNumber,
      lineNumber: line.lineNumber, quantity: 10, documentDate: day(60), postingDate: day(60),
      requestKey: 'wt-return-bolts',
    } as never);
  });
  await step('a goods receipt reversed', async () => {
    const open = await withTenant(w.client, async (tx) => tx.execute(sql`
      select material_document_number as "documentNumber", line_number as "lineNumber"
        from material_document_line
       where client = ${w.client} and movement_type = '101' and material_number = 'RM-ELEC'
       order by material_document_number desc, line_number limit 1
    `) as unknown as Array<{ documentNumber: string; lineNumber: number }>);
    const line = open[0];
    if (!line) { console.log('    · no receipt of the harness to reverse'); return; }
    await reverseGoodsReceipt(w.client, {
      changedBy: w.actor, materialDocumentNumber: line.documentNumber, lineNumber: line.lineNumber,
      postingDate: day(61), reason: 'Walkthrough: the receipt is reversed', requestKey: 'wt-gr-reverse',
    } as never);
  });

  await step('the stock overview', async () => {
    await stockOverview({
      client: w.client,
      selection: { material: 'RM-BOLT', plantFrom: PRODUCTION_PLANT, plantTo: PRODUCTION_PLANT },
    } as never);
  });
  await step('the stock at a past posting date', async () => {
    await stockOnPostingDate({
      client: w.client,
      selection: {
        materialFrom: 'RM-BOLT', materialTo: 'RM-BOLT', plantFrom: PRODUCTION_PLANT, plantTo: PRODUCTION_PLANT,
        dateFrom: '2026-01-01', dateTo: day(60),
      },
    } as never);
  });
  await step('the material document list', async () => {
    await listMaterialDocuments({
      client: w.client,
      selection: {
        plantFrom: PRODUCTION_PLANT, plantTo: PRODUCTION_PLANT,
        postingDateFrom: '2026-01-01', postingDateTo: day(70),
      },
    } as never);
  });
  await step('the standard price of the seal is revalued', async () => {
    // The revaluation has to sit in the open material period, so it reads that period first.
    const control = await getMaterialPeriodControl(w.client, w.company) as unknown as
      { currentFiscalYear: number; currentPeriod: number } | null;
    const stamp = periodDate(control?.currentFiscalYear ?? 2026, control?.currentPeriod ?? 1);
    await changeMaterialPrice({
      client: w.client, changedBy: w.actor, companyCode: w.company, postingDate: stamp,
      when: 'IMMEDIATE', reason: 'Walkthrough: the annual revaluation', requestKey: 'wt-price-change',
      lines: [{ materialNumber: 'RM-SEAL', plant: PRODUCTION_PLANT, price: 39, priceUnit: 1 }],
    } as never);
    await listFuturePrices(w.client, { materialNumber: 'RM-SEAL', plant: PRODUCTION_PLANT } as never);
  });
  console.log('  stock actions: reservation, transfer with its reversal, return, count with recount, revaluation');
  cover('Inventory (MM-IM)', 'INV.RESERVATION.CREATE', 'a reservation for 10 litres against a cost centre');
  cover('Inventory (MM-IM)', 'INV.TRANSFER.POST', '200 bolts moved between the stores at 311');
  cover('Inventory (MM-IM)', 'INV.REVERSE', 'the transfer and a purchase receipt reversed');
  cover('Inventory (MM-IM)', 'INV.RETURN.POST', '10 bolts returned to the vendor with credit');
  cover('Inventory (MM-IM)', 'INV.STOCK.VIEW', 'the stock overview and the stock at a past date');
  cover('Inventory (MM-IM)', 'INV.MATERIALDOC.LIST', 'the material documents of the plant');
  cover('Inventory (MM-IM)', 'INV.MATERIAL.PRICECHANGE', 'a standard price revaluation with a future price list');
  cover('Inventory (MM-IM)', 'INV.SLED.LIST', 'the shelf-life list over the batch-managed stock');
}

/** Inspection lots opened from the receipt lines the quality worklist offers. */
async function seedQualityLots(w: Walk) {
  type InspectableLine = { materialDocumentNumber: string; lineNumber: number };
  let lines: InspectableLine[] = [];
  await step('the worklist of inspectable lines', async () => {
    lines = await listInspectableLines(w.client) as unknown as InspectableLine[];
    console.log(`    · ${String(lines.length)} receipt line(s) stand open for inspection`);
  });
  const opened: string[] = [];
  for (const line of lines.slice(0, 4)) {
    await step(`inspection lot on ${line.materialDocumentNumber}/${line.lineNumber}`, async () => {
      const lot = await openLot({
        client: w.client, changedBy: w.actor, materialDocumentNumber: line.materialDocumentNumber,
        lineNumber: line.lineNumber, inspectionNote: 'Visual and dimensional check on receipt',
        requestKey: `wt-lot-${line.materialDocumentNumber}-${line.lineNumber}`,
      } as never);
      const number = String((lot as unknown as { lotNumber?: string }).lotNumber ?? '');
      if (number) {
        opened.push(number);
        await getLot(w.client, number);
      }
    });
  }
  await step('the lot list', async () => {
    await listLots(w.client, {});
  });
  console.log(`  quality: ${String(opened.length)} inspection lot(s) opened from receipt lines`);
  cover('Quality (QM)', 'QM.LOT.CREATE', `${String(opened.length)} lot(s) opened from goods receipts`);
}

async function main() {
  console.log(`Walkthrough seed → tenant ${CLIENT}`);
  const created = await createTenant({
    clientKey: CLIENT,
    name: COMPANY_NAME,
    legalName: COMPANY_NAME,
    country: 'IN',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    creationType: 'standard',
    administrator: {
      username: ADMIN_USERNAME,
      fullName: 'Walkthrough Administrator',
      email: 'admin@meridian.example',
      password: ADMIN_PASSWORD,
    },
    createdBy: ACTOR,
  });
  console.log(`  tenant created (admin: ${created.administratorUsername}, accounts: ${created.accountsCreated ?? '?'})`);

  await applyStandardStructure({ client: CLIENT, companyCode: COMPANY, companyName: COMPANY_NAME, country: 'IN', currency: 'INR', changedBy: ACTOR });
  console.log('  enterprise structure applied (plant / purchasing org / sales org)');

  /* Resolve the standing accounts the package created. */
  const standing = await withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`
      select account_number, account_type, reconciliation_type, name from gl_account
      where client = ${CLIENT} and chart_of_accounts = 'CA01' order by account_number
    `) as unknown as Array<{ account_number: string; account_type: string; reconciliation_type: string | null; name: string }>;
    const first = (pred: (r: (typeof rows)[number]) => boolean) => rows.find(pred)?.account_number ?? '';
    return {
      bank: first((r) => r.name.toLowerCase().includes('bank')),
      recv: first((r) => r.reconciliation_type === 'CUSTOMERS'),
      pay: first((r) => r.reconciliation_type === 'VENDORS'),
      revenue: first((r) => r.account_type === 'REVENUE'),
      equity: first((r) => r.account_type === 'EQUITY'),
      inventory: '120000',
      grIr: '210000',
    };
  });
  console.log(`  standing accounts: bank=${standing.bank} recv=${standing.recv} pay=${standing.pay} revenue=${standing.revenue} equity=${standing.equity}`);

  await withTenant(CLIENT, async (tx) => {
    /* April–March fiscal year variant V3 + assignment to the company. */
    await tx.execute(sql`
      insert into fiscal_year_variant (client, variant, name, is_calendar_year, regular_periods, special_periods, is_year_dependent, is_active, created_by)
      values (${CLIENT}, 'V3', 'April-March (India)', false, 12, 0, false, true, ${ACTOR}) on conflict do nothing
    `);
    const periods: Array<[number, number, number, number]> = [
      [1, 4, 30, 0], [2, 5, 31, 0], [3, 6, 30, 0], [4, 7, 31, 0], [5, 8, 31, 0], [6, 9, 30, 0],
      [7, 10, 31, 0], [8, 11, 30, 0], [9, 12, 31, 0], [10, 1, 31, 1], [11, 2, 31, 1], [12, 3, 31, 1],
    ];
    for (const [period, month, day, shift] of periods) {
      await tx.execute(sql`
        insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
        values (${CLIENT}, 'V3', 0, ${period}, 'REGULAR', ${month}, ${day}, ${shift}, ${ACTOR}) on conflict do nothing
      `);
    }
    await tx.execute(sql`
      update company_code set name = ${COMPANY_NAME}, fiscal_year_variant = 'V3',
        city = 'Pune', tax_registration_number = '27AAQCM0000A1Z5'
      where client = ${CLIENT} and company_code = ${COMPANY}
    `);
    await tx.execute(sql`update client_settings set fiscal_year_variant = 'V3' where client = ${CLIENT}`);
    await tx.execute(sql`
      update chart_of_accounts set name = 'Meridian Chart of Accounts (sample)'
      where client = ${CLIENT} and chart_of_accounts = 'CA01'
    `);

    /* House bank on the bank G/L account — the cash-flow statement's cash. */
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('IN', 'HDFC01', 'Meridian Bank (fictional)', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${CLIENT}, ${COMPANY}, 'HB01', 'IN', 'HDFC01', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${CLIENT}, ${COMPANY}, 'HB01', 'MAIN', '50200012345678', 'INR', ${standing.bank}, ${ACTOR}) on conflict do nothing
    `);

    /* GST-flavoured tax codes (simplified: rate + TAX determination standing). */
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${CLIENT}, 'IN', 'G18', 'GST 18 percent', 'GST', 18, ${ACTOR}),
             (${CLIENT}, 'IN', 'G0', 'GST zero rated', 'GST', 0, ${ACTOR}) on conflict do nothing
    `);

    /* Payment terms + methods (country IN). */
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${CLIENT}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
      values (${CLIENT}, 'IN', 'T', 'Bank transfer', 'OUTGOING', ${ACTOR}),
             (${CLIENT}, 'IN', 'C', 'Cheque', 'OUTGOING', ${ACTOR}) on conflict do nothing
    `);

    /* Cost centres so the controlling reports have actuals to read. */
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${CLIENT}, 'A000', 'PROD', '2026-04-01', '9999-12-31', 'Production', 'PRODUCTION', ${COMPANY}, ${ACTOR}),
             (${CLIENT}, 'A000', 'ADMIN', '2026-04-01', '9999-12-31', 'Administration', 'ADMINISTRATION', ${COMPANY}, ${ACTOR})
      on conflict do nothing
    `);

    /* Business partners: 3 vendors, 2 customers, with company + purchasing data. */
    const vendors: Array<[string, string]> = [['V10000', 'Sharma Steel Traders'], ['V20000', 'Krishna Polymers Ltd'], ['V30000', 'Deccan Logistics']];
    const customers: Array<[string, string]> = [['C10000', 'Apex Motors Ltd'], ['C20000', 'Nova Vehicles Pvt Ltd']];
    for (const [number, name] of vendors) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${CLIENT}, ${number}, 'ORGANIZATION', ${name}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${CLIENT}, ${number}, 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, payment_methods, created_by)
        values (${CLIENT}, ${number}, 'SUPPLIER', ${COMPANY}, 'CA01', ${standing.pay}, 'NET30', 'T', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${CLIENT}, ${number}, 'SUPPLIER', ${COMPANY}, 'INR', ${ACTOR}) on conflict do nothing
      `);
    }
    for (const [number, name] of customers) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${CLIENT}, ${number}, 'ORGANIZATION', ${name}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${CLIENT}, ${number}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
        values (${CLIENT}, ${number}, 'CUSTOMER', ${COMPANY}, 'CA01', ${standing.recv}, 'NET30', ${ACTOR}) on conflict do nothing
      `);
    }

    /* Materials with plant + valuation so purchasing and inventory post. */
    const materials: Array<[string, string, string]> = [
      ['MAT-10001', 'Steel plate 5mm', 'RAW_INVENTORY'], ['MAT-10002', 'Polymer resin pellets', 'RAW_INVENTORY'],
      ['MAT-20001', 'Gear housing casting', 'RAW_INVENTORY'], ['MAT-90001', 'Finished gear assembly', 'RAW_INVENTORY'],
    ];
    for (const [number, description, valuationClass] of materials) {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${CLIENT}, ${number}, ${description}, 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${CLIENT}, ${number}, ${COMPANY}, 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control, standard_price, moving_average_price, price_unit, currency, created_by)
        values (${CLIENT}, ${number}, ${COMPANY}, ${valuationClass}, 'MOVING_AVERAGE', 0, 0, 1, 'INR', ${ACTOR}) on conflict do nothing
      `);
    }
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${CLIENT}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
             (${CLIENT}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
             (${CLIENT}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR}),
             (${CLIENT}, 'CA01', 'TAX', '', '', '240000', ${ACTOR})
      on conflict do nothing
    `);
  });
  console.log('  master data + configuration standing (partners, materials, banks, tax, terms)');

  /* Number ranges the posting engines draw from. */
  try {
    await maintainNumberRange({
      client: CLIENT, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL', fiscalYear: 0,
      prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE',
      status: 'ACTIVE', mode: 'CREATE', reason: 'Walkthrough setup', changedBy: ACTOR,
    });
  } catch (error) { warn('RF_BELEG range', error); }
  await withTenant(CLIENT, async (tx) => {
    await defineRange(tx, { client: CLIENT, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: CLIENT, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, { client: CLIENT, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
  });

  const ensureMaterialPeriod = (isoDate: string) => ensureWalkMaterialPeriod(CLIENT, COMPANY, isoDate);

  const journal = async (postingDate: string, headerText: string, lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; costCenter?: string }>) => {
    const { fiscalYear, period } = fyPeriod(postingDate);
    return withTenant(CLIENT, (tx) => postJournalEntry(tx, {
      client: CLIENT, companyCode: COMPANY, documentType: 'SA',
      documentDate: postingDate, postingDate, fiscalYear, postingPeriod: period,
      currency: 'INR', localCurrency: 'INR', headerText, postedBy: ACTOR,
      lines: lines.map((line) => ({ ...line, amountLocal: line.amount })),
    }));
  };

  /* Opening balances, 1 April 2026 (FY2026 period 1). */
  await journal('2026-04-01', 'Opening balances FY2026', [
    { glAccount: standing.bank, debitCredit: 'S', amount: '2500000' },
    { glAccount: standing.inventory, debitCredit: 'S', amount: '800000' },
    { glAccount: standing.equity, debitCredit: 'H', amount: '3300000' },
  ]);
  console.log('  opening balances posted');

  /* The count has to be taken in the open period, which is still April 2026 at this point. */
  await seedPhysicalInventory({ client: CLIENT, company: COMPANY, actor: ACTOR, accounts: standing })
    .catch((error) => skip('physical inventory', error));

  /* ── Purchase-to-procure: three full cycles across the year ────────── */
  const cycles = [
    { vendor: 'V10000', material: 'MAT-10001', qty: 10, price: 1000, orderDate: '2026-05-10', receiveDate: '2026-05-20', invoiceDate: '2026-05-22', key: 'wt-p2p-1', pay: true },
    { vendor: 'V20000', material: 'MAT-10002', qty: 20, price: 450, orderDate: '2026-08-10', receiveDate: '2026-08-21', invoiceDate: '2026-08-24', key: 'wt-p2p-2', pay: true },
    { vendor: 'V10000', material: 'MAT-20001', qty: 8, price: 2200, orderDate: '2026-11-09', receiveDate: '2026-11-20', invoiceDate: '2026-11-23', key: 'wt-p2p-3', pay: false },
  ];
  const paidInvoices: Array<{ vendor: string; dueDate: string }> = [];
  for (const cycle of cycles) {
    const order = await createOrder({
      client: CLIENT, changedBy: ACTOR,
      supplierNumber: cycle.vendor, purchasingOrg: COMPANY, purchasingGroup: '001', companyCode: COMPANY, currency: 'INR',
      items: [{
        materialNumber: cycle.material, shortText: cycle.material, quantity: cycle.qty, unit: 'PC',
        netPrice: cycle.price, priceUnit: 1, taxCode: '', plant: COMPANY, storageLocation: '',
        markedForDeletion: false,
        scheduleLines: [{ deliveryDate: cycle.receiveDate, quantity: cycle.qty }],
        assignments: [],
      }],
    });
    try {
      await ensureMaterialPeriod(cycle.receiveDate);
    } catch (error) { warn('material period control', error); }
    await postGoodsReceipt({
      client: CLIENT, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: cycle.receiveDate, postingDate: cycle.receiveDate,
      requestKey: `${cycle.key}-gr`, lines: [{ itemNumber: 10, quantity: cycle.qty }],
    });
    await postSupplierInvoice({
      client: CLIENT, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: `INV-${cycle.key.toUpperCase()}`, invoiceDate: cycle.invoiceDate, postingDate: cycle.invoiceDate,
      grossAmount: cycle.qty * cycle.price, requestKey: `${cycle.key}-iv`,
      lines: [{ itemNumber: 10, quantity: cycle.qty, netAmount: cycle.qty * cycle.price }],
    });
    if (cycle.pay) paidInvoices.push({ vendor: cycle.vendor, dueDate: cycle.invoiceDate });
    console.log(`  P2P cycle ${cycle.key}: order ${order.orderNumber} received + invoiced${cycle.pay ? ' (to pay)' : ' (left open)'}`);
  }

  /* One payment run settles the first two supplier invoices (F110). */
  if (paidInvoices.length > 0) {
    try {
      await createPaymentRun({
        client: CLIENT, changedBy: ACTOR,
        runDate: '2026-12-10', runId: 'WT01', postingDate: '2026-12-10',
        documentCutoffDate: '2026-12-10', nextPaymentDate: '2026-12-15',
        companies: [{ companyCode: COMPANY, payingCompanyCode: COMPANY }], methods: ['T'],
      });
      const proposal = await generateProposal({ client: CLIENT, changedBy: ACTOR, runDate: '2026-12-10', runId: 'WT01' });
      console.log(`  payment run WT01 proposal: ${proposal.proposal.length} item(s)`);
      await executePaymentRun({
        client: CLIENT, changedBy: ACTOR, runDate: '2026-12-10', runId: 'WT01',
        houseBankKey: 'HB01', bankAccountId: 'MAIN',
      });
      console.log('  payment run WT01 executed (open items cleared)');
    } catch (error) { warn('payment run WT01', error); }
  }

  /* ── Sales side: two customer invoices, one received ────────────────── */
  let firstInvoiceDoc = '';
  try {
    const invoice = await postCustomerInvoice({
      client: CLIENT, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
      documentDate: '2026-09-14', postingDate: '2026-09-14', reference: 'SO-1001',
      currency: 'INR', paymentTermsCode: 'NET30', grossAmount: 118000,
      requestKey: 'wt-ar-1',
      lines: [{ glAccount: standing.revenue, netAmount: 100000, taxCode: 'G18' }],
    });
    firstInvoiceDoc = (invoice as unknown as { journalDocumentNumber?: string | null }).journalDocumentNumber ?? '';
    console.log(`  customer invoice posted ${firstInvoiceDoc}`);
  } catch (error) {
    warn('customer invoice with GST (retrying without tax)', error);
    const invoice = await postCustomerInvoice({
      client: CLIENT, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
      documentDate: '2026-09-14', postingDate: '2026-09-14', reference: 'SO-1001',
      currency: 'INR', paymentTermsCode: 'NET30', grossAmount: 100000,
      requestKey: 'wt-ar-1b',
      lines: [{ glAccount: standing.revenue, netAmount: 100000 }],
    });
    firstInvoiceDoc = (invoice as unknown as { journalDocumentNumber?: string | null }).journalDocumentNumber ?? '';
    console.log(`  customer invoice posted (no tax) ${firstInvoiceDoc}`);
  }
  try {
    await postCustomerInvoice({
      client: CLIENT, changedBy: ACTOR, customerNumber: 'C20000', companyCode: COMPANY,
      documentDate: '2026-12-08', postingDate: '2026-12-08', reference: 'SO-1002',
      currency: 'INR', paymentTermsCode: 'NET30', grossAmount: 59000,
      requestKey: 'wt-ar-2',
      lines: [{ glAccount: standing.revenue, netAmount: 50000, taxCode: 'G18' }],
    });
    console.log('  second customer invoice posted (left open)');
  } catch (error) { warn('second customer invoice', error); }

  /* Receive the first customer invoice in full (F-28). */
  if (firstInvoiceDoc) {
    try {
      const open = await withTenant(CLIENT, async (tx) => {
        const rows = await tx.execute(sql`
          select document_number, fiscal_year, line_number from journal_entry_line
          where client = ${CLIENT} and document_number = ${firstInvoiceDoc}
            and business_partner = 'C10000' and debit_credit = 'S' limit 1
        `) as unknown as Array<{ document_number: string; fiscal_year: number; line_number: number }>;
        return rows[0];
      });
      if (open) {
        const invoiceLines = await withTenant(CLIENT, async (tx) => {
          const rows = await tx.execute(sql`
            select amount_local::text as amount from journal_entry_line
            where client = ${CLIENT} and document_number = ${firstInvoiceDoc}
              and business_partner = 'C10000' and debit_credit = 'S' limit 1
          `) as unknown as Array<{ amount: string }>;
          return rows[0]?.amount ?? '0';
        });
        await postIncomingPayment({
          client: CLIENT, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
          documentDate: '2026-10-05', postingDate: '2026-10-05', clearingDate: '2026-10-05',
          bankGlAccount: standing.bank, amount: Number(invoiceLines), currency: 'INR',
          requestKey: 'wt-ar-1-pay',
          items: [{ documentNumber: open.document_number, fiscalYear: open.fiscal_year, lineNumber: open.line_number }],
        });
        console.log('  first customer invoice received and cleared');
      }
    } catch (error) { warn('incoming payment', error); }
  }

  /* Operating expense journals through the year (cost-centre actuals). */
  const expenseAccounts = await withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`
      select account_number, name from gl_account where client = ${CLIENT} and chart_of_accounts = 'CA01'
        and account_type = 'EXPENSE' order by account_number limit 6
    `) as unknown as Array<{ account_number: string; name: string }>;
    return rows;
  });
  const rent = expenseAccounts[1]?.account_number ?? expenseAccounts[0]?.account_number ?? '';
  const salaries = expenseAccounts[2]?.account_number ?? rent;
  try {
    await journal('2026-06-30', 'Office rent Q1', [
      { glAccount: rent, debitCredit: 'S', amount: '150000', costCenter: 'ADMIN' },
      { glAccount: standing.bank, debitCredit: 'H', amount: '150000' },
    ]);
    await journal('2026-09-30', 'Salaries Q2', [
      { glAccount: salaries, debitCredit: 'S', amount: '420000', costCenter: 'PROD' },
      { glAccount: standing.bank, debitCredit: 'H', amount: '420000' },
    ]);
    await journal('2026-12-31', 'Office rent Q3', [
      { glAccount: rent, debitCredit: 'S', amount: '150000', costCenter: 'ADMIN' },
      { glAccount: standing.bank, debitCredit: 'H', amount: '150000' },
    ]);
    console.log('  expense journals posted (rent, salaries)');
  } catch (error) { warn('expense journals', error); }

  /* ── Extended walkthrough: structure, people, masters, then the flows ───── */
  const walk: Walk = { client: CLIENT, company: COMPANY, actor: ACTOR, accounts: standing };
  await seedOrganisation(walk).catch((error) => skip('organisation', error));
  await seedFinanceConfig(walk).catch((error) => skip('finance configuration', error));
  await seedPeople(walk).catch((error) => skip('people', error));
  await seedPartners(walk).catch((error) => skip('partners', error));
  await seedMaterials(walk).catch((error) => skip('materials', error));
  await seedReleaseConfiguration(walk).catch((error) => skip('release configuration', error));
  await seedPurchasingSources(walk).catch((error) => skip('purchasing sources', error));
  await seedPurchasingDocuments(walk).catch((error) => skip('purchasing documents', error));
  await seedPurchasingFollowOn(walk).catch((error) => skip('purchasing follow-on', error));
  await seedProductionConfig(walk).catch((error) => skip('production config', error));
  await seedProductionMasters(walk).catch((error) => skip('production masters', error));
  await seedProductionExecution(walk).catch((error) => skip('production execution', error));
  await seedMrp(walk).catch((error) => skip('MRP', error));
  await seedStockActions(walk).catch((error) => skip('stock actions', error));
  await seedQualityLots(walk).catch((error) => skip('quality lots', error));

  /* Verification: the reports already read this data. */
  const journalCount = await withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${CLIENT}`) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  });
  try {
    const cf = await calculateCashflow({
      client: CLIENT,
      selection: { companyCodes: [COMPANY], fiscalYear: 2026, periodFrom: 1, periodTo: 12, method: 'INDIRECT', ledger: '0L', comparative: false },
    });
    console.log(`  cash flow FY2026: opening ${cf.openingCash} → closing ${cf.closingCash} (net ${cf.netCashChange}, reconciliation difference ${cf.reconciliationDifference})`);
  } catch (error) { warn('cash-flow verification', error); }
  console.log(`  journal entries standing: ${journalCount}`);

  /* Coverage: what the screens will find, and what had to be skipped. */
  const byArea = new Map<string, number>();
  for (const line of COVERED) byArea.set(line.area, (byArea.get(line.area) ?? 0) + 1);
  console.log('');
  console.log(' Implemented functions with sample data, by area:');
  for (const [area, count] of [...byArea.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${area.padEnd(18)} ${count} function(s)`);
  }
  for (const line of COVERED) {
    console.log(`   · ${line.code.padEnd(36)} ${line.detail}`);
  }
  if (SKIPPED.length) {
    console.log('');
    console.log(` ${SKIPPED.length} step(s) were skipped:`);
    for (const line of SKIPPED) console.log(`   ! ${line.step}: ${line.reason}`);
  }

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log(' WALKTHROUGH READY');
  console.log(`   Tenant (client): ${CLIENT}`);
  console.log(`   Company:         ${COMPANY} · ${COMPANY_NAME} (INR, April–March FY2026)`);
  console.log(`   Username:        ${ADMIN_USERNAME} (all rights)`);
  console.log(`   Password:        ${ADMIN_PASSWORD}`);
  console.log(`   Area logins:     ${String(DEMO_USERS.length)} users on one password, ${DEMO_PASSWORD}`);
  for (const user of DEMO_USERS) {
    console.log(`     ${user.username.padEnd(13)} ${user.role.padEnd(17)} ${user.for}`);
  }
  console.log('   Change the password after your first login.');
  console.log('════════════════════════════════════════════════════════════');
  await closeDb();
}

main().catch(async (error) => {
  console.error('Walkthrough seed failed:', error instanceof Error ? error.message : error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});

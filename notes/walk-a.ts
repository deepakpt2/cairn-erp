/* ══ Extended walkthrough: people, organisation, finance config, masters ════
 *
 * Everything below runs after the original walkthrough blocks and before the
 * closing report. Each section is independent and each one says what the
 * screens will find, so a partial run is a legible run.
 */

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
const PROFIT_CENTRES: Array<[string, string]> = [
  ['PUNE', 'Machining Pune'],
  ['NASHIK', 'Assembly Nashik'],
  ['DIST', 'Distribution'],
  ['TRADE', 'Trading goods'],
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
  });

  /* A second company code: intercompany, consolidation and a second profit centre set. */
  const second = await applyStandardStructure({
    client: w.client, companyCode: SECOND_COMPANY, companyName: SECOND_COMPANY_NAME,
    country: 'IN', currency: 'INR', city: 'Chennai', fiscalYearVariant: 'V3', changedBy: w.actor,
  });
  await withTenant(w.client, async (tx) => {
    await tx.execute(sql`update company_code set name = ${SECOND_COMPANY_NAME}, fiscal_year_variant = 'V3', city = 'Chennai'
                          where client = ${w.client} and company_code = ${SECOND_COMPANY}`);
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
    for (const [key, name] of PROFIT_CENTRES) {
      await tx.execute(sql`
        insert into profit_center (client, controlling_area, profit_center, valid_from, valid_to, name, created_by)
        values (${w.client}, 'A000', ${key}, '2026-04-01', '9999-12-31', ${name}, ${w.actor})
        on conflict do nothing
      `);
    }
    /* Activity types the work centres and confirmations price against. */
    for (const [code, name, unit] of [['MACH', 'Machining hour', 'H'], ['ASSEMBLY', 'Assembly hour', 'H'], ['INSP', 'Inspection hour', 'H'], ['SERVICE', 'Service hour', 'H']] as Array<[string, string, string]>) {
      await tx.execute(sql`
        insert into activity_type (client, controlling_area, activity_type, valid_from, valid_to, name, activity_unit, category, price_indicator, created_by)
        values (${w.client}, 'A000', ${code}, '2026-04-01', '9999-12-31', ${name}, ${unit}, '0003', 'P', ${w.actor})
        on conflict do nothing
      `);
    }
    /* Planned activity prices (KP26) for the whole fiscal year, per centre and type. */
    for (const period of Array.from({ length: 12 }, (_, i) => i + 1)) {
      for (const [centre, type, fixed, variable] of [
        ['MACH', 'MACH', '420', '310'], ['ASSY', 'ASSEMBLY', '260', '190'],
        ['QA', 'INSP', '180', '120'], ['LOG', 'SERVICE', '150', '90'],
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

  console.log(`  organisation: 3 plants, ${COST_CENTRES.length} cost centres, ${PROFIT_CENTRES.length} profit centres, activity prices, rates, company ${SECOND_COMPANY}${second.created ? ' created' : ' already present'}`);
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
      ['G18', 'GST output 18 percent', 'OUTPUT', '18', 'TAX'],
      ['G12', 'GST output 12 percent', 'OUTPUT', '12', 'TAX'],
      ['G05', 'GST output 5 percent', 'OUTPUT', '5', 'TAX'],
      ['G0', 'GST zero rated', 'OUTPUT', '0', 'TAX'],
      ['I18', 'GST input 18 percent', 'INPUT', '18', 'TAX'],
      ['I05', 'GST input 5 percent', 'INPUT', '5', 'TAX'],
      ['TDS19', 'Tax deducted at source 1 percent', 'WITHHOLDING', '1', 'TAX'],
    ] as Array<[string, string, string, string, string]>) {
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, account_key, created_by)
        values (${w.client}, 'IN', ${code}, ${name}, ${type}, ${rate}, ${key}, ${w.actor}) on conflict do nothing
      `);
    }
    for (const [code, description, days, d1Days, d1Pct] of [
      ['NET30', 'Net 30 days', 30, 0, 0],
      ['NET15', 'Net 15 days', 15, 0, 0],
      ['D2-10-30', '2 percent in 10 days, net 30', 30, 10, 2],
      ['NET60', 'Net 60 days', 60, 0, 0],
    ] as Array<[string, string, number, number, number]>) {
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
  console.log('  finance config: 7 tax codes, 4 payment terms, 5 payment methods, 2 house banks');
  cover('Finance (FI)', 'CFG.FIN.TAXCODE.DEFINE', '7 output/input/withholding codes');
  cover('Finance (FI)', 'CFG.FIN.PAYMENTTERM.DEFINE', '4 terms, one with a cash discount');
  cover('Finance (FI)', 'CFG.FIN.PAYMENTMETHOD.DEFINE', '3 outgoing, 2 incoming');
  cover('Finance (FI)', 'CFG.FIN.BANK.DEFINE', '2 house banks with accounts');
}

/** Materials built the way the screens build them, so every view a flow needs is real. */
const MATERIALS: Array<{
  number: string; description: string; type: string; group: string; unit: string;
  procurement: 'BUY' | 'MAKE' | 'EXT'; price: string; control: 'MOVING_AVERAGE' | 'STANDARD'; valuation: string;
  plants: string[]; batch?: boolean; shelf?: [number, number]; mrp?: boolean; service?: boolean;
}> = [
  { number: 'RM-STEEL01', description: 'Steel plate 5mm', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', price: '82.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000', '1100'], mrp: true },
  { number: 'RM-STEEL02', description: 'Steel coil 2mm', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', price: '74.5000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000'], mrp: true },
  { number: 'RM-POLY', description: 'Polymer resin pellets', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', price: '210.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000', '1100'], batch: true, shelf: [365, 90], mrp: true },
  { number: 'RM-BEARING', description: 'Ball bearing 6205', type: 'RAW', group: 'RAW', unit: 'PC', procurement: 'BUY', price: '145.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000', '1100'], mrp: true },
  { number: 'RM-BOLT', description: 'Hex bolt M10x40', type: 'RAW', group: 'GENERAL', unit: 'PC', procurement: 'BUY', price: '4.2500', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000', '1100', '1200'] },
  { number: 'RM-PAINT', description: 'Primer paint, litre', type: 'RAW', group: 'RAW', unit: 'LT', procurement: 'BUY', price: '390.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1100'], batch: true, shelf: [180, 60] },
  { number: 'RM-ELEC', description: 'Wiring harness', type: 'RAW', group: 'RAW', unit: 'PC', procurement: 'BUY', price: '1250.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1100'], mrp: true },
  { number: 'RM-PACK', description: 'Export carton', type: 'SEMI', group: 'PACKAGING', unit: 'PC', procurement: 'BUY', price: '96.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000', '1100', '1200'] },
  { number: 'RM-LUBE', description: 'Machine lubricant, litre', type: 'RAW', group: 'MAINT', unit: 'LT', procurement: 'BUY', price: '215.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000'], service: true },
  { number: 'SG-CONTRACT', description: 'Contract maintenance service', type: 'SERV', group: 'SERVICES', unit: 'H', procurement: 'EXT', price: '900.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000'], service: true },
  { number: 'SG-FREIGHT', description: 'Freight in, per consignment', type: 'SERV', group: 'SERVICES', unit: 'EA', procurement: 'EXT', price: '3400.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000'], service: true },
  { number: 'SF-HOUSING', description: 'Gear housing, machined', type: 'SEMI', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '640.0000', control: 'STANDARD', valuation: 'SEMI_INVENTORY', plants: ['1000', '1100'], batch: true, mrp: true },
  { number: 'SF-SHAFT', description: 'Output shaft', type: 'SEMI', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '380.0000', control: 'STANDARD', valuation: 'SEMI_INVENTORY', plants: ['1000'], mrp: true },
  { number: 'SF-GEARSET', description: 'Gear set, hardened', type: 'SEMI', group: 'PRODUCTS', unit: 'SET', procurement: 'MAKE', price: '1150.0000', control: 'STANDARD', valuation: 'SEMI_INVENTORY', plants: ['1100'], mrp: true },
  { number: 'SF-BRACKET', description: 'Mounting bracket', type: 'SEMI', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '140.0000', control: 'STANDARD', valuation: 'SEMI_INVENTORY', plants: ['1000'] },
  { number: 'FG-GEARBOX', description: 'Gearbox assembly GB-400', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '4800.0000', control: 'STANDARD', valuation: 'FINISHED_INVENTORY', plants: ['1000', '1100', '1200'], batch: true, mrp: true },
  { number: 'FG-GEARBOX-H', description: 'Gearbox assembly GB-400 HD', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '6200.0000', control: 'STANDARD', valuation: 'FINISHED_INVENTORY', plants: ['1100', '1200'], batch: true, mrp: true },
  { number: 'FG-DRIVEUNIT', description: 'Drive unit DU-90', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '9450.0000', control: 'STANDARD', valuation: 'FINISHED_INVENTORY', plants: ['1000', '1200'], batch: true, shelf: [720, 180], mrp: true },
  { number: 'FG-SERVICEKIT', description: 'Service kit SK-1', type: 'FIN', group: 'PRODUCTS', unit: 'KIT', procurement: 'MAKE', price: '2300.0000', control: 'STANDARD', valuation: 'FINISHED_INVENTORY', plants: ['1000', '1200'] },
  { number: 'TG-CLUTCH', description: 'Clutch plate, trading', type: 'TRAD', group: 'GENERAL', unit: 'PC', procurement: 'BUY', price: '1820.0000', control: 'MOVING_AVERAGE', valuation: 'FINISHED_INVENTORY', plants: ['1200'] },
  { number: 'TG-BRAKEKIT', description: 'Brake kit, trading', type: 'TRAD', group: 'GENERAL', unit: 'KIT', procurement: 'BUY', price: '5600.0000', control: 'MOVING_AVERAGE', valuation: 'FINISHED_INVENTORY', plants: ['1200'] },
  { number: 'FG-SPARE-01', description: 'Spare flange FG-1', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', price: '420.0000', control: 'STANDARD', valuation: 'FINISHED_INVENTORY', plants: ['1000'] },
  { number: 'RM-GASKET', description: 'Gasket set', type: 'RAW', group: 'RAW', unit: 'SET', procurement: 'BUY', price: '58.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000', '1100'] },
  { number: 'RM-SEAL', description: 'Oil seal 42x62x8', type: 'RAW', group: 'RAW', unit: 'PC', procurement: 'BUY', price: '36.0000', control: 'MOVING_AVERAGE', valuation: 'RAW_INVENTORY', plants: ['1000', '1100'], batch: true },
];

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
          plannedDeliveryDays: spec.procurement === 'BUY' ? 7 : 0,
          inHouseProductionDays: spec.procurement === 'MAKE' ? 3 : 0,
        });
        if (spec.procurement === 'BUY') {
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
            valuationClass: spec.valuation, priceControl: spec.control,
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
        insert into business_partner (client, partner_number, category, name, city, created_by)
        values (${w.client}, ${number}, 'ORGANIZATION', ${name}, ${city}, ${w.actor}) on conflict do nothing
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
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, created_by)
        values (${w.client}, ${number}, 'SUPPLIER', ${w.company}, 'INR', '001', ${w.actor}) on conflict do nothing
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
        insert into business_partner (client, partner_number, category, name, city, created_by)
        values (${w.client}, ${number}, 'ORGANIZATION', ${name}, ${city}, ${w.actor}) on conflict do nothing
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
        insert into customer_sales_area (client, partner_number, role_code, sales_org, distribution_channel, division, sales_district, delivering_plant, pricing_procedure, sales_status, created_by)
        values (${w.client}, ${number}, 'CUSTOMER', ${w.company}, '01', '00', ${group === 'TRADE' ? '02' : '01'}, '0001', ${number === 'C30000' ? '1200' : '1000'}, 'PFIX01', 'ACTIVE', ${w.actor})
        on conflict do nothing
      `);
    }
  });
  console.log(`  partners: ${SUPPLIERS.length} suppliers, ${CUSTOMERS.length} customers with purchasing, company and sales-area data`);
  cover('Foundation', 'FND.PARTNER.CREATE', `${SUPPLIERS.length + CUSTOMERS.length} business partners`);
  cover('Foundation', 'FND.PARTNER.DISPLAY', 'suppliers and customers in one list');
  cover('Finance (FI)', 'FIN.CUSTOMER.COMPANY.MAINTAIN', 'customer company data on CA01 with reconciliation');
  cover('Finance (FI)', 'FIN.SUPPLIER.COMPANY.MAINTAIN', 'supplier company data on two company codes');
  cover('Procurement (MM)', 'PROC.SUPPLIER.PURCHASING.MAINTAIN', 'purchasing data per supplier');
  cover('Sales', 'SALES.CUSTOMER.SALESAREA.MAINTAIN', 'sales area per customer, one delivering from plant 1200');
}

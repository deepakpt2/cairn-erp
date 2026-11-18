/**
 * The shared ITEM-22 fixture: three companies (1000 and 2000 in USD, 3000 in EUR), four plants, materials with
 * moving-average and standard price control, a second inventory account class so two plants post to different
 * accounts, number ranges, material periods, exchange rates (one valid, one future-dated) and opening stock.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';

export async function buildStoFixture(client: string, ACTOR: string): Promise<void> {
  await withTenant(client, async (tx) => {
    for (const [obj, sub, prefix, len] of [['PURCHORD', 'POF', 'POF', 7], ['MATDOC', '*', '', 10]] as const) {
      await defineRange(tx, { client, objectCode: obj, subObject: sub, prefix, numberLength: len, createdBy: ACTOR });
    }
    for (const company of ['1000', '2000', '3000']) {
      if (company !== '1000') {
        await tx.execute(sql`
          insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
                                    currency, country, intercompany_clearing_account, created_by)
          select client, ${company}, ${`Company ${company}`}, chart_of_accounts, fiscal_year_variant, posting_period_variant,
                 ${company === '3000' ? 'EUR' : 'USD'}, country, intercompany_clearing_account, ${ACTOR}
            from company_code where client = ${client} and company_code = '1000' on conflict do nothing
        `);
      }
      await defineRange(tx, {
        client, objectCode: 'RF_BELEG', companyCode: company, subObject: 'GENERAL', fiscalYear: 2026,
        prefix: 'JE', fromNumber: 1, toNumber: 999_999, createdBy: ACTOR,
      });
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period, previous_fiscal_year,
                                             previous_period, allow_backposting, created_by)
        values (${client}, ${company}, 2026, 10, 2026, 9, true, ${ACTOR})
        on conflict (client, company_code) do update set current_fiscal_year = 2026, current_period = 10,
          previous_fiscal_year = 2026, previous_period = 9, allow_backposting = true
      `);
    }
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by) values
        (${client}, '1100', 'Plant 1100', '1000', 'KW', ${ACTOR}),
        (${client}, '2000', 'Plant 2000', '2000', 'KW', ${ACTOR}),
        (${client}, '3000', 'Plant 3000', '3000', 'KW', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
      select ${client}, '1000', p, ${ACTOR} from unnest(array['1000','1100','2000','3000']) p on conflict do nothing
    `);
    for (const plantCode of ['1000', '1100', '2000', '3000']) {
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, allow_negative_stock, is_active, created_by)
        values (${client}, ${plantCode}, '0001', 'Main store', false, true, ${ACTOR})
        on conflict (client, plant, storage_location) do update set allow_negative_stock = false, is_active = true
      `);
    }
    // A second inventory valuation class for RAW so two plants can post to different accounts.
    await tx.execute(sql`
      insert into valuation_class (client, valuation_class, name, allowed_material_types, created_by)
      values (${client}, 'RAW_INV_B', 'Raw inventory B', 'RAW', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into valuation_class_reference (client, reference, valuation_class, created_by)
      values (${client}, '0001', 'RAW_INV_B', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type, account_group, gl_account_type,
                              is_balance_sheet, language_key, sort_key, created_by)
      select client, chart_of_accounts, '121000', 'Inventory B', account_type, account_group, gl_account_type, is_balance_sheet,
             language_key, sort_key, ${ACTOR}
        from gl_account where client = ${client} and account_number = '120000' on conflict do nothing
    `);
    for (const company of ['1000', '2000', '3000']) {
      for (const account of ['120000', '121000', '300000', '110100']) {
        await tx.execute(sql`
          insert into gl_account_company (client, company_code, chart_of_accounts, gl_account, account_currency, created_by)
          select client, ${company}, chart_of_accounts, ${account}, currency, ${ACTOR}
            from company_code where client = ${client} and company_code = ${company} on conflict do nothing
        `);
      }
    }
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values
        (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
        (${client}, 'CA01', 'INVENTORY', 'RAW_INV_B', '', '121000', ${ACTOR}),
        (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '300000', ${ACTOR}),
        (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INV_B', '', '300000', ${ACTOR})
      on conflict do nothing
    `);
    for (const m of ['MAT-A', 'MAT-S', 'MAT-X']) {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, ${m}, ${`STO material ${m}`}, 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      for (const plantCode of ['1000', '1100', '2000', '3000']) {
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, created_by) values (${client}, ${m}, ${plantCode}, ${ACTOR})
          on conflict do nothing
        `);
      }
    }
    const val = (m: string, p: string, cls: string, control: string, std: number, map: number, qty: number, value: number, cur: string) => sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control, standard_price,
                                      moving_average_price, price_unit, currency, total_stock_quantity, stock_value, created_by)
      values (${client}, ${m}, ${p}, ${cls}, ${control}, ${std}, ${map}, 1, ${cur}, ${qty}, ${value}, ${ACTOR}) on conflict do nothing`;
    // MAT-A moving average everywhere; the receiving plant 2000 uses the other account class.
    await tx.execute(val('MAT-A', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 10, 1000, 10000, 'USD'));
    await tx.execute(val('MAT-A', '1100', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 10, 0, 0, 'USD'));
    await tx.execute(val('MAT-A', '2000', 'RAW_INV_B', 'MOVING_AVERAGE', 0, 10, 0, 0, 'USD'));
    await tx.execute(val('MAT-A', '3000', 'RAW_INV_B', 'MOVING_AVERAGE', 0, 8, 0, 0, 'EUR'));
    // MAT-S: the receiving plants price it at a standard.
    await tx.execute(val('MAT-S', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 10, 500, 5000, 'USD'));
    await tx.execute(val('MAT-S', '1100', 'RAW_INVENTORY', 'STANDARD', 12, 0, 0, 0, 'USD'));
    await tx.execute(val('MAT-S', '2000', 'RAW_INV_B', 'STANDARD', 9, 0, 0, 0, 'USD'));
    await tx.execute(val('MAT-S', '3000', 'RAW_INV_B', 'STANDARD', 9, 0, 0, 0, 'EUR'));
    for (const m of ['MAT-X']) {
      for (const [p, cur] of [['1000', 'USD'], ['1100', 'USD'], ['2000', 'USD']]) {
        await tx.execute(val(m, p, 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 10, p === '1000' ? 1000 : 0, p === '1000' ? 10000 : 0, cur));
      }
    }
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by) values
        (${client}, 'MAT-A', '1000', '0001', 'UNRESTRICTED', 1000, ${ACTOR}),
        (${client}, 'MAT-S', '1000', '0001', 'UNRESTRICTED', 500, ${ACTOR}),
        (${client}, 'MAT-X', '1000', '0001', 'UNRESTRICTED', 1000, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`delete from exchange_rate where client = ${client} and from_currency = 'USD' and to_currency = 'EUR'`);
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by) values
        (${client}, 'AVERAGE', 'USD', 'EUR', '2026-01-01', 0.9, ${ACTOR}),
        (${client}, 'AVERAGE', 'USD', 'EUR', '2027-06-01', 0.5, ${ACTOR})
    `);
  });
}

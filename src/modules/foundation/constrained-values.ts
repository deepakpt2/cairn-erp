/**
 * Suggestions for a field the save already constrains.
 *
 * The list uses the same cut as the write. A blocked supplier, a material the
 * plant does not carry, and a tax code from another country are not offered.
 * A small closed set is returned whole, for a dropdown. A larger set is
 * searched. Nothing is written.
 */
import { sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import {
  CLOSED_KINDS,
  type ConstrainedContext,
  type ConstrainedKind,
  type ConstrainedValue,
} from './constrained-kinds';

export {
  CLOSED_KINDS,
  CONSTRAINED_KINDS,
  type ConstrainedContext,
  type ConstrainedKind,
  type ConstrainedValue,
} from './constrained-kinds';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function like(query: string): string {
  return `%${query.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function limitOf(limit: number, closed: boolean): number {
  const cap = closed ? 200 : 50;
  if (!Number.isFinite(limit) || limit < 1) return closed ? cap : 5;
  return Math.min(Math.floor(limit), cap);
}

function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

export async function suggestConstrainedValues(
  client: string,
  kind: ConstrainedKind,
  query: string,
  context: ConstrainedContext = {},
  limit = 5,
): Promise<ConstrainedValue[]> {
  const closed = CLOSED_KINDS.has(kind);
  const cap = limitOf(limit, closed);
  const term = query.trim();
  if (!closed && term === '') return [];
  return withTenant(client, (tx) => search(tx, client, kind, term, context, cap));
}

async function search(
  tx: Tx,
  client: string,
  kind: ConstrainedKind,
  term: string,
  context: ConstrainedContext,
  cap: number,
): Promise<ConstrainedValue[]> {
  const pattern = like(term);
  const company = clean(context.companyCode);
  const plant = clean(context.plant);
  const org = clean(context.purchasingOrg);
  const material = clean(context.materialNumber).toUpperCase();
  const askedUnit = clean(context.askedUnit).toUpperCase();
  const dimension = clean(context.dimension).toUpperCase();
  const postingDate = DATE.test(clean(context.postingDate))
    ? clean(context.postingDate)
    : new Date().toISOString().slice(0, 10);
  const typed = term !== '';

  switch (kind) {
    case 'company':
      return rows(tx, sql`
        select company_code as code, name as label, '' as meta
          from company_code
         where client = ${client} and is_active
           and (${!typed} or company_code ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by company_code
         limit ${cap}
      `);
    case 'plant':
      return rows(tx, sql`
        select p.plant as code, p.name as label, coalesce(p.company_code, '') as meta
          from plant p
         where p.client = ${client} and p.is_active
           and (${company === ''} or p.company_code = ${company})
           and (${org === ''} or exists (
             select 1 from purchasing_org_plant a
              where a.client = p.client and a.purchasing_org = ${org} and a.plant = p.plant
           ))
           and (${!typed} or p.plant ilike ${pattern} escape '\\' or p.name ilike ${pattern} escape '\\')
         order by p.plant
         limit ${cap}
      `);
    case 'currency':
      return rows(tx, sql`
        select btrim(code) as code, name as label, '' as meta
          from currency
         where is_active
           and (${!typed} or btrim(code) ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by code
         limit ${cap}
      `);
    case 'purchasing-org':
      return rows(tx, sql`
        select purchasing_org as code, name as label, '' as meta
          from purchasing_org
         where client = ${client} and is_active
           and (${!typed} or purchasing_org ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by purchasing_org
         limit ${cap}
      `);
    case 'purchasing-group':
      return rows(tx, sql`
        select purchasing_group as code, name as label, coalesce(purchasing_org, '') as meta
          from purchasing_group
         where client = ${client} and is_active
           and (${org === ''} or purchasing_org is null or purchasing_org = ${org})
           and (${!typed} or purchasing_group ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by purchasing_group
         limit ${cap}
      `);
    case 'storage-location':
      if (!plant) return [];
      return rows(tx, sql`
        select storage_location as code, name as label, plant as meta
          from storage_location
         where client = ${client} and plant = ${plant} and is_active
           and (${!typed} or storage_location ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by storage_location
         limit ${cap}
      `);
    case 'unit':
      return rows(tx, sql`
        select code, name as label, dimension as meta
          from unit_of_measure
         where (${dimension === ''} or dimension = ${dimension})
           and (
             (${material === '' && askedUnit === ''})
             or (${askedUnit !== ''} and code = ${askedUnit})
             or (${material !== ''} and (
               code = (
                 select upper(base_unit) from material
                  where client = ${client} and material_number = ${material}
               ) or exists (
                 select 1 from material_uom_conversion c
                  where c.client = ${client}
                    and c.material_number = ${material}
                    and c.alternative_unit = unit_of_measure.code
               )
             ))
           )
           and (${!typed} or code ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by code
         limit ${cap}
      `);
    case 'quotation-number':
      return rows(tx, sql`
        select q.quotation_number as code, r.partner_number as label, q.rfq_number as meta
          from purchasing_quotation q
          join purchasing_rfq r on r.client = q.client and r.rfq_number = q.rfq_number
         where q.client = ${client}
           and q.quotation_number ilike ${pattern} escape '\\'
         order by q.quotation_number
         limit ${cap}
      `);
    case 'quotation-event':
      return rows(tx, sql`
        select event_number as code, purchasing_org as label, coalesce(collective_number, '') as meta
          from purchasing_rfq_event
         where client = ${client}
           and event_number ilike ${pattern} escape '\\'
         order by event_number
         limit ${cap}
      `);
    case 'quotation-request':
      return rows(tx, sql`
        select r.rfq_number as code, r.partner_number as label, e.quotation_deadline as meta
          from purchasing_rfq r
          join purchasing_rfq_event e on e.client = r.client and e.event_number = r.event_number
         where r.client = ${client}
           and (r.rfq_number ilike ${pattern} escape '\\' or r.partner_number ilike ${pattern} escape '\\')
         order by r.rfq_number
         limit ${cap}
      `);
    case 'material-order':
      return rows(tx, sql`
        select m.material_number as code, m.description as label, coalesce(m.base_unit, '') as meta
          from material m
         where m.client = ${client}
           and (${plant === ''} or exists (
             select 1 from material_plant mp
              where mp.client = m.client and mp.material_number = m.material_number and mp.plant = ${plant}
           ))
           and (m.material_number ilike ${pattern} escape '\\' or m.description ilike ${pattern} escape '\\')
         order by m.material_number
         limit ${cap}
      `);
    case 'material-info':
      return rows(tx, sql`
        select m.material_number as code, m.description as label, coalesce(m.base_unit, '') as meta
          from material m
         where m.client = ${client}
           and not m.is_blocked
           and not m.marked_for_deletion
           and m.base_unit is not null
           and (${plant === ''} or exists (
             select 1 from material_plant mp
              where mp.client = m.client and mp.material_number = m.material_number and mp.plant = ${plant}
                and not mp.marked_for_deletion
                and mp.procurement_type is distinct from 'MAKE'
           ))
           and (m.material_number ilike ${pattern} escape '\\' or m.description ilike ${pattern} escape '\\')
         order by m.material_number
         limit ${cap}
      `);
    case 'material-rfq':
      return rows(tx, sql`
        select m.material_number as code, m.description as label, coalesce(m.base_unit, '') as meta
          from material m
         where m.client = ${client}
           and not m.is_blocked
           and (${plant === ''} or exists (
             select 1 from material_plant mp
              where mp.client = m.client and mp.material_number = m.material_number and mp.plant = ${plant}
           ))
           and (m.material_number ilike ${pattern} escape '\\' or m.description ilike ${pattern} escape '\\')
         order by m.material_number
         limit ${cap}
      `);
    case 'material-issue':
      return rows(tx, sql`
        select m.material_number as code, m.description as label, coalesce(m.base_unit, '') as meta
          from material m
         where m.client = ${client}
           and not m.marked_for_deletion
           and m.base_unit is not null
           and (${plant === ''} or exists (
             select 1 from material_plant mp
              where mp.client = m.client and mp.material_number = m.material_number and mp.plant = ${plant}
                and not mp.marked_for_deletion
           ))
           and (m.material_number ilike ${pattern} escape '\\' or m.description ilike ${pattern} escape '\\')
         order by m.material_number
         limit ${cap}
      `);
    case 'material-stock':
      return rows(tx, sql`
        select m.material_number as code, m.description as label, coalesce(m.base_unit, '') as meta
          from material m
         where m.client = ${client}
           and m.base_unit is not null
           and (${plant === ''} or exists (
             select 1 from material_plant mp
              where mp.client = m.client and mp.material_number = m.material_number and mp.plant = ${plant}
           ))
           and (m.material_number ilike ${pattern} escape '\\' or m.description ilike ${pattern} escape '\\')
         order by m.material_number
         limit ${cap}
      `);
    case 'supplier-purchasing':
      return rows(tx, sql`
        select distinct bp.partner_number as code, bp.name as label, sp.purchasing_org as meta
          from business_partner bp
          join bp_role role
            on role.client = bp.client and role.partner_number = bp.partner_number
           and role.role_code = 'SUPPLIER' and role.is_active
          join supplier_purchasing_org sp
            on sp.client = bp.client and sp.partner_number = bp.partner_number
           and sp.purchasing_status in ('CREATED', 'MAINTAINED') and not sp.is_blocked
         where bp.client = ${client}
           and not bp.is_blocked
           and bp.general_status <> 'INCOMPLETE'
           and (${org === ''} or sp.purchasing_org = ${org})
           and (bp.partner_number ilike ${pattern} escape '\\' or bp.name ilike ${pattern} escape '\\'
                or coalesce(bp.search_term, '') ilike ${pattern} escape '\\')
         order by bp.partner_number
         limit ${cap}
      `);
    case 'supplier-company':
      if (!company) return [];
      return rows(tx, sql`
        select bp.partner_number as code, bp.name as label, sc.company_code as meta
          from business_partner bp
          join bp_role role
            on role.client = bp.client and role.partner_number = bp.partner_number
           and role.role_code = 'SUPPLIER' and role.is_active
          join supplier_company_code sc
            on sc.client = bp.client and sc.partner_number = bp.partner_number
           and sc.company_code = ${company}
           and sc.company_status in ('CREATED', 'MAINTAINED') and not sc.is_blocked
         where bp.client = ${client}
           and not bp.is_blocked
           and bp.general_status <> 'INCOMPLETE'
           and (bp.partner_number ilike ${pattern} escape '\\' or bp.name ilike ${pattern} escape '\\'
                or coalesce(bp.search_term, '') ilike ${pattern} escape '\\')
         order by bp.partner_number
         limit ${cap}
      `);
    case 'customer-company':
      if (!company) return [];
      return rows(tx, sql`
        select bp.partner_number as code, bp.name as label, cc.company_code as meta
          from business_partner bp
          join bp_role role
            on role.client = bp.client and role.partner_number = bp.partner_number
           and role.role_code = 'CUSTOMER' and role.is_active
          join customer_company_code cc
            on cc.client = bp.client and cc.partner_number = bp.partner_number
           and cc.company_code = ${company}
           and cc.company_status in ('CREATED', 'MAINTAINED') and not cc.is_blocked
         where bp.client = ${client}
           and not bp.is_blocked
           and bp.general_status <> 'INCOMPLETE'
           and (bp.partner_number ilike ${pattern} escape '\\' or bp.name ilike ${pattern} escape '\\'
                or coalesce(bp.search_term, '') ilike ${pattern} escape '\\')
         order by bp.partner_number
         limit ${cap}
      `);
    case 'tax':
      if (!company) return [];
      return rows(tx, sql`
        select t.tax_code as code, t.name as label, t.rate_percent::text as meta
          from tax_code t
          join company_code c on c.client = t.client and c.company_code = ${company}
         where t.client = ${client} and t.country = c.country
           and (${!typed} or t.tax_code ilike ${pattern} escape '\\' or t.name ilike ${pattern} escape '\\')
         order by t.tax_code
         limit ${cap}
      `);
    case 'gl':
      if (!company) return [];
      return rows(tx, sql`
        select a.account_number as code, a.name as label, a.chart_of_accounts as meta
          from gl_account a
          join company_code c on c.client = a.client and c.company_code = ${company}
           and c.chart_of_accounts = a.chart_of_accounts
         where a.client = ${client}
           and not a.is_blocked_posting
           and not exists (
             select 1 from gl_account_company g
              where g.client = a.client and g.company_code = ${company}
                and g.gl_account = a.account_number and g.is_blocked_posting
           )
           and (a.account_number ilike ${pattern} escape '\\' or a.name ilike ${pattern} escape '\\')
         order by a.account_number
         limit ${cap}
      `);
    case 'cost-center':
      if (!company) return [];
      return rows(tx, sql`
        select distinct cost_center as code, name as label, company_code as meta
          from cost_center
         where client = ${client}
           and company_code = ${company}
           and not is_posting_locked
           and valid_from <= ${postingDate}::date
           and valid_to >= ${postingDate}::date
           and (cost_center ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by cost_center
         limit ${cap}
      `);
    case 'profit-center':
      return rows(tx, sql`
        select distinct profit_center as code, name as label, controlling_area as meta
          from profit_center
         where client = ${client}
           and not is_posting_locked
           and valid_from <= ${postingDate}::date
           and valid_to >= ${postingDate}::date
           and (profit_center ilike ${pattern} escape '\\' or name ilike ${pattern} escape '\\')
         order by profit_center
         limit ${cap}
      `);
    default:
      return [];
  }
}

async function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<ConstrainedValue[]> {
  const result = await tx.execute(query) as unknown as Array<{ code: string; label: string; meta: string }>;
  return result.map((row) => ({
    code: String(row.code ?? '').trim(),
    label: String(row.label ?? '').trim(),
    meta: String(row.meta ?? '').trim() || undefined,
  })).filter((row) => row.code !== '');
}

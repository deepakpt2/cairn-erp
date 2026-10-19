/**
 * Consolidated statements service (SCR-118 /
 * FIN.RPT.CONSOLIDATE.STMT).
 *
 * Read-only statements over UCWB configuration and the posted
 * journal: the consolidation chart's group accounts (FS items)
 * are classified from the account types of their mapped
 * source accounts, and POSTED journal lines of the group
 * units' company codes aggregate through the UCWB mappings —
 * year-to-date and period movement, signed debit-minus-credit
 * in local currency, per unit with a group total. Lines no
 * mapping covers are named, never dropped. The report posts
 * nothing and stores nothing.
 */
export * from './consolidated-statements-vocabulary';
import {
  type ConsolidatedStatementsResult, type ConsolidatedStatementsSelection,
  type StatementSection,
} from './consolidated-statements-vocabulary';

import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import {
  companyCode as foundationCompanyCode, fiscalYearPeriod, fiscalYearVariant,
} from '../foundation/schema';
import {
  consolidationAccountMapping, consolidationArea, consolidationGroup,
  consolidationGroupAccount, consolidationTaskStatus, consolidationUnit,
  consolidationUnitAssignment, consolidationVersion, glAccount,
} from './schema';

export class ConsolidatedStatementsError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ConsolidatedStatementsError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new ConsolidatedStatementsError(message, remedy);
}

/* Exact decimal helpers over amount_local (numeric 23,4). */
function toScaled(value: string | number): bigint {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace(/^[+-]/, '').split('.');
  const scaled = BigInt(whole || '0') * 10000n + BigInt((frac + '0000').slice(0, 4));
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10000n;
  const frac = String(abs % 10000n).padStart(4, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

function addScaled(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b));
}

const SECTION_BY_ACCOUNT_TYPE: Record<string, StatementSection> = {
  ASSET: 'ASSETS',
  LIABILITY: 'LIABILITIES',
  EQUITY: 'EQUITY',
  REVENUE: 'REVENUE',
  EXPENSE: 'EXPENSES',
};

const VIEW_SECTIONS: Record<string, StatementSection[]> = {
  BALANCE_SHEET: ['ASSETS', 'LIABILITIES', 'EQUITY', 'UNCLASSIFIED'],
  INCOME_STATEMENT: ['REVENUE', 'EXPENSES', 'UNCLASSIFIED'],
};

interface AccountAggregate {
  account: string;
  ytd: string;
  movement: string;
  comparative: string;
  lines: number;
}

export async function calculateConsolidatedStatements(input: {
  client: string;
  selection: ConsolidatedStatementsSelection;
}): Promise<ConsolidatedStatementsResult> {
  const { client } = input;
  const selection: ConsolidatedStatementsSelection = {
    area: input.selection.area.trim().toUpperCase(),
    group: input.selection.group.trim().toUpperCase(),
    version: input.selection.version.trim().toUpperCase(),
    fiscalYear: Number(input.selection.fiscalYear),
    period: Number(input.selection.period),
    view: input.selection.view === 'INCOME_STATEMENT' ? 'INCOME_STATEMENT' : 'BALANCE_SHEET',
    unit: input.selection.unit.trim().toUpperCase(),
    comparative: Boolean(input.selection.comparative),
  };
  if (!selection.area || !selection.group || !selection.version) {
    fail('Consolidation area, group and version are required.', 'Select the configured consolidation scope.');
  }
  if (!Number.isInteger(selection.fiscalYear) || selection.fiscalYear < 1900 || selection.fiscalYear > 2199) {
    fail('A fiscal year between 1900 and 2199 is required.');
  }
  if (!Number.isInteger(selection.period) || selection.period < 1 || selection.period > 20) {
    fail('A period between 1 and 20 is required.');
  }

  return withTenant(client, async (tx) => {
    const [area] = await tx.select().from(consolidationArea).where(and(
      eq(consolidationArea.client, client), eq(consolidationArea.area, selection.area),
    ));
    if (!area) fail(`Consolidation area ${selection.area} does not stand.`, 'Configure the area in UCWB first.');
    if (area.status !== 'ACTIVE') {
      fail(`Consolidation area ${selection.area} is ${area.status}; statements require an ACTIVE area.`, 'Activate the area in UCWB.');
    }
    const [group] = await tx.select().from(consolidationGroup).where(and(
      eq(consolidationGroup.client, client), eq(consolidationGroup.area, selection.area),
      eq(consolidationGroup.groupName, selection.group),
    ));
    if (!group) fail(`Consolidation group ${selection.group} does not stand in area ${selection.area}.`);
    const [version] = await tx.select().from(consolidationVersion).where(and(
      eq(consolidationVersion.client, client), eq(consolidationVersion.area, selection.area),
      eq(consolidationVersion.version, selection.version),
    ));
    if (!version) fail(`Consolidation version ${selection.version} does not stand in area ${selection.area}.`);

    const [variant] = await tx.select().from(fiscalYearVariant).where(and(
      eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, area.fiscalYearVariant),
    ));
    if (!variant) fail(`Fiscal year variant ${area.fiscalYearVariant} does not stand.`);
    const periodRows = await tx.select().from(fiscalYearPeriod).where(and(
      eq(fiscalYearPeriod.client, client), eq(fiscalYearPeriod.variant, area.fiscalYearVariant),
      inArray(fiscalYearPeriod.calendarYear, variant.isYearDependent ? [selection.fiscalYear, 0] : [0]),
    ));
    const yearRows = periodRows.filter((row) => row.calendarYear === selection.fiscalYear);
    const effective = yearRows.length > 0 ? yearRows : periodRows.filter((row) => row.calendarYear === 0);
    const periodRow = effective.find((row) => row.period === selection.period);
    if (!periodRow) {
      fail(`Period ${selection.period} is not defined by fiscal year variant ${area.fiscalYearVariant} for ${selection.fiscalYear}.`, 'Choose a period the consolidation calendar defines.');
    }
    const endYear = selection.fiscalYear + periodRow.yearShift;
    const daysInMonth = new Date(Date.UTC(endYear, periodRow.month, 0)).getUTCDate();
    const periodEnd = new Date(Date.UTC(endYear, periodRow.month - 1, Math.min(periodRow.day, daysInMonth)))
      .toISOString().slice(0, 10);

    const assigned = await tx.select({ unit: consolidationUnit })
      .from(consolidationUnit)
      .innerJoin(consolidationUnitAssignment, and(
        eq(consolidationUnitAssignment.client, client),
        eq(consolidationUnitAssignment.area, selection.area),
        eq(consolidationUnitAssignment.groupName, selection.group),
        eq(consolidationUnitAssignment.unit, consolidationUnit.unit),
        lte(consolidationUnitAssignment.validFrom, periodEnd),
        gte(consolidationUnitAssignment.validTo, periodEnd),
      ))
      .where(and(eq(consolidationUnit.client, client), eq(consolidationUnit.area, selection.area)))
      .orderBy(asc(consolidationUnit.unit));
    const allUnits = assigned.map((row) => row.unit);
    if (allUnits.length === 0) {
      fail(`No consolidation units are assigned to group ${selection.group} for ${periodEnd}.`, 'Assign a unit to the group for this period in UCWB.');
    }
    if (selection.unit && !allUnits.some((unit) => unit.unit === selection.unit)) {
      fail(`Consolidation unit ${selection.unit} is not assigned to group ${selection.group} for ${periodEnd}.`);
    }
    const units = selection.unit ? allUnits.filter((unit) => unit.unit === selection.unit) : allUnits;

    /* FS items and mappings of the consolidation chart. */
    const groupAccounts = await tx.select().from(consolidationGroupAccount).where(and(
      eq(consolidationGroupAccount.client, client), eq(consolidationGroupAccount.consChart, area.consChart),
    )).orderBy(asc(consolidationGroupAccount.account));
    const mappings = await tx.select().from(consolidationAccountMapping).where(and(
      eq(consolidationAccountMapping.client, client), eq(consolidationAccountMapping.consChart, area.consChart),
    )).orderBy(asc(consolidationAccountMapping.sourceChart), asc(consolidationAccountMapping.sourceFrom));

    const warnings: string[] = [
      'Totals aggregate reported data; currency translation and intercompany eliminations have not been executed (engines deferred), so the statements stand pre-elimination.',
    ];

    /* Classify each FS item from its mapped source account types. */
    const charts = [...new Set(units.map((unit) => unit.companyCode))];
    const companyRows = await tx.select().from(foundationCompanyCode).where(and(
      eq(foundationCompanyCode.client, client), inArray(foundationCompanyCode.companyCode, charts),
    ));
    const chartByCompany = new Map(companyRows.map((row) => [row.companyCode, row.chartOfAccounts ?? '']));
    const sourceCharts = [...new Set([...chartByCompany.values()].filter(Boolean))];
    const accountTypes = new Map<string, string>();
    if (sourceCharts.length > 0) {
      const accounts = await tx.select().from(glAccount).where(and(
        eq(glAccount.client, client), inArray(glAccount.chartOfAccounts, sourceCharts),
      ));
      for (const account of accounts) accountTypes.set(`${account.chartOfAccounts}|${account.accountNumber}`, account.accountType);
    }
    const sectionByGroupAccount = new Map<string, StatementSection>();
    for (const groupAccount of groupAccounts) {
      const sections = new Set<StatementSection>();
      for (const mapping of mappings.filter((m) => m.groupAccount === groupAccount.account)) {
        for (const [key, type] of accountTypes) {
          const [chart, account] = key.split('|');
          if (chart === mapping.sourceChart && account >= mapping.sourceFrom && account <= mapping.sourceTo) {
            const section = SECTION_BY_ACCOUNT_TYPE[type];
            if (section) sections.add(section);
          }
        }
      }
      if (sections.size > 1) {
        warnings.push(`FS item ${groupAccount.account} (${groupAccount.title}) maps source accounts from more than one statement section and stands unclassified.`);
      }
      sectionByGroupAccount.set(groupAccount.account, sections.size === 1 ? [...sections][0]! : 'UNCLASSIFIED');
    }

    /* Aggregate posted journal lines per unit company and account. */
    const totalsByUnitAccount = new Map<string, AccountAggregate>();
    let unmappedLines = 0;
    let unmappedAmount = '0';
    let balanceCheck = '0';
    for (const unit of units) {
      const rows = await tx.execute(sql`
        select l.gl_account as account,
               coalesce(sum(case when e.posting_period <= ${selection.period}
                 then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end else 0 end), 0)::text as ytd,
               coalesce(sum(case when e.posting_period = ${selection.period}
                 then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end else 0 end), 0)::text as movement,
               count(*)::int as lines
        from journal_entry e
        join journal_entry_line l
          on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
        where e.client = ${client} and e.company_code = ${unit.companyCode}
          and e.fiscal_year = ${selection.fiscalYear} and e.status = 'POSTED'
        group by l.gl_account
      `) as unknown as Array<{ account: string; ytd: string; movement: string; lines: number }>;
      let comparativeByAccount = new Map<string, string>();
      if (selection.comparative) {
        const comp = await tx.execute(sql`
          select l.gl_account as account,
                 coalesce(sum(case when e.posting_period <= ${selection.period}
                   then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end else 0 end), 0)::text as ytd
          from journal_entry e
          join journal_entry_line l
            on l.client = e.client and l.document_number = e.document_number and l.fiscal_year = e.fiscal_year
          where e.client = ${client} and e.company_code = ${unit.companyCode}
            and e.fiscal_year = ${selection.fiscalYear - 1} and e.status = 'POSTED'
          group by l.gl_account
        `) as unknown as Array<{ account: string; ytd: string }>;
        comparativeByAccount = new Map(comp.map((row) => [row.account, row.ytd]));
      }
      const companyChart = chartByCompany.get(unit.companyCode) ?? '';
      for (const row of rows) {
        balanceCheck = addScaled(balanceCheck, row.ytd);
        const mapping = mappings.find((m) =>
          m.sourceChart === companyChart && row.account >= m.sourceFrom && row.account <= m.sourceTo);
        if (!mapping) {
          unmappedLines += row.lines;
          unmappedAmount = addScaled(unmappedAmount, row.ytd);
          continue;
        }
        const key = `${unit.unit}|${mapping.groupAccount}`;
        const existing = totalsByUnitAccount.get(key) ?? {
          account: mapping.groupAccount, ytd: '0', movement: '0', comparative: '0', lines: 0,
        };
        existing.ytd = addScaled(existing.ytd, row.ytd);
        existing.movement = addScaled(existing.movement, row.movement);
        existing.comparative = addScaled(existing.comparative, comparativeByAccount.get(row.account) ?? '0');
        existing.lines += row.lines;
        totalsByUnitAccount.set(key, existing);
      }
    }
    if (unmappedLines > 0) {
      warnings.push(`${unmappedLines} journal line(s) fall outside the UCWB account mappings and are excluded from the FS items.`);
    }

    const allowedSections = VIEW_SECTIONS[selection.view]!;
    const rows = groupAccounts
      .map((groupAccount) => {
        const unitAmounts: Record<string, string> = {};
        let groupTotal = '0';
        let movement = '0';
        let comparative = '0';
        for (const unit of units) {
          const aggregate = totalsByUnitAccount.get(`${unit.unit}|${groupAccount.account}`);
          unitAmounts[unit.unit] = aggregate?.ytd ?? '0';
          groupTotal = addScaled(groupTotal, aggregate?.ytd ?? '0');
          movement = addScaled(movement, aggregate?.movement ?? '0');
          comparative = addScaled(comparative, aggregate?.comparative ?? '0');
        }
        return {
          groupAccount: groupAccount.account,
          title: groupAccount.title,
          section: sectionByGroupAccount.get(groupAccount.account) ?? 'UNCLASSIFIED',
          unitAmounts,
          groupTotal,
          periodMovement: movement,
          comparativeTotal: selection.comparative ? comparative : null,
        };
      })
      .filter((row) => allowedSections.includes(row.section));

    const sectionTotals = allowedSections.map((section) => ({
      section,
      total: rows.filter((row) => row.section === section)
        .reduce((sum, row) => addScaled(sum, row.groupTotal), '0'),
    })).filter((entry) => entry.total !== '0' || rows.some((row) => row.section === entry.section));

    /* CX20 standing for the same scope. */
    const standing = await tx.select().from(consolidationTaskStatus).where(and(
      eq(consolidationTaskStatus.client, client), eq(consolidationTaskStatus.area, selection.area),
      eq(consolidationTaskStatus.groupName, selection.group), eq(consolidationTaskStatus.version, selection.version),
      eq(consolidationTaskStatus.fiscalYear, selection.fiscalYear), eq(consolidationTaskStatus.period, selection.period),
    )).orderBy(asc(consolidationTaskStatus.unit), asc(consolidationTaskStatus.task));
    for (const unit of units) {
      const collected = standing.some((row) =>
        row.unit === unit.unit && row.task.includes('') && row.lastMode === 'UPDATE'
        && (row.status === 'COMPLETED' || row.status === 'WARNING'));
      if (!collected) {
        warnings.push(`Consolidation unit ${unit.unit} has no completed update-mode monitor run for this scope in CX20; its reported data may be incomplete.`);
      }
    }

    return {
      selection,
      areaTitle: area.title,
      consChart: area.consChart,
      fiscalYearVariant: area.fiscalYearVariant,
      periodLabel: `${selection.fiscalYear} / periods 1–${selection.period} · variant ${area.fiscalYearVariant}`,
      units: units.map((unit) => ({ unit: unit.unit, title: unit.title, companyCode: unit.companyCode })),
      rows,
      sectionTotals,
      balanceCheck,
      unmapped: { lines: unmappedLines, amount: unmappedAmount },
      warnings,
      monitorStanding: standing
        .filter((row) => !row.unit || units.some((unit) => unit.unit === row.unit))
        .map((row) => ({
          unit: row.unit ?? '',
          task: row.task,
          status: row.status,
          mode: row.lastMode ?? '',
          executedAt: row.executedAt ? new Date(row.executedAt).toISOString() : '',
        })),
    };
  });
}

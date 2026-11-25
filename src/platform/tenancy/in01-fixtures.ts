/**
 * Fixture loading for the India UAT dataset — the single source of truth shared by the
 * installer and the UAT guide.
 *
 * The tree is deliberately split three ways, so that adding a country is a folder and
 * not a code change:
 *
 *   fixtures/core/            country-neutral structure and roles
 *   fixtures/country/<XX>/    what is true of one country (tax, fiscal year, payroll statute)
 *   fixtures/company/<KEY>/   one company's people, masters, partners and prices
 *
 * Nothing in `core/` names a country and nothing in `country/IN` names a company. The
 * installer reads all three and never contains a business value of its own; a value it
 * needs and cannot find is an error, not a default.
 *
 * Values are validated on load. A fixture that is internally inconsistent — a BOM item
 * naming a material that does not exist, a user linked to a personnel number that is not
 * an employee, a cost centre no position is paid from — is refused here, before a single
 * service is called, so that a mistake in the data is reported as a mistake in the data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CoreOrganisation {
  version: number;
  structure: {
    companyCode: string;
    chartOfAccounts: string;
    manufacturingPlant: string;
    distributionPlant: string;
    purchasingOrg: string;
    salesOrg: string;
    distributionChannel: string;
    division: string;
    controllingArea: string;
    creditControlArea: string;
    manufacturingShippingPoint: string;
    distributionShippingPoint: string;
  };
  manufacturingStorageLocations: Array<{ code: string; name: string }>;
  distributionStorageLocations: Array<{ code: string; name: string }>;
  workCentreCategories: Array<{ code: string; description: string }>;
  unitsOfMeasure: string[];
  materialTypes: Array<{ code: string; name: string }>;
  costCentreCategories: Record<string, string>;
  documentTypes: Record<string, string>;
  accountKeys: Record<string, string>;
  roles: Array<{ code: string; name: string; description: string; capabilities: string[] }>;
}

export interface CountryPack {
  version: number;
  country: { code: string; name: string; currency: string; timezone: string; dateFormat: string; numberFormat: string };
  fiscalYear: {
    variant: string;
    name: string;
    isCalendarYear: boolean;
    isYearDependent: boolean;
    regularPeriods: number;
    specialPeriods: number;
    periodEnds: Array<{ period: number; month: number; day: number; yearShift: number; label?: string }>;
    specialPeriodEnds: Array<{ period: number; month: number; day: number; yearShift: number }>;
  };
  chartOfAccounts: {
    additions: Array<{
      number: string; name: string; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
      isBalanceSheet: boolean; taxRelevant?: boolean; requiresCostObject?: boolean; gapNote?: string;
    }>;
  };
  taxCodes: {
    standardTaxAccount: string;
    codes: Array<{ code: string; name: string; taxType: string; ratePercent: string; accountKey: string; appliesTo: string }>;
    targetEntries: {
      intraState: { cgstAccount: string; sgstAccount: string; inputCgst: string; inputSgst: string; rate: string };
      interState: { igstAccount: string; inputIgst: string; rate: string };
    };
  };
  payrollStatutory: {
    components: Array<{
      code: string; name: string; kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION' | 'EOS_PROVISION';
      debit: string | null; credit: string | null; receiver: 'ASSIGNMENT' | 'FIXED' | 'NONE';
      rule: { kind: 'FIXED' | 'PERCENT_OF_BASE'; value: string; gapNote?: string };
    }>;
    earningComponents: Array<{
      code: string; name: string; kind: string; debit: string | null; credit: string | null;
      receiver: 'ASSIGNMENT' | 'FIXED' | 'NONE'; gapNote?: string;
    }>;
    esiWageCeiling: string;
    professionalTaxState: string;
  };
  holidayCalendar: { id: string; name: string; days: Array<{ date: string; name: string }> };
  formats: Record<string, unknown>;
  stateCodes: Array<{ code: string; name: string }>;
}

export interface EmployeeSpec {
  personnelNumber: string;
  fullName: string;
  positionCode: string;
  costCentre: string;
  structure: string;
  base: string;
  dob: string;
  joined: string;
  grade: string;
  esiEligible?: boolean;
  tdsMonthly?: string;
}

export interface CompanyFixture {
  version: number;
  identity: {
    clientKey: string; name: string; legalName: string; companyCode: string; city: string;
    state: string; stateCode: string; country: string; currency: string; address: string;
    pan: string; gstin: string; cin: string; email: string; phone: string; business: string;
  };
  founderAccounts: {
    platformAdmin: { username: string; fullName: string; email: string };
    administrator: { username: string; fullName: string; email: string };
  };
  costCentres: Array<{ code: string; name: string; category: string }>;
  profitCentres: Array<{ code: string; name: string; segment: string }>;
  workCentres: Array<{ code: string; description: string; category: string; costCentre: string }>;
  orgUnits: Array<{ code: string; name: string; parentCode?: string }>;
  jobs: Array<{ code: string; name: string }>;
  positions: Array<{
    code: string; title: string; jobCode: string; orgUnitCode: string;
    superiorCode?: string; tier: number; costCentre: string;
  }>;
  salaryStructures: Record<string, {
    name: string;
    rules: Array<{ component: string; kind: 'FIXED' | 'PERCENT_OF_BASE'; value: string }>;
  }>;
  leaveTypes: Array<{ code: string; name: string; reducesQuota: boolean; isPaid: boolean }>;
  leaveQuotas: Record<string, string>;
  employeeRecordTypes: Array<{
    code: string; name: string;
    fields: Array<{ code: string; label: string; valueKind: 'TEXT' | 'NUMBER' | 'DATE' }>;
  }>;
  employees: EmployeeSpec[];
  users: Array<{
    username: string; personnelNumber: string; role: string; department: string; plants: string[];
  }>;
  materialGroups: Array<{ code: string; name: string; shortName: string }>;
  materials: Array<{
    number: string; description: string; type: string; group: string; unit: string;
    procurement: 'BUY' | 'MAKE'; plants: string[]; valuationClass: string;
    priceControl: 'MOVING_AVERAGE' | 'STANDARD'; price: string; safetyStock?: string;
    sellable?: boolean; hsn?: string; gstCode?: string;
  }>;
  boms: Array<{
    material: string; plant: string; baseQuantity: string; usage: string;
    items: Array<{ itemNumber: number; component: string; quantity: string; unit: string }>;
  }>;
  routings: Array<{
    material: string; plant: string; usage: string; taskListType: string;
    operations: Array<{
      operation: number; workCentre: string; description: string; hours: string; controlKey: string;
    }>;
  }>;
  vendors: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  sellingPrices: Record<string, Record<string, string>>;
  purchasePrices: Record<string, string>;
  foreignCurrency: {
    usd: {
      currency: string;
      rates: Array<{ validFrom: string; rate: string }>;
      importVendor: string;
      exportCustomer: string;
    };
  };
  openingBalances: {
    journal: Array<{ glAccount: string; debit: string; credit: string; text: string }>;
  };
}

export interface FixtureSet {
  core: CoreOrganisation;
  country: CountryPack;
  company: CompanyFixture;
  /** Which folder each part came from, for the report and the guide. */
  sources: { core: string; country: string; company: string };
}

/** Where the tree lives, relative to the repository root. */
export const FIXTURE_ROOT = 'fixtures';

function readJson<T>(path: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Fixture file is missing: ${path}. The installer cannot invent business data.`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Fixture file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Load the three parts and check them against each other.
 *
 * The cross-checks are the point of this function. A fixture is a claim about a company,
 * and a claim that contradicts itself fails here rather than half-way through provisioning
 * with a foreign-key error that reads like an application defect.
 */
export function loadFixtures(input: {
  countryCode: string;
  companyKey: string;
  root?: string;
}): FixtureSet {
  const root = input.root ?? FIXTURE_ROOT;
  const corePath = join(root, 'core', 'organisation.json');
  const countryPath = join(root, 'country', input.countryCode.toUpperCase(), 'country-pack.json');
  const companyPath = join(root, 'company', input.companyKey.toUpperCase(), 'company.json');

  const core = readJson<CoreOrganisation>(corePath);
  const country = readJson<CountryPack>(countryPath);
  const company = readJson<CompanyFixture>(companyPath);

  validate({ core, country, company });

  return {
    core,
    country,
    company,
    sources: { core: corePath, country: countryPath, company: companyPath },
  };
}

/**
 * Every cross-reference the fixtures make must resolve inside the fixtures.
 *
 * Named individually rather than as one loop so that a failure says which relationship
 * was broken, which is the difference between "fix the data" and "read the installer".
 */
export function validate(set: Omit<FixtureSet, 'sources'>): void {
  const { core, country, company } = set;
  const fail = (message: string): never => {
    throw new Error(`Fixture validation failed: ${message}`);
  };

  if (company.identity.clientKey.length < 2 || company.identity.clientKey.length > 4) {
    fail(`client key "${company.identity.clientKey}" is not 2 to 4 characters.`);
  }
  if (company.identity.clientKey !== company.identity.companyCode &&
      !/^[A-Za-z0-9]{2,4}$/.test(company.identity.clientKey)) {
    fail('the client key must be 2 to 4 letters or digits.');
  }
  if (country.country.code !== company.identity.country) {
    fail(`the country pack is ${country.country.code} and the company is ${company.identity.country}.`);
  }
  if (country.country.currency !== company.identity.currency) {
    fail(`the country pack's currency is ${country.country.currency} and the company's is ${company.identity.currency}.`);
  }

  // Cost centres: every one a position or an employee names must be defined.
  const costCentres = new Set(company.costCentres.map((c) => c.code));
  for (const position of company.positions) {
    if (!costCentres.has(position.costCentre)) {
      fail(`position ${position.code} is paid from cost centre ${position.costCentre}, which is not defined.`);
    }
  }
  for (const employee of company.employees) {
    if (!costCentres.has(employee.costCentre)) {
      fail(`employee ${employee.personnelNumber} sits in cost centre ${employee.costCentre}, which is not defined.`);
    }
  }

  // Org units and jobs: the reporting chart must close over what it names.
  const units = new Set(company.orgUnits.map((u) => u.code));
  for (const unit of company.orgUnits) {
    if (unit.parentCode && !units.has(unit.parentCode)) {
      fail(`org unit ${unit.code} reports to ${unit.parentCode}, which is not defined.`);
    }
  }
  const jobs = new Set(company.jobs.map((j) => j.code));
  for (const position of company.positions) {
    if (!units.has(position.orgUnitCode)) {
      fail(`position ${position.code} stands in org unit ${position.orgUnitCode}, which is not defined.`);
    }
    if (!jobs.has(position.jobCode)) {
      fail(`position ${position.code} holds job ${position.jobCode}, which is not defined.`);
    }
  }
  const positions = new Set(company.positions.map((p) => p.code));
  for (const position of company.positions) {
    if (position.superiorCode && !positions.has(position.superiorCode)) {
      fail(`position ${position.code} reports to ${position.superiorCode}, which is not defined.`);
    }
  }

  // Employees: one position each, and the position must exist.
  const personnelNumbers = new Set<string>();
  for (const employee of company.employees) {
    if (personnelNumbers.has(employee.personnelNumber)) {
      fail(`personnel number ${employee.personnelNumber} appears twice.`);
    }
    personnelNumbers.add(employee.personnelNumber);
    if (!positions.has(employee.positionCode)) {
      fail(`employee ${employee.personnelNumber} holds position ${employee.positionCode}, which is not defined.`);
    }
    if (!company.salaryStructures[employee.structure]) {
      fail(`employee ${employee.personnelNumber} is on structure ${employee.structure}, which is not defined.`);
    }
  }

  // Users: each is one employee, one defined role.
  const roleCodes = new Set(core.roles.map((r) => r.code));
  for (const user of company.users) {
    if (!personnelNumbers.has(user.personnelNumber)) {
      fail(`user ${user.username} is linked to personnel number ${user.personnelNumber}, which is not an employee.`);
    }
    if (user.role !== 'ADMINISTRATOR' && user.role !== 'PLATFORM_ADMIN' && !roleCodes.has(user.role)) {
      fail(`user ${user.username} holds role ${user.role}, which the core pack does not define.`);
    }
  }

  // Materials: BOM components and routings must name materials and work centres that exist.
  const materials = new Set(company.materials.map((m) => m.number));
  for (const bom of company.boms) {
    if (!materials.has(bom.material)) fail(`a BOM is defined for ${bom.material}, which is not a material.`);
    for (const item of bom.items) {
      if (!materials.has(item.component)) {
        fail(`the BOM of ${bom.material} uses ${item.component}, which is not a material.`);
      }
    }
  }
  const workCentres = new Set(company.workCentres.map((w) => w.code));
  for (const routing of company.routings) {
    if (!materials.has(routing.material)) fail(`a routing is defined for ${routing.material}, which is not a material.`);
    for (const operation of routing.operations) {
      if (!workCentres.has(operation.workCentre)) {
        fail(`the routing of ${routing.material} uses work centre ${operation.workCentre}, which is not defined.`);
      }
    }
  }

  // Payroll: every component a structure or a country rule names must be defined, and every
  // G/L account a component names must be either one the country pack adds or one the
  // standard package already delivers. The second set is not listed in the fixture — a
  // country pack must not have to restate the delivered chart — so it is checked at install
  // time against the chart that actually stands, where the accounts can be read.
  const componentCodes = new Set([
    ...country.payrollStatutory.components.map((c) => c.code),
    ...country.payrollStatutory.earningComponents.map((c) => c.code),
  ]);
  for (const [code, structure] of Object.entries(company.salaryStructures)) {
    for (const rule of structure.rules) {
      if (!componentCodes.has(rule.component)) {
        fail(`salary structure ${code} pays component ${rule.component}, which the country pack does not define.`);
      }
    }
  }

  // Tax codes: each material's GST code must be defined.
  const taxCodes = new Set(country.taxCodes.codes.map((t) => t.code));
  for (const material of company.materials) {
    if (material.gstCode && !taxCodes.has(material.gstCode)) {
      fail(`material ${material.number} carries GST code ${material.gstCode}, which the country pack does not define.`);
    }
  }

  // Opening balances must net to zero, because a trial balance that does not is not a
  // fixture problem the installer may paper over.
  let debit = 0;
  let credit = 0;
  for (const line of company.openingBalances.journal) {
    debit += Number(line.debit);
    credit += Number(line.credit);
  }
  if (Math.abs(debit - credit) > 0.005) {
    fail(`opening balances do not net to zero: debits ${debit} against credits ${credit}.`);
  }

  // Foreign currency: the named import vendor and export customer must exist, and the
  // country's currency must not be the foreign one.
  const vendors = new Set(company.vendors.map((v) => String(v.number)));
  const customers = new Set(company.customers.map((c) => String(c.number)));
  if (!vendors.has(company.foreignCurrency.usd.importVendor)) {
    fail(`the foreign import vendor ${company.foreignCurrency.usd.importVendor} is not in the vendor list.`);
  }
  if (!customers.has(company.foreignCurrency.usd.exportCustomer)) {
    fail(`the foreign export customer ${company.foreignCurrency.usd.exportCustomer} is not in the customer list.`);
  }
  if (company.foreignCurrency.usd.currency === country.country.currency) {
    fail('the "foreign" currency is the company currency.');
  }

  // The country pack's fiscal year must describe the periods its own counts claim.
  if (country.fiscalYear.periodEnds.length !== country.fiscalYear.regularPeriods) {
    fail(`the country pack names ${country.fiscalYear.regularPeriods} regular periods and lists ${country.fiscalYear.periodEnds.length} ends.`);
  }
  if (country.fiscalYear.specialPeriodEnds.length !== country.fiscalYear.specialPeriods) {
    fail(`the country pack names ${country.fiscalYear.specialPeriods} special periods and lists ${country.fiscalYear.specialPeriodEnds.length} ends.`);
  }
}

/**
 * The scenario month, and therefore the posting periods the dataset writes to.
 *
 * Kept in the fixtures' own terms — a fiscal year starting in April — rather than derived
 * from the clock, so that the guide and the installer agree on the month even when the run
 * happens later. An earlier run reported by the owner must be able to name a month whose
 * postings straddle the calendar year boundary; the regression suite does that.
 */
export function resolveScenario(input: {
  country: CountryPack;
  anchorDate: string;
}): { fiscalYear: number; period: number; from: string; to: string; label: string } {
  const variant = input.country.fiscalYear.variant;
  const { periodEnds } = input.country.fiscalYear;
  const [yearText, monthText, dayText] = input.anchorDate.split('-').map(Number);
  const posted = Date.UTC(yearText, monthText - 1, dayText);

  // Candidate fiscal years: the anchor's own calendar year and the one before it. A fiscal
  // year starting in April puts January to March in the year that started the previous
  // April, which is exactly the boundary the application itself once got wrong.
  for (const fiscalYear of [yearText - 1, yearText, yearText + 1]) {
    const windows = periodEnds.map((end, index) => {
      const previous = index === 0 ? periodEnds[periodEnds.length - 1]! : periodEnds[index - 1]!;
      const endOf = (p: { month: number; day: number; yearShift: number }, year: number) => {
        const calendarYear = year + p.yearShift;
        const lastDay = new Date(Date.UTC(calendarYear, p.month, 0)).getUTCDate();
        return Date.UTC(calendarYear, p.month - 1, Math.min(p.day, lastDay));
      };
      const previousEnd = endOf(previous, index === 0 ? fiscalYear - 1 : fiscalYear);
      return {
        period: end.period,
        start: previousEnd + 86_400_000,
        end: endOf(end, fiscalYear),
        label: end.label ?? `Period ${end.period}`,
      };
    });

    const match = windows.find((window) => posted >= window.start && posted <= window.end);
    if (match) {
      const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      return {
        fiscalYear,
        period: match.period,
        from: iso(match.start),
        to: iso(match.end),
        label: match.label,
      };
    }
  }

  throw new Error(
    `Anchor date ${input.anchorDate} does not fall in any period of fiscal year variant ${variant}.`,
  );
}

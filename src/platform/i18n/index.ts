/**
 * Locale layer — CAIRN.md R-19, D-008, §19.4
 *
 * Every user-visible string resolves through here. No screen may contain a
 * hardcoded label, because retrofitting translation across 60 screens is the
 * kind of cost that never gets paid back. The catalogue is deliberately small
 * today; the mechanism is what matters, and it is correct from the first commit.
 *
 * Adding Arabic later means adding a catalogue and a direction, not touching
 * screens — layouts already use logical CSS properties (start/end, not left/right).
 */

export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Text direction per locale, used to set the document direction (§19.4). */
export const LOCALE_DIRECTION: Record<Locale, 'ltr' | 'rtl'> = {
  en: 'ltr',
};

type Catalogue = Record<string, string>;

const en: Catalogue = {
  // ── Product ───────────────────────────────────────────────────────────────
  'app.name': 'Cairn',
  'app.tagline': 'Enterprise resource planning',
  'auth.signIn': 'Sign in',
  'auth.signOut': 'Sign out',
  'auth.authorities': 'authorities',
  'auth.tenant': 'Tenant',

  // ── Navigation ────────────────────────────────────────────────────────────
  'nav.launchpad': 'Launchpad',
  'nav.tenants': 'Tenants',
  'nav.workbench': 'Configuration workbench',
  'nav.registry': 'Term registry',
  'nav.journal': 'Accounting documents',

  // ── Command bar — the behaviour we keep (§19.1) ───────────────────────────
  'command.label': 'Command',
  'command.placeholder': 'Enter a transaction code, a configuration activity, or a familiar alias',
  'command.execute': 'Execute',
  'command.help': 'Press Enter to execute. Codes look like FIN.JOURNAL.POST.',
  'command.notFound': 'Nothing matches "{term}".',
  'command.notFoundHint':
    'Try one of our transaction codes, or search the term registry for a concept.',

  // ── Tenancy ───────────────────────────────────────────────────────────────
  'tenants.title': 'Tenants',
  'tenants.subtitle':
    'Each tenant is a complete partition: its own configuration, master data and number ranges.',
  'tenants.empty': 'No tenants yet.',
  'tenants.emptyHint': 'Create the first tenant to begin.',
  'tenants.create': 'Create tenant',
  'tenants.column.key': 'Key',
  'tenants.column.name': 'Name',
  'tenants.column.country': 'Country',
  'tenants.column.currency': 'Currency',
  'tenants.column.status': 'Status',
  'tenants.column.origin': 'Origin',
  'tenants.origin.development': 'Development',
  'tenants.origin.owner': 'Production',

  'onboard.title': 'Create tenant',
  'onboard.subtitle':
    'Create the tenant, its first administrator and its implementation checklist. Accounting number ranges are maintained afterwards through the workbench.',
  'onboard.section.identity': 'Tenant identity',
  'onboard.section.structure': 'Enterprise structure',
  'onboard.section.finance': 'Financial basis',
  'onboard.section.admin': 'First administrator',
  'onboard.clientKey': 'Tenant key',
  'onboard.clientKey.hint': 'Two to four letters or digits. Cannot be changed later.',
  'onboard.name': 'Tenant name',
  'onboard.legalName': 'Legal name',
  'onboard.country': 'Country',
  'onboard.currency': 'Currency',
  'onboard.timezone': 'Time zone',
  'onboard.companyCode': 'Company code',
  'onboard.companyCode.hint': 'The legal entity that keeps its own books.',
  'onboard.companyName': 'Company name',
  'onboard.fiscalYearVariant': 'Fiscal year variant',
  'onboard.chartOfAccounts': 'Chart of accounts',
  'onboard.username': 'Username',
  'onboard.fullName': 'Full name',
  'onboard.email': 'Email',
  'onboard.password': 'Password',
  'onboard.password.hint': 'At least 10 characters, with letters and digits.',
  'onboard.activatePackage': 'Activate standard configuration package',
  'onboard.submit': 'Create tenant',
  'onboard.cancel': 'Cancel',

  // ── Workbench ─────────────────────────────────────────────────────────────
  'workbench.title': 'Configuration workbench',
  'workbench.subtitle':
    'Every step is either a Define or an Assign. Blocked steps name what they are waiting for.',
  'workbench.progress': 'Progress',
  'workbench.next': 'Next step',
  'workbench.prerequisites': 'Requires',
  'workbench.enables': 'Enables',
  'workbench.kind.define': 'Define',
  'workbench.kind.assign': 'Assign',
  'workbench.status.notStarted': 'Not started',
  'workbench.status.completed': 'Completed',
  'workbench.status.blocked': 'Blocked',

  // ── Launchpad ─────────────────────────────────────────────────────────────
  'launchpad.title': 'Launchpad',
  'launchpad.subtitle': 'Foundation and master data are in build. These tiles lead to working screens.',
  'launchpad.status.title': 'Substrate status',
  'launchpad.status.body':
    'Numbering, locking, document flow, change documents and the posting engine are live, with the accounting balance invariant enforced by the database itself.',

  // ── Registry ──────────────────────────────────────────────────────────────
  'registry.title': 'Term registry',
  'registry.subtitle':
    'Our own codes and names are the product. Familiar external identifiers are accepted here as a lookup courtesy — nothing more.',
  'registry.search': 'Search',
  'registry.searchPlaceholder': 'A code, a table name, or a concept',
  'registry.results': 'Results',
  'registry.noResults': 'No matches.',
  'registry.coverage': 'Coverage',
  'registry.aliases': 'Also known as',
  'registry.aliasNote':
    'External identifiers are search metadata only. They are not part of Cairn naming.',

  // ── Material master ─────────────────────────────────────────────────────
  'material.title': "Material master",
  'material.create': "Create material",
  'material.list': "Material list",
  'material.subtitle': "Maintain basic data once, then extend the purchasing, planning and valuation views to each plant. Incomplete views can be saved for another department to finish.",
  'material.number': "Material",
  'material.description': "Description",
  'material.type': "Material type",
  'material.group': "Material group",
  'material.baseUnit': "Base unit",
  'material.industry': "Industry sector",
  'material.barcode': "Barcode / EAN",
  'material.grossWeight': "Gross weight",
  'material.netWeight': "Net weight",
  'material.weightUnit': "Weight unit",
  'material.blocked': "Blocked for operational use",
  'material.stagedNote': "Description, group and base unit complete the basic view. You can save an incomplete view. Blocking or unblocking an existing material requires a reason.",
  'material.purchasingGroup': "Purchasing group",
  'material.orderUnit': "Order unit",
  'material.manufacturerPart': "Manufacturer part number",
  'material.overdelivery': "Overdelivery tolerance (%)",
  'material.underdelivery': "Underdelivery tolerance (%)",
  'material.orderUnitNote': "Alternate order units require material conversions. This first slice accepts the base unit; conversion maintenance is still pending.",
  'material.mrpType': "Planning method",
  'material.controller': "MRP controller",
  'material.procurement': "Procurement type",
  'material.lotSizing': "Lot-sizing procedure",
  'material.fixedLot': "Fixed lot size",
  'material.minimumLot': "Minimum lot size",
  'material.maximumLot': "Maximum lot size (0 = unlimited)",
  'material.safetyStock': "Safety stock",
  'material.reorderPoint': "Reorder point",
  'material.deliveryDays': "Planned delivery time (days)",
  'material.productionDays': "In-house production time (days)",
  'material.mrpNote': "Quantities use the base unit. Saving relevant plant views marks the net-change planning file. The executable MRP run is still pending.",
  'material.valuationClass': "Valuation class",
  'material.priceControl': "Price control",
  'material.priceUnit': "Price unit",
  'material.standardPrice': "Standard price",
  'material.movingPrice': "Moving average price",
  'material.stockQuantity': "Book quantity (read-only)",
  'material.stockValue': "Book value (read-only)",
  'material.valuationNote': "The plant is the valuation area; currency comes from its company code. Book quantities and values cannot be edited here. Price changes with stock require a balanced revaluation document, not master maintenance.",
  'material.reason': "Reason / maintenance note",
  'material.saved': "View saved. Status: {status}.",
  'material.unchanged': "No data changed. Status: {status}.",
  'material.open': "Open material and its views",
  'material.notSet': "Not set",
  'material.status': "Status",
  'material.notFound': "Material {number} was not found in your tenant.",
  'material.copyNote': "Copying basic data from {number}. Enter a new material number. Plant and valuation views are not copied.",
  'material.copy': "Copy basic data",
  'material.choosePlant': "Select plant",
  'material.history': "Change history",
  'material.views': "Material views",
  'material.pending': "Pending",
  'material.noPlant': "Define an active plant before creating an organisational view.",
  'material.search': "Material number or description",
  'material.empty': "No materials match. Create a material to start.",
  'material.listLimit': "Up to 200 materials. Use search to narrow a larger catalogue.",
  'material.view.BASIC': "Basic data",
  'material.view.PURCHASING': "Purchasing",
  'material.view.MRP': "MRP",
  'material.view.ACCOUNTING': "Accounting / Costing",
  'material.view.PRODUCTION': "Production",
  'material.view.SALES': "Sales",
  'material.view.STORAGE': "Storage",
  'material.state.NOT_CREATED': "Not created",
  'material.state.INCOMPLETE': "Incomplete",
  'material.state.CREATED': "Created",
  'material.state.MAINTAINED': "Maintained",
  'material.state.BLOCKED': "Blocked",
  'material.code.REQUIREMENTS': "Requirements planning",
  'material.code.REORDER': "Reorder-point planning",
  'material.code.NONE': "No planning",
  'material.code.BUY': "External procurement",
  'material.code.MAKE': "In-house production",
  'material.code.BOTH': "Both procurement methods",
  'material.code.EXACT': "Lot for lot",
  'material.code.FIXED': "Fixed lot size",
  'material.code.STANDARD': "Standard price",
  'material.code.MOVING_AVERAGE': "Moving average price",
  'nav.materials': "Material master",

  'material.nonValuated': 'This material type does not have an inventory valuation view.',
  'material.view.SALES_GENERAL': 'Sales general / Plant',
  'material.view.FORECASTING': 'Forecasting',
  'material.view.QUALITY': 'Quality',
  'material.view.WAREHOUSE': 'Warehouse',
  'auth.fullAccess': 'Full access',
  'launchpad.materialMeta': 'Basic · Purchasing · MRP · Valuation',
  'launchpad.rangeMeta': 'Intervals · Allocation evidence',
  'launchpad.journalMeta': 'Post · Display · Trace',

  // ── Number ranges ───────────────────────────────────────────────────────
  'auth.missingAuthority': "This screen requires authority {authority}. Ask an administrator to update your role.",
  'auth.readOnly': "Read-only view. Changes require authority {authority}.",
  'nr.title': "Number ranges",
  'nr.subtitle': "Define intervals, monitor usage and inspect allocation evidence. Accounting ranges belong to a company code; operational ranges belong to the tenant.",
  'nr.create': "Create interval",
  'nr.edit': "Change interval",
  'nr.refresh': "Return to monitor",
  'nr.object': "Business object",
  'nr.scope': "Company / scope",
  'nr.subObject': "Range key",
  'nr.year': "Fiscal year",
  'nr.yearHint': "0 = year-independent. A specific year takes precedence.",
  'nr.from': "First number",
  'nr.to': "Last number",
  'nr.current': "Last issued",
  'nr.currentHint': "Read-only. Only a successful document posting advances this counter.",
  'nr.status': "Status",
  'nr.active': "Active",
  'nr.blocked': "Blocked",
  'nr.prefix': "Display prefix",
  'nr.width': "Numeric width",
  'nr.style': "Display format",
  'nr.readable': "Readable",
  'nr.classic': "Classic padded",
  'nr.preview': "Next number preview",
  'nr.reason': "Reason for change",
  'nr.initialReason': "Initial implementation",
  'nr.safety': "No counter reset or deletion. Existing lower limits and display formats cannot change. Issued numbers are never reused.",
  'nr.saved': "Interval saved and change evidence recorded.",
  'nr.ready': "Accounting numbering is ready",
  'nr.setupRequired': "Maintain accounting number ranges before the first posting.",
  'nr.assignments': "Document type → range assignment",
  'nr.state.MISSING': "Not defined",
  'nr.state.BLOCKED': "Blocked",
  'nr.state.EXTERNAL': "External numbering",
  'nr.state.EXHAUSTED': "Exhausted",
  'nr.interval': "Interval",
  'nr.remaining': "Remaining",
  'nr.tenantWide': "Tenant-wide",
  'nr.allYears': "All years",
  'nr.history': "History",
  'nr.empty': "No intervals match this selection.",
  'nr.monitorNote': "Blocked intervals keep their numbers reserved. The year shown in a readable document number comes from the document, not from the interval.",
  'nr.controlChange': "Control change",
  'nr.noChanges': "No recorded maintenance changes. Bootstrap intervals have not been edited.",
  'nr.allocations': "Recent allocations (up to 50)",
  'nr.number': "Displayed number",
  'nr.document': "Document key",
  'nr.by': "Issued by",
  'nr.at': "Issued at",
  'nr.noAllocations': "No allocations from this interval.",
  'common.saving': "Saving…",
  'common.all': "All objects",
  'common.filter': "Filter",
  'common.actions': "Actions",
  'common.change': "Change",

  // ── Company codes ─────────────────────────────────────────────────────────
  'cc.title': 'Company codes',
  'cc.subtitle':
    'The legal entity that keeps its own books. Each one is assigned a chart of accounts, ' +
    'a fiscal year variant and a posting period variant.',
  'cc.code': 'Company code',
  'cc.name': 'Name',
  'cc.currency': 'Local currency',
  'cc.country': 'Country',
  'cc.coa': 'Chart of accounts',
  'cc.fyv': 'Fiscal year variant',
  'cc.ppv': 'Posting period variant',
  'cc.plants': 'Plants',
  'cc.accounts': 'G/L accounts',
  'cc.detail': 'Company code detail',
  'cc.assignment': 'Assigned configuration',
  'cc.create': 'Create company code',
  'cc.city': 'City',
  'cc.taxNumber': 'Tax registration number',

  // ── G/L accounts ──────────────────────────────────────────────────────────
  'gl.title': 'G/L accounts',
  'gl.subtitle':
    'The chart of accounts. Every posting lands on one of these, so the account type and ' +
    'the reconciliation flag change what the bookkeeping will accept.',
  'gl.number': 'Account',
  'gl.name': 'Short text',
  'gl.type': 'Account type',
  'gl.group': 'Group',
  'gl.balanceSheet': 'Balance sheet',
  'gl.openItem': 'Open items',
  'gl.reconciliation': 'Reconciliation',
  'gl.costObject': 'Cost object required',
  'gl.tax': 'Tax relevant',
  'gl.search': 'Account number or short text',
  'gl.new': 'Create G/L account',
  'gl.create': 'Create',
  'gl.change': 'Change',
  'gl.type.asset': 'Asset',
  'gl.type.liability': 'Liability',
  'gl.type.equity': 'Equity',
  'gl.type.revenue': 'Revenue',
  'gl.type.expense': 'Expense',
  'gl.recon.vendor': 'Vendor',
  'gl.recon.customer': 'Customer',
  'gl.recon.asset': 'Asset',
  'gl.recon.material': 'Material',

  // ── Posting periods ───────────────────────────────────────────────────────
  'pp.title': 'Posting periods',
  'pp.subtitle':
    'Which periods are open, per account type. Closing a period is a controlled action and ' +
    'is recorded in the change log with the user who did it.',
  'pp.accountType': 'Account type',
  'pp.openRange': 'Open periods',
  'pp.from': 'From',
  'pp.to': 'To',
  'pp.specials': 'Special periods',
  'pp.save': 'Apply',
  'pp.saved': 'Posting period rule updated.',
  'pp.note':
    'Vendor and customer periods are normally closed ahead of the general ledger, so that ' +
    'late supplier invoices cannot change a subledger that has already been reported.',

  // ── Plants ────────────────────────────────────────────────────────────────
  'plant.title': 'Plants',
  'plant.subtitle':
    'Production and storage sites. A plant belongs to exactly one company code.',
  'plant.code': 'Plant',
  'plant.name': 'Name',
  'plant.company': 'Company code',
  'plant.locations': 'Storage locations',
  'plant.production': 'Production',
  'plant.storage': 'Storage',

  // ── Journal ───────────────────────────────────────────────────────────────
  'journal.title': 'Accounting documents',
  'journal.subtitle':
    'Every posting, with its lines and its document flow. Nothing here can be deleted — ' +
    'corrections are reversal documents that reference the original.',
  'journal.number': 'Document',
  'journal.type': 'Type',
  'journal.date': 'Posting date',
  'journal.period': 'Period',
  'journal.amount': 'Amount',
  'journal.status': 'Status',
  'journal.lines': 'Lines',
  'journal.empty': 'No documents posted yet.',
  'journal.emptyHint':
    'Post a journal entry to see the document appear here with its lines and flow.',
  'journal.details': 'Document detail',
  'journal.postTitle': 'Post a journal entry',
  'journal.postSubtitle':
    'Debits must equal credits. The fiscal year and period are derived from the posting date ' +
    'using the company code fiscal year variant, so they cannot disagree with it.',
  'journal.headerData': 'Header data',
  'journal.headerText': 'Header text',
  'journal.reference': 'Reference',
  'journal.currency': 'Currency',
  'journal.lineItems': 'Line items',
  'journal.addLine': 'Add line',
  'journal.balanced': 'Document balances. Ready to post.',
  'journal.unbalanced': 'Document does not balance. Difference {difference}.',
  'journal.post': 'Post',
  'journal.posting': 'Posting…',
  'journal.postHint':
    'Posting allocates a document number and writes the accounting document in one transaction. ' +
    'If anything fails, nothing is saved and no number is consumed.',

  // ── Common ────────────────────────────────────────────────────────────────
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.close': 'Close',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.required': 'Required',
  'common.optional': 'Optional',
  'common.error': 'Error',
  'common.success': 'Done',

  // ── Status bar ────────────────────────────────────────────────────────────
  'status.ready': 'Ready',
  'status.environment': 'Environment',
  'status.noTenant': 'No tenant selected',
};

const CATALOGUES: Record<Locale, Catalogue> = { en };

/**
 * Translate a key, interpolating {placeholders}.
 *
 * A missing key returns the key itself rather than an empty string, so a gap is
 * visible in the UI instead of silently producing a blank label.
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
  let text = catalogue[key] ?? key;

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

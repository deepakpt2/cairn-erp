/**
 * Seed — global reference data that exists once per installation.
 *
 * Configuration activities (the define/assign chain from CAIRN.md §6.2), the
 * capability catalogue, and the message catalogue. Tenant-specific data belongs
 * in the onboarding flow, not here.
 *
 * Runs as the owning role: these are global tables with no tenant scope.
 */
import postgres from 'postgres';
import { PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY } from '../src/platform/security/partner-bank-profile-activation';

interface Activity {
  code: string;
  area: string;
  subArea?: string;
  title: string;
  kind: 'DEFINE' | 'ASSIGN';
  prerequisites: string[];
  enables: string;
  wizardStage?: 'ONBOARDING' | 'STANDARD';
  route?: string;
}

/**
 * The define/assign chain. This sequence is what makes an implementation plan
 * portable (R-06) — the same steps, in the same order, with the same gating.
 */
const ACTIVITIES: Activity[] = [
  // ── Platform ──────────────────────────────────────────────────────────────
  { code: 'CFG.PLT.CLIENT.DEFINE', area: 'PLATFORM', title: 'Define tenant', kind: 'DEFINE', prerequisites: [], enables: 'Everything else', wizardStage: 'ONBOARDING', route: '/clients/new' },
  { code: 'CFG.PLT.ROLE.DEFINE', area: 'PLATFORM', title: 'Define roles and capabilities', kind: 'DEFINE', prerequisites: ['CFG.PLT.CLIENT.DEFINE'], enables: 'User authorisation', wizardStage: 'ONBOARDING', route: '/config/roles' },
  { code: 'CFG.PLT.USER.CREATE', area: 'PLATFORM', title: 'Create users', kind: 'DEFINE', prerequisites: ['CFG.PLT.ROLE.DEFINE'], enables: 'Sign-in', wizardStage: 'ONBOARDING', route: '/config/users' },
  { code: 'CFG.PLT.NUMBERRANGE.DEFINE', area: 'PLATFORM', title: 'Define number ranges', kind: 'DEFINE', prerequisites: ['CFG.PLT.CLIENT.DEFINE'], enables: 'Document numbering', wizardStage: 'ONBOARDING', route: '/config/number-ranges' },

  // ── Enterprise structure ──────────────────────────────────────────────────
  { code: 'CFG.ORG.COMPANYCODE.DEFINE', area: 'ENTERPRISE_STRUCTURE', title: 'Define company code', kind: 'DEFINE', prerequisites: ['CFG.PLT.CLIENT.DEFINE'], enables: 'Financial accounting', wizardStage: 'ONBOARDING', route: '/config/company-codes' },
  { code: 'CFG.FIN.COA.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define chart of accounts', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'G/L accounts', wizardStage: 'ONBOARDING', route: '/config/chart-of-accounts' },
  { code: 'CFG.ORG.COMPANYCODE.ASSIGN_COA', area: 'ENTERPRISE_STRUCTURE', title: 'Assign chart of accounts to company code', kind: 'ASSIGN', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.COA.DEFINE'], enables: 'Account posting', wizardStage: 'ONBOARDING', route: '/config/company-codes' },
  { code: 'CFG.FIN.FYV.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define fiscal year variant', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Posting periods', wizardStage: 'ONBOARDING', route: '/config/fiscal-year-variants' },
  { code: 'CFG.FIN.FYV.ASSIGN', area: 'FINANCIAL_ACCOUNTING', title: 'Assign fiscal year variant to company code', kind: 'ASSIGN', prerequisites: ['CFG.FIN.FYV.DEFINE'], enables: 'Period control', wizardStage: 'ONBOARDING', route: '/config/company-codes' },
  { code: 'CFG.FIN.PPV.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define posting period variant', kind: 'DEFINE', prerequisites: ['CFG.FIN.FYV.ASSIGN'], enables: 'Open and closed periods', wizardStage: 'ONBOARDING', route: '/config/posting-periods' },
  { code: 'CFG.FIN.PPV.ASSIGN', area: 'FINANCIAL_ACCOUNTING', title: 'Assign posting period variant to company code', kind: 'ASSIGN', prerequisites: ['CFG.FIN.PPV.DEFINE'], enables: 'Period locking', wizardStage: 'ONBOARDING', route: '/config/posting-periods' },
  { code: 'CFG.FIN.EXRATE.MAINTAIN', area: 'FINANCIAL_ACCOUNTING', title: 'Maintain exchange rates', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Foreign currency posting', wizardStage: 'ONBOARDING', route: '/config/exchange-rates' },
  { code: 'CFG.FIN.TAXCODE.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define tax codes', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Tax determination', wizardStage: 'ONBOARDING', route: '/config/tax-codes' },
  { code: 'CFG.FIN.PAYTERMS.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define payment terms', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Due date calculation', wizardStage: 'ONBOARDING', route: '/config/payment-terms' },
  { code: 'CFG.FIN.PAYMENTMETHOD.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define payment methods', kind: 'DEFINE', prerequisites: ['CFG.PLT.CLIENT.DEFINE'], enables: 'Country-specific payment-method definitions', wizardStage: 'STANDARD', route: '/config/payment-methods' },
  { code: 'CFG.FIN.DOCTYPE.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define document types', kind: 'DEFINE', prerequisites: ['CFG.PLT.NUMBERRANGE.DEFINE'], enables: 'Document classification', wizardStage: 'ONBOARDING', route: '/config/document-types' },
  { code: 'CFG.FIN.ACCTDET.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define account determination', kind: 'DEFINE', prerequisites: ['CFG.FIN.COA.DEFINE'], enables: 'Automatic postings from logistics', wizardStage: 'ONBOARDING', route: '/config/account-determination' },

  { code: 'CFG.ORG.PLANT.DEFINE', area: 'ENTERPRISE_STRUCTURE', title: 'Define plant', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Materials, production, procurement', wizardStage: 'ONBOARDING', route: '/config/plants' },
  { code: 'CFG.ORG.PLANT.ASSIGN_COMPANY', area: 'ENTERPRISE_STRUCTURE', title: 'Assign plant to company code', kind: 'ASSIGN', prerequisites: ['CFG.ORG.PLANT.DEFINE'], enables: 'Plant accounting', wizardStage: 'ONBOARDING', route: '/config/plants' },
  { code: 'CFG.ORG.STORAGELOC.DEFINE', area: 'ENTERPRISE_STRUCTURE', title: 'Define storage location', kind: 'DEFINE', prerequisites: ['CFG.ORG.PLANT.DEFINE'], enables: 'Stock management by area', wizardStage: 'ONBOARDING', route: '/config/storage-locations' },

  { code: 'CFG.PROC.PURORG.DEFINE', area: 'MATERIALS_MANAGEMENT', title: 'Define purchasing organisation', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Purchasing', wizardStage: 'ONBOARDING', route: '/config/purchasing-orgs' },
  { code: 'CFG.PROC.PURORG.ASSIGN_COMPANY', area: 'MATERIALS_MANAGEMENT', title: 'Assign purchasing organisation to company code', kind: 'ASSIGN', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.PROC.PURORG.DEFINE'], enables: 'Buying authority', wizardStage: 'ONBOARDING', route: '/config/purchasing-orgs/assign-company' },
  { code: 'CFG.PROC.PURORG.ASSIGN_PLANT', area: 'MATERIALS_MANAGEMENT', title: 'Assign purchasing organisation to plant', kind: 'ASSIGN', prerequisites: ['CFG.PROC.PURORG.DEFINE', 'CFG.ORG.PLANT.DEFINE'], enables: 'Plant procurement', wizardStage: 'ONBOARDING', route: '/config/purchasing-orgs' },
  { code: 'CFG.PROC.PURGROUP.DEFINE', area: 'MATERIALS_MANAGEMENT', title: 'Define purchasing groups', kind: 'DEFINE', prerequisites: ['CFG.PROC.PURORG.DEFINE'], enables: 'Buyer assignment', wizardStage: 'ONBOARDING', route: '/config/purchasing-groups' },
  { code: 'CFG.PROC.RELEASE.DEFINE', area: 'MATERIALS_MANAGEMENT', title: 'Define release strategy for purchase orders', kind: 'DEFINE', prerequisites: ['CFG.PROC.PURGROUP.DEFINE'], enables: 'Document approval (R-05)', wizardStage: 'ONBOARDING', route: '/config/release-strategies' },

  { code: 'CFG.ORG.SALESORG.DEFINE', area: 'SALES', title: 'Define Sales Organizations', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Selling and Sales Areas', wizardStage: 'ONBOARDING', route: '/config/sales-orgs' },
  { code: 'CFG.ORG.SALESORG.ASSIGN_COMPANY', area: 'SALES', title: 'Assign Sales Organization to Company Code', kind: 'ASSIGN', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.ORG.SALESORG.DEFINE'], enables: 'Sales accounting', wizardStage: 'ONBOARDING', route: '/config/sales-orgs/assign-company' },
  { code: 'CFG.ORG.DISTCHANNEL.DEFINE', area: 'SALES', title: 'Define distribution channel', kind: 'DEFINE', prerequisites: ['CFG.ORG.SALESORG.DEFINE'], enables: 'Sales areas', wizardStage: 'ONBOARDING', route: '/config/distribution-channels' },
  { code: 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL', area: 'SALES', title: 'Assign Distribution Channel to Sales Organization', kind: 'ASSIGN', prerequisites: ['CFG.ORG.SALESORG.DEFINE', 'CFG.ORG.DISTCHANNEL.DEFINE'], enables: 'Sales Area eligibility', wizardStage: 'ONBOARDING', route: '/config/sales-orgs/assign-distribution-channel' },
  { code: 'CFG.ORG.DIVISION.DEFINE', area: 'SALES', title: 'Define division', kind: 'DEFINE', prerequisites: ['CFG.ORG.SALESORG.DEFINE'], enables: 'Product line reporting', wizardStage: 'ONBOARDING', route: '/config/divisions' },
  { code: 'CFG.ORG.SALESORG.ASSIGN_DIVISION', area: 'SALES', title: 'Assign Division to Sales Organization', kind: 'ASSIGN', prerequisites: ['CFG.ORG.SALESORG.DEFINE', 'CFG.ORG.DIVISION.DEFINE'], enables: 'Sales Area eligibility', wizardStage: 'ONBOARDING', route: '/config/sales-orgs/assign-division' },
  { code: 'CFG.ORG.SALESAREA.DEFINE', area: 'SALES', title: 'Define sales area', kind: 'DEFINE', prerequisites: ['CFG.ORG.SALESORG.DEFINE', 'CFG.ORG.DISTCHANNEL.DEFINE', 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL', 'CFG.ORG.DIVISION.DEFINE', 'CFG.ORG.SALESORG.ASSIGN_DIVISION'], enables: 'Sales master data and documents', wizardStage: 'ONBOARDING', route: '/config/sales-areas' },
  { code: 'CFG.SALES.PRICING.DEFINE', area: 'SALES', title: 'Define pricing procedure', kind: 'DEFINE', prerequisites: ['CFG.ORG.SALESAREA.DEFINE'], enables: 'Price determination', wizardStage: 'ONBOARDING', route: '/config/pricing-procedures' },
  { code: 'CFG.SALES.CONDITION.MAINTAIN', area: 'SALES', title: 'Maintain condition records', kind: 'DEFINE', prerequisites: ['CFG.SALES.PRICING.DEFINE'], enables: 'Actual prices on documents', wizardStage: 'STANDARD', route: '/config/conditions' },

  { code: 'CFG.COST.CONTROLLINGAREA.DEFINE', area: 'CONTROLLING', title: 'Define controlling area', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Cost accounting', wizardStage: 'ONBOARDING', route: '/config/controlling-area' },
  { code: 'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY', area: 'CONTROLLING', title: 'Assign controlling area to company code', kind: 'ASSIGN', prerequisites: ['CFG.COST.CONTROLLINGAREA.DEFINE'], enables: 'Cost postings', wizardStage: 'ONBOARDING', route: '/config/controlling-area/assign-company-code' },
  { code: 'CFG.COST.COSTCENTER.DEFINE', area: 'CONTROLLING', title: 'Define cost centres', kind: 'DEFINE', prerequisites: ['CFG.COST.CONTROLLINGAREA.DEFINE'], enables: 'Cost collection and allocation', wizardStage: 'ONBOARDING', route: '/config/cost-centers' },
  { code: 'CFG.COST.COSTCENTERHIER.DEFINE', area: 'CONTROLLING', title: 'Define cost centre hierarchy', kind: 'DEFINE', prerequisites: ['CFG.COST.COSTCENTER.DEFINE'], enables: 'Cost centre reporting', wizardStage: 'STANDARD', route: '/config/cost-center-hierarchy' },
  { code: 'CFG.COST.ACTIVITYTYPE.DEFINE', area: 'CONTROLLING', title: 'Define activity types', kind: 'DEFINE', prerequisites: ['CFG.COST.COSTCENTER.DEFINE'], enables: 'Activity costing', wizardStage: 'ONBOARDING', route: '/config/activity-types' },
  { code: 'CFG.COST.ACTIVITYRATE.CONFIRM', area: 'CONTROLLING', title: 'Confirm activity prices per period', kind: 'DEFINE', prerequisites: ['CFG.COST.ACTIVITYTYPE.DEFINE'], enables: 'Production order costing', wizardStage: 'STANDARD', route: '/config/activity-rates' },
  { code: 'CFG.COST.PROFITCENTER.DEFINE', area: 'CONTROLLING', title: 'Define profit centres', kind: 'DEFINE', prerequisites: ['CFG.COST.CONTROLLINGAREA.DEFINE'], enables: 'Profitability reporting', wizardStage: 'ONBOARDING', route: '/config/profit-centers' },

  { code: 'CFG.INV.MATERIALTYPE.DEFINE', area: 'MATERIALS_MANAGEMENT', title: 'Define material types', kind: 'DEFINE', prerequisites: ['CFG.ORG.PLANT.DEFINE'], enables: 'Material master', wizardStage: 'ONBOARDING', route: '/config/material-types' },
  { code: 'CFG.INV.MATERIALGROUP.DEFINE', area: 'MATERIALS_MANAGEMENT', title: 'Define material groups', kind: 'DEFINE', prerequisites: ['CFG.INV.MATERIALTYPE.DEFINE'], enables: 'Material reporting', wizardStage: 'ONBOARDING', route: '/config/material-groups' },
  { code: 'CFG.INV.MOVETYPE.CONFIG', area: 'MATERIALS_MANAGEMENT', title: 'Configure movement types', kind: 'DEFINE', prerequisites: ['CFG.FIN.ACCTDET.DEFINE'], enables: 'Goods movements with accounting', wizardStage: 'ONBOARDING', route: '/config/movement-types' },

  { code: 'CFG.PROD.WORKCENTER.DEFINE', area: 'PRODUCTION', title: 'Define work centres', kind: 'DEFINE', prerequisites: ['CFG.COST.COSTCENTER.DEFINE'], enables: 'Routings and capacity', wizardStage: 'ONBOARDING', route: '/config/work-centers' },
  { code: 'CFG.PROD.MRPCONTROLLER.DEFINE', area: 'PRODUCTION', title: 'Define MRP controllers', kind: 'DEFINE', prerequisites: ['CFG.ORG.PLANT.DEFINE'], enables: 'MRP planning', wizardStage: 'ONBOARDING', route: '/config/mrp-controllers' },
  { code: 'CFG.PROD.LOTSIZE.DEFINE', area: 'PRODUCTION', title: 'Define lot sizing procedures', kind: 'DEFINE', prerequisites: ['CFG.ORG.PLANT.DEFINE'], enables: 'MRP lot sizing', wizardStage: 'ONBOARDING', route: '/config/lot-sizing' },
  { code: 'CFG.PROD.SCHEDULING.CONFIG', area: 'PRODUCTION', title: 'Configure scheduling parameters', kind: 'DEFINE', prerequisites: ['CFG.PROD.WORKCENTER.DEFINE'], enables: 'Order scheduling', wizardStage: 'STANDARD', route: '/config/scheduling' },

  { code: 'CFG.PEOPLE.RECORDTYPE.DEFINE', area: 'PEOPLE', title: 'Define employee record types', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Employee master data', wizardStage: 'ONBOARDING', route: '/config/record-types' },
  { code: 'CFG.PEOPLE.PAYCOMPONENT.DEFINE', area: 'PEOPLE', title: 'Define pay components', kind: 'DEFINE', prerequisites: ['CFG.PEOPLE.RECORDTYPE.DEFINE'], enables: 'Payroll', wizardStage: 'ONBOARDING', route: '/config/pay-components' },
  { code: 'CFG.PEOPLE.DEDUCTION.DEFINE', area: 'PEOPLE', title: 'Define deduction rules', kind: 'DEFINE', prerequisites: ['CFG.PEOPLE.PAYCOMPONENT.DEFINE'], enables: 'Net pay calculation', wizardStage: 'STANDARD', route: '/config/deduction-rules' },

  { code: 'CFG.FIN.CREDIT.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define credit control area', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Credit management (D-029)', wizardStage: 'ONBOARDING', route: '/config/credit-control' },
  { code: 'CFG.FIN.INTERCOMPANY.DEFINE', area: 'FINANCIAL_ACCOUNTING', title: 'Define intercompany accounts', kind: 'DEFINE', prerequisites: ['CFG.FIN.COA.DEFINE'], enables: 'Cross-company posting (D-028)', wizardStage: 'ONBOARDING', route: '/config/intercompany' },
  { code: 'CFG.PLT.MAIL.DEFINE', area: 'PLATFORM', title: 'Configure mail server', kind: 'DEFINE', prerequisites: ['CFG.PLT.CLIENT.DEFINE'], enables: 'Document output by email (D-033)', wizardStage: 'STANDARD', route: '/config/mail' },
];

const CAPABILITIES: Array<{ code: string; module: string; action: string; posting: boolean; description: string }> = [
  { code: 'CFG.PLT.CLIENT.ONBOARD', module: 'PLT', action: 'CONFIGURE', posting: false, description: 'Provision a tenant with deployment-owner authorization' },
  { code: 'CFG.ORG.COMPANYCODE.DEFINE', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Define tenant-scoped company-code records' },
  { code: 'CFG.FIN.COA.DEFINE', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Define and maintain tenant-scoped Chart of Accounts settings' },
  { code: 'CFG.ORG.PLANT.DEFINE', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Define and change tenant-scoped Plant records' },
  { code: 'CFG.ORG.PLANT.ASSIGN_COMPANY', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Assign an unassigned Plant to a Company Code' },
  { code: 'CFG.ORG.STORAGELOC.DEFINE', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Define and maintain tenant-scoped Storage Locations' },
  { code: 'CFG.ORG.SALESORG.DEFINE', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Define, change and deactivate tenant-scoped Sales Organizations' },
  { code: 'CFG.ORG.SALESORG.ASSIGN_COMPANY', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Assign an active tenant Sales Organization to one active Company Code' },
  { code: 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Assign or remove tenant Sales Organization and Distribution Channel pairs' },
  { code: 'CFG.ORG.DISTCHANNEL.DEFINE', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Define, change, copy and deactivate tenant-scoped Distribution Channels' },
  { code: 'CFG.ORG.DIVISION.DEFINE', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Define, change, copy and deactivate tenant-scoped Divisions' },
  { code: 'CFG.ORG.SALESORG.ASSIGN_DIVISION', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Assign or remove tenant Sales Organization and Division pairs' },
  { code: 'CFG.ORG.SALESAREA.DEFINE', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Create, change, deactivate and reactivate tenant Sales Areas' },
  { code: 'CFG.PROC.PURORG.DEFINE', module: 'PROC', action: 'CONFIGURE', posting: false, description: 'Define and maintain tenant-scoped Purchasing Organisations' },
  { code: 'CFG.PROC.PURORG.ASSIGN_COMPANY', module: 'PROC', action: 'CONFIGURE', posting: false, description: 'Assign an active tenant Purchasing Organisation to one active Company Code' },
  { code: 'CFG.ORG.COMPANYCODE.ASSIGN_COA', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Assign a chart of accounts to a Company Code' },
  { code: 'CFG.FIN.PAYTERMS.DEFINE', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Maintain payment-term definitions' },
  { code: 'CFG.FIN.PAYMENTMETHOD.DEFINE', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Maintain country-specific payment-method definitions' },
  { code: 'FND.PARTNER.DISPLAY', module: 'FND', action: 'DISPLAY', posting: false, description: 'Display general business partner data' },
  { code: 'FND.PARTNER.MAINTAIN', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Maintain general business partner data and role assignments' },
  { code: PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY, module: 'FND', action: 'CONFIGURE', posting: false, description: 'Activate an approved global partner-bank country profile' },
  { code: 'SEC.PARTNER.BANK.REVEAL', module: 'SEC', action: 'EXECUTE', posting: false, description: 'Reveal selected partner-bank account identifiers after authorization and audit' },
  { code: 'FIN.SUPPLIER.COMPANY.MAINTAIN', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Maintain supplier company accounting assignments' },
  { code: 'FIN.SUPPLIER.COMPANY.DISPLAY', module: 'FIN', action: 'DISPLAY', posting: false, description: 'Review supplier company accounting assignments' },
  { code: 'PROC.SUPPLIER.PURCHASING.MAINTAIN', module: 'PROC', action: 'CONFIGURE', posting: false, description: 'Maintain supplier purchasing defaults' },
  { code: 'PROC.SUPPLIER.PURCHASING.DISPLAY', module: 'PROC', action: 'DISPLAY', posting: false, description: 'Review supplier purchasing defaults' },
  { code: 'FIN.CUSTOMER.COMPANY.MAINTAIN', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Maintain customer company accounting assignments' },
  { code: 'FIN.CUSTOMER.COMPANY.DISPLAY', module: 'FIN', action: 'DISPLAY', posting: false, description: 'Review customer company accounting assignments' },
  { code: 'SALES.CUSTOMER.SALESAREA.MAINTAIN', module: 'SALES', action: 'CONFIGURE', posting: false, description: 'Maintain customer sales-area pricing and delivery defaults' },
  { code: 'SALES.CUSTOMER.SALESAREA.DISPLAY', module: 'SALES', action: 'DISPLAY', posting: false, description: 'Review customer sales-area pricing and delivery defaults' },
  { code: 'SYSTEM.WILDCARD', module: 'PLT', action: 'EXECUTE', posting: true, description: 'All capabilities — administrators only' },
  { code: 'FIN.CLOSE.PERIOD', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Open or close posting periods' },
  { code: 'CFG.PLT.NUMBERRANGE.DEFINE', module: 'PLT', action: 'CONFIGURE', posting: false, description: 'Maintain number range intervals' },
  { code: 'INV.MATERIAL.MAINTAIN', module: 'INV', action: 'CONFIGURE', posting: false, description: 'Maintain material basic data' },
  { code: 'PROC.MATERIAL.PURCHASING.MAINTAIN', module: 'PROC', action: 'CONFIGURE', posting: false, description: 'Maintain purchasing material views' },
  { code: 'PROD.MATERIAL.MRP.MAINTAIN', module: 'PROD', action: 'CONFIGURE', posting: false, description: 'Maintain material planning views' },
  { code: 'FIN.MATERIAL.VALUATION.DISPLAY', module: 'FIN', action: 'DISPLAY', posting: false, description: 'Display material valuation and price history' },
  { code: 'FIN.MATERIAL.VALUATION.MAINTAIN', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Maintain valuation views without stock' },
  { code: 'FIN.JOURNAL.POST', module: 'FIN', action: 'POST', posting: true, description: 'Post a journal entry' },
  { code: 'FIN.JOURNAL.REVERSE', module: 'FIN', action: 'REVERSE', posting: true, description: 'Reverse an accounting document' },
  { code: 'FIN.JOURNAL.DISPLAY', module: 'FIN', action: 'DISPLAY', posting: false, description: 'Display an accounting document' },
  { code: 'CFG.FIN.COA.COPY', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Copy every G/L account of one chart of accounts into another inside the tenant' },
  { code: 'CFG.FIN.FYV.DEFINE', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Define fiscal year variants and maintain the period lists behind them' },
  { code: 'CFG.FIN.GLACCOUNT.CREATE', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Create a G/L account master record in an active, unblocked chart of accounts' },
  { code: 'CFG.FIN.GLACCOUNT.CHANGE', module: 'FIN', action: 'CONFIGURE', posting: false, description: 'Change a G/L account master record, its posting and creation blocks, the account group registry and its field status matrix' },
  { code: 'CFG.FIN.GLACCOUNT.DISPLAY', module: 'FIN', action: 'DISPLAY', posting: false, description: 'Display G/L account master records, the account group registry and their change history' },
  { code: 'FIN.AP.PAYMENTRUN.EXECUTE', module: 'FIN', action: 'EXECUTE', posting: true, description: 'Execute a payment run' },
  { code: 'PROC.PO.CREATE', module: 'PROC', action: 'CREATE', posting: false, description: 'Create a purchase order' },
  { code: 'PROC.PO.RELEASE', module: 'PROC', action: 'APPROVE', posting: false, description: 'Release a purchase order' },
  { code: 'PROC.INV.RECORD', module: 'PROC', action: 'CREATE', posting: true, description: 'Record a supplier invoice' },
  { code: 'INV.GR.POST', module: 'INV', action: 'POST', posting: true, description: 'Post a goods receipt' },
  { code: 'INV.GI.POST', module: 'INV', action: 'POST', posting: true, description: 'Post a goods issue' },
  { code: 'INV.STOCK.VIEW', module: 'INV', action: 'DISPLAY', posting: false, description: 'Display stock' },
  { code: 'PROD.ORDER.CREATE', module: 'PROD', action: 'CREATE', posting: false, description: 'Create a production order' },
  { code: 'PROD.ORDER.RELEASE', module: 'PROD', action: 'RELEASE', posting: false, description: 'Release a production order' },
  { code: 'PROD.ORDER.GI', module: 'PROD', action: 'POST', posting: true, description: 'Issue components to a production order' },
  { code: 'PROD.ORDER.GR', module: 'PROD', action: 'POST', posting: true, description: 'Receive finished goods from a production order' },
  { code: 'PROD.ORDER.SETTLE', module: 'PROD', action: 'SETTLE', posting: true, description: 'Settle a production order' },
  { code: 'PROD.MRP.RUN', module: 'PROD', action: 'EXECUTE', posting: false, description: 'Run material requirements planning' },
  { code: 'PROD.CONFIRM.ENTER', module: 'PROD', action: 'CREATE', posting: true, description: 'Enter a production confirmation' },
  { code: 'SALES.ORDER.CREATE', module: 'SALES', action: 'CREATE', posting: false, description: 'Create a sales order' },
  { code: 'SALES.ORDER.RELEASE', module: 'SALES', action: 'APPROVE', posting: false, description: 'Release a sales order' },
  { code: 'SALES.GI.POST', module: 'SALES', action: 'POST', posting: true, description: 'Post goods issue from a delivery' },
  { code: 'SALES.BILLING.CREATE', module: 'SALES', action: 'CREATE', posting: true, description: 'Create a billing document' },
  { code: 'SALES.PAYMENT.ENTER', module: 'SALES', action: 'POST', posting: true, description: 'Enter an incoming payment' },
  { code: 'COST.CENTER.CREATE', module: 'COST', action: 'CONFIGURE', posting: false, description: 'Create a cost centre' },
  { code: 'COST.ACTIVITYRATE.CONFIRM', module: 'COST', action: 'CONFIGURE', posting: false, description: 'Confirm activity prices' },
  { code: 'PEOPLE.PAYROLL.POST', module: 'PEOPLE', action: 'POST', posting: true, description: 'Post payroll to the general ledger' },
  { code: 'AUDIT.WORKSPACE', module: 'AUDIT', action: 'DISPLAY', posting: false, description: 'Open the auditor workspace' },
  { code: 'AUDIT.EVIDENCE.EXPORT', module: 'AUDIT', action: 'EXPORT', posting: false, description: 'Export an evidence pack' },
  { code: 'AUDIT.TRAIL.VIEW', module: 'AUDIT', action: 'DISPLAY', posting: false, description: 'View change history and document trail' },
];


/**
 * Term registry — CAIRN.md §4.4
 *
 * Our own codes and routes are the real content. Reference identifiers appear
 * here ONLY as search aliases, so an experienced user can type a familiar code
 * and land on our screen. This is the one place they exist — see §19.5 AI-05.
 */
const REGISTRY: Array<{
  ourCode: string;
  /** Data-model entries carry a table name instead of a transaction code. */
  ourTable?: string;
  termType: string;
  module: string;
  title: string;
  route: string;
  tier: string;
  conformance?: string;
  aliases?: string[];
  description?: string;
}> = [
  { ourCode: 'FIN.CUSTOMER.COMPANY.MAINTAIN', termType: 'TRANSACTION', module: 'FIN', title: 'Customer company accounting', route: '/foundation/partners?view=CUSTOMER_COMPANY', tier: 'TIER_1_BUILT', conformance: 'B', description: 'Company-scoped AR reconciliation and payment terms; no billing or clearing.' },
  { ourCode: 'SALES.CUSTOMER.SALESAREA.MAINTAIN', termType: 'TRANSACTION', module: 'SALES', title: 'Customer sales area defaults', route: '/foundation/partners?view=CUSTOMER_SALES', tier: 'TIER_1_BUILT', conformance: 'B', aliases: ['VD02', 'VD03'], description: 'Sales-area pricing procedure, delivering plant and delivery defaults; no order or billing.' },
  { ourCode: 'PROC.SUPPLIER.PURCHASING.MAINTAIN', termType: 'TRANSACTION', module: 'PROC', title: 'Supplier purchasing defaults', route: '/foundation/partners?view=SUPPLIER_PURCHASING', tier: 'TIER_1_BUILT', conformance: 'B', description: 'Organisation-scoped buying defaults, not purchase order execution.' },
  { ourCode: 'FIN.SUPPLIER.COMPANY.MAINTAIN', termType: 'TRANSACTION', module: 'FIN', title: 'Supplier company accounting', route: '/foundation/partners?view=SUPPLIER_COMPANY', tier: 'TIER_1_BUILT', conformance: 'B', description: 'Company-scoped reconciliation and payment terms; no invoice or payment posting.' },
  { ourCode: 'FND.PARTNER.CREATE', termType: 'TRANSACTION', module: 'FND', title: 'Create business partner', route: '/foundation/partners?new=1', tier: 'TIER_1_BUILT', conformance: 'B', aliases: ['BP', 'XK01', 'XD01'], description: 'General identity and stable supplier/customer roles; organisation segments are pending.' },
  { ourCode: 'FND.PARTNER.DISPLAY', termType: 'TRANSACTION', module: 'FND', title: 'Business partner list', route: '/foundation/partners', tier: 'TIER_1_BUILT', conformance: 'B', description: 'Search general partner data and review change evidence.' },
  { ourCode: 'FND.PARTNER.MAINTAIN', termType: 'TRANSACTION', module: 'FND', title: 'Maintain general business partners', route: '/foundation/partners', tier: 'TIER_1_BUILT', conformance: 'B', description: 'Role-protected maintenance of general partner data only.' },
  { ourCode: 'CFG.FIN.PAYTERMS.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'Payment terms', route: '/config/payment-terms', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OBB8'], description: 'Due-date offsets and exact cash-discount deadlines with audit history.' },
  { ourCode: 'CFG.FIN.PAYMENTMETHOD.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'Payment method definitions', route: '/config/payment-methods', tier: 'TIER_2_CONFIGURED', conformance: 'B', description: 'Country-specific definitions and their change history; no payment execution or partner assignment.' },
  { ourCode: 'INV.MATERIAL.CREATE', termType: 'TRANSACTION', module: 'INV', title: 'Create material', route: '/inventory/materials?new=1', tier: 'TIER_1_BUILT', conformance: 'B', aliases: ['MM01'], description: 'Basic, purchasing, MRP and valuation views. Other views are still pending.' },
  { ourCode: 'INV.MATERIAL.DISPLAY', termType: 'TRANSACTION', module: 'INV', title: 'Material master list', route: '/inventory/materials', tier: 'TIER_1_BUILT', conformance: 'B', aliases: ['MM02', 'MM03'], description: 'Find a material and maintain its organisational views.' },
  { ourCode: 'PROD.MRP.SETTINGS', termType: 'TRANSACTION', module: 'PROD', title: 'Material planning settings', route: '/inventory/materials?view=MRP', tier: 'TIER_1_BUILT', conformance: 'B', description: 'Planning parameters and net-change file, not yet an executable planning run.' },
  { ourCode: 'CFG.ORG.COMPANYCODE.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'FND', title: 'Company code define', route: '/config/company-codes', tier: 'TIER_2_CONFIGURED', conformance: 'A', aliases: ['OX02'], description: 'The legal entity that keeps its own books, with its chart of accounts, fiscal year variant and posting period variant assigned.' },
  { ourCode: 'CFG.FIN.COA.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'Chart of Accounts definition', route: '/config/chart-of-accounts', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OB13'], description: 'Maintain tenant-local Charts of Accounts, language, account-number length, cost-element integration policy, the block flag, deactivate/reactivate lifecycle, and the separate Group CoA registry that feeds the Group CoA F4.' },
  { ourCode: 'CFG.FIN.COA.COPY', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'Copy Chart of Accounts', route: '/config/chart-of-accounts/copy', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OBY7'], description: 'Copy every G/L account of one active, unblocked chart of accounts into another inside the same tenant, in one transaction. Refused when the target chart is narrower than the source unless leading zeros are padded, when an Account Group the source uses is missing or deactivated in the target registry, when a copied number falls outside the range its group owns there, when a group account number is not defined in the target Group Chart of Accounts, and when an account already exists in the target unless overwrite is asked for — an account carrying postings, open items or a balance refuses the whole copy. The target account group field status matrix governs the copied values, a reason is always mandatory, and the audit trail is one summary document for the copy. Cross-tenant copies need a platform-admin service token and are not offered.' },
  { ourCode: 'CFG.FIN.FYV.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'Fiscal year variant definition', route: '/config/fiscal-year-variants', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OB29'], description: 'Define a fiscal year variant and maintain the period list behind it. The key is two upper-case characters and immutable once defined, the description is mandatory, and a variant either follows the calendar year — in which case its periods are derived from its own counts — or shifts the year boundary, in which case the period ends are maintained, per year when the variant is year dependent. A variant holds between one and sixteen ordinary periods and up to four periods for year-end adjustment; the ordinary ones come first. Only the end of a period is stored, as month, day and year shift, and the posting engine derives every start from the previous end, with period one following the last period of the previous fiscal year. A variant in use is retired rather than deleted, and retirement is refused while a Company Code or Controlling Area still points at it. Every write records one change document.' },
  { ourCode: 'CFG.FIN.GLACCOUNT.CREATE', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'G/L account master create', route: '/config/gl-accounts/new', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['FS00'], description: 'Create a G/L account in an active, unblocked chart of accounts. The account number is validated against the chart length and the account group range, stays immutable for the life of the account, and every other field takes its status from the account group field status matrix.' },
  { ourCode: 'CFG.FIN.GLACCOUNT.CHANGE', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'G/L account master change', route: '/config/gl-accounts/edit', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['FSP0'], description: 'Change a G/L account, its posting and creation blocks, the account group registry with its from/to ranges, and the per-field Suppress/Optional/Mandatory matrix. A reason is mandatory for a block change and for deletion, and deletion is refused while any balance, line item, open item or reconciliation assignment still uses the account.' },
  { ourCode: 'CFG.FIN.GLACCOUNT.DISPLAY', termType: 'CONFIG_ACTIVITY', module: 'FIN', title: 'G/L account master display', route: '/config/gl-accounts', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['FSS0'], description: 'Read G/L account master records, the account group registry and their change history. A blocked chart of accounts keeps its read-only display while refusing new accounts. Display mode itself is /config/gl-accounts/view; this hub route is the entry point that needs no selection.' },
  { ourCode: 'FIN.CLOSE.PERIOD', termType: 'TRANSACTION', module: 'FIN', title: 'Posting periods', route: '/config/posting-periods', tier: 'TIER_1_BUILT', conformance: 'A', aliases: ['OB52'], description: 'Which periods are open, per account type. Closing a period is recorded in the change log.' },
  { ourCode: 'CFG.ORG.PLANT.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'FND', title: 'Plant definition', route: '/config/plants', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OX10'], description: 'Production and storage sites; Company Code assignment and Storage Location definitions are separate activities.' },
  { ourCode: 'CFG.ORG.STORAGELOC.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'FND', title: 'Storage Location definitions', route: '/config/storage-locations', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OX09'], description: 'Create, change and deactivate Storage Locations within an active tenant Plant; negative-stock allowance is stored configuration only.' },
  { ourCode: 'CFG.ORG.SALESORG.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'SALES', title: 'Sales Organization definition', route: '/config/sales-orgs', tier: 'TIER_2_CONFIGURED', conformance: 'B', description: 'Create, change and soft-deactivate tenant Sales Organizations with retained history; Company Code assignment is separate in SCR-021. Exact on-prem GUI field parity with the reference product remains under review.' },
  { ourCode: 'CFG.ORG.SALESORG.ASSIGN_COMPANY', termType: 'CONFIG_ACTIVITY', module: 'SALES', title: 'Assign Sales Organization to Company Code', route: '/config/sales-orgs/assign-company', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OVX3'], description: 'Assign one active tenant Sales Organization to one active Company Code; reassignment is audited and unassignment is not included.' },
  { ourCode: 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL', termType: 'CONFIG_ACTIVITY', module: 'SALES', title: 'Assign Distribution Channel to Sales Organization', route: '/config/sales-orgs/assign-distribution-channel', tier: 'TIER_3_MAPPED', conformance: 'B', aliases: ['OVXK'], description: 'Maintain tenant-local Sales Organization and Distribution Channel pairs; duplicate assignment is an idempotent no-op and removal is blocked while any Sales Area uses the pair.' },
  { ourCode: 'CFG.ORG.DISTCHANNEL.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'SALES', title: 'Distribution Channel definitions', route: '/config/distribution-channels', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OVXI'], description: 'Maintain tenant-local Distribution Channels; Sales Organization assignments and Sales Area combinations are separate.' },
  { ourCode: 'CFG.ORG.DIVISION.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'SALES', title: 'Division definitions', route: '/config/divisions', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OVXB'], description: 'Maintain tenant-local Divisions; Sales Organization assignments and Sales Area combinations are separate.' },
  { ourCode: 'CFG.ORG.SALESORG.ASSIGN_DIVISION', termType: 'CONFIG_ACTIVITY', module: 'SALES', title: 'Assign Division to Sales Organization', route: '/config/sales-orgs/assign-division', tier: 'TIER_3_MAPPED', conformance: 'B', aliases: ['OVXA'], description: 'Maintain tenant-local many-to-many Sales Organization/Division pairs; duplicate assignment is a no-op and removal is audited but blocked while any Sales Area uses the pair across all channels.' },
  { ourCode: 'CFG.ORG.SALESAREA.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'SALES', title: 'Sales Area', route: '/config/sales-areas', tier: 'TIER_3_MAPPED', conformance: 'B', aliases: ['OVXG'], description: 'Maintain tenant-local Sales Area combinations; Distribution Channel and Division must be assigned to the selected Sales Organization through OVXK and OVXA.' },
  { ourCode: 'CFG.PROC.PURORG.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'PROC', title: 'Purchasing Organisation definitions', route: '/config/purchasing-orgs', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['OX08'], description: 'Define the tenant-local code and name, retain change history and deactivate; Company Code and Plant assignments remain separate, and supplier-purchasing use requires one Company Code.' },
  { ourCode: 'CFG.PROC.PURORG.ASSIGN_COMPANY', termType: 'CONFIG_ACTIVITY', module: 'PROC', title: 'Assign Purchasing Organisation to Company Code', route: '/config/purchasing-orgs/assign-company', tier: 'TIER_2_CONFIGURED', conformance: 'B', description: 'Make the initial assignment to exactly one active Company Code in the same tenant; replacement and unassignment are not included.' },
  { ourCode: 'CFG.PLT.CLIENT.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'PLT', title: 'Tenant administration', route: '/clients', tier: 'TIER_2_CONFIGURED', conformance: 'B', description: 'Create and manage tenants.' },
  { ourCode: 'CFG.PLT.CLIENT.ONBOARD', termType: 'CONFIG_ACTIVITY', module: 'PLT', title: 'Tenant onboarding wizard', route: '/clients/new', tier: 'TIER_2_CONFIGURED', conformance: 'B', description: 'Guided setup of a new tenant: structure, accounts, periods, ranges.' },
  { ourCode: 'CFG.WORKBENCH', termType: 'CONFIG_ACTIVITY', module: 'PLT', title: 'Configuration workbench', route: '/config', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['SPRO', 'IMG'], description: 'The define and assign tree that mirrors an implementation plan (R-06).' },
  { ourCode: 'FIN.JOURNAL.POST', termType: 'TRANSACTION', module: 'FIN', title: 'Post a journal entry', route: '/finance/journal/new', tier: 'TIER_1_BUILT', conformance: 'A', aliases: ['FB50', 'F-02'], description: 'Post a general ledger entry. Debits must equal credits. Fiscal year and period derive from the posting date.' },
  { ourCode: 'FIN.JOURNAL.DISPLAY', termType: 'TRANSACTION', module: 'FIN', title: 'Display an accounting document', route: '/finance/journal', tier: 'TIER_1_BUILT', conformance: 'A', aliases: ['FB03'], description: 'Line items, account assignments and the document flow.' },
  { ourCode: 'CFG.PLT.NUMBERRANGE.DEFINE', termType: 'CONFIG_ACTIVITY', module: 'PLT', title: 'Number range maintenance', route: '/config/number-ranges', tier: 'TIER_2_CONFIGURED', conformance: 'B', aliases: ['SNRO'], description: 'Gap-free document numbering per object, type and fiscal year.' },
  { ourCode: 'PLT.REGISTRY.SEARCH', termType: 'CONCEPT', module: 'PLT', title: 'Term registry search', route: '/registry', tier: 'TIER_1_BUILT', conformance: 'B', description: 'Find any screen, table, configuration activity or concept by our code or by a familiar alias.' },
  { ourCode: '', ourTable: 'journal_entry_line', termType: 'TABLE', module: 'FIN', title: 'Accounting document line', route: '/registry', tier: 'REFERENCE', description: 'Universal journal line: every account assignment on one row.' },
  { ourCode: '', ourTable: 'material', termType: 'TABLE', module: 'INV', title: 'Material master', route: '/inventory/materials', tier: 'REFERENCE', description: 'Basic and organisational material master views.' },
];

const MESSAGES: Array<{ code: string; severity: string; cls: string; text: string; remedy?: string }> = [
  { code: 'CAIRN_UNBALANCED', severity: 'ERROR', cls: 'POSTING', text: 'Accounting document {document} does not balance — debits {debit} vs credits {credit}.', remedy: 'Correct the amounts so total debits equal total credits.' },
  { code: 'CAIRN_POSTING_NOT_BALANCED', severity: 'ERROR', cls: 'POSTING', text: 'The document does not balance.', remedy: 'Correct the amounts so total debits equal total credits, then post again.' },
  { code: 'CAIRN_POSTING_ZERO_LINE', severity: 'ERROR', cls: 'POSTING', text: 'A line has a zero amount.', remedy: 'Remove the line or enter an amount.' },
  { code: 'CAIRN_POSTING_NEGATIVE_LINE', severity: 'ERROR', cls: 'POSTING', text: 'A line has a negative amount.', remedy: 'Enter a positive amount and set the debit or credit indicator.' },
  { code: 'CAIRN_POSTING_SINGLE_LINE', severity: 'ERROR', cls: 'POSTING', text: 'A document must have at least two line items.', remedy: 'Add the corresponding debit or credit.' },
  { code: 'CAIRN_POSTING_ALREADY_REVERSED', severity: 'ERROR', cls: 'POSTING', text: 'This document has already been reversed.', remedy: 'A document can only be reversed once. Post a corrective entry instead.' },
  { code: 'CAIRN_NUMBER_RANGE_MISSING', severity: 'ERROR', cls: 'NUMBERING', text: 'No number range is defined for {object}.', remedy: 'Maintain the range in Number Range Maintenance (CFG.PLT.NUMBERRANGE.DEFINE).' },
  { code: 'CAIRN_NUMBER_RANGE_EXHAUSTED', severity: 'ERROR', cls: 'NUMBERING', text: 'Number range for {object} is exhausted.', remedy: 'Extend the interval or define a new one in Number Range Maintenance (CFG.PLT.NUMBERRANGE.DEFINE).' },
  { code: 'CAIRN_LOCK_TIMEOUT', severity: 'ERROR', cls: 'LOCKING', text: 'Could not obtain a lock on {object} within {waited} ms.', remedy: 'Another user is changing the same object. Retry once they have finished.' },
  { code: 'CAIRN_TENANT_CREATED', severity: 'SUCCESS', cls: 'TENANCY', text: 'Tenant {client} created with {roles} roles and {ranges} number ranges.' },
  { code: 'CAIRN_CONFIG_INCOMPLETE', severity: 'ERROR', cls: 'CONFIGURATION', text: 'Configuration step {activity} has not been completed.', remedy: 'Complete it in the Configuration Workbench before continuing.' },
];

async function main() {
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn';
  const client = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });

  try {
    console.log('Seeding capabilities…');
    for (const c of CAPABILITIES) {
      await client.unsafe(
        `insert into capability (code, module, action, is_posting_relevant, description)
         values ($1,$2,$3,$4,$5)
         on conflict (code) do update set description = excluded.description`,
        [c.code, c.module, c.action, c.posting, c.description],
      );
    }

    console.log('Seeding configuration activities…');
    for (const [index, a] of ACTIVITIES.entries()) {
      await client.unsafe(
        `insert into config_activity
           (code, area, sub_area, title, activity_kind, prerequisites, enables,
            sequence, wizard_stage, route_path, is_config_only, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,'SEED')
         on conflict (code) do update set
           title = excluded.title,
           prerequisites = excluded.prerequisites,
           enables = excluded.enables,
           sequence = excluded.sequence,
           route_path = excluded.route_path,
           changed_by = 'SEED',
           changed_at = now()`,
        [
          a.code,
          a.area,
          a.subArea ?? null,
          a.title,
          a.kind,
          a.prerequisites.join(','),
          a.enables,
          (index + 1) * 10,
          a.wizardStage ?? 'STANDARD',
          a.route ?? null,
        ],
      );
    }

    // OB13 is newly actionable for existing tenants. Derive completion from an
    // existing Chart of Accounts while preserving any status on seed reapplication.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
      select c.client,
             'CFG.FIN.COA.DEFINE',
             case when exists (select 1 from chart_of_accounts coa where coa.client = c.client) then 'COMPLETED' else 'NOT_STARTED' end,
             (select max(coalesce(coa.changed_at, coa.created_at)) from chart_of_accounts coa where coa.client = c.client),
             case when exists (select 1 from chart_of_accounts coa where coa.client = c.client) then 'SEED' else null end,
             'SEED'
        from client c
      on conflict (client, activity_code) do nothing
    `);

    // Existing tenants predate this activity; add only a missing NOT_STARTED row.
    // ON CONFLICT DO NOTHING preserves any tenant progress on seed reapplication.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, created_by)
      select client, 'CFG.FIN.PAYMENTMETHOD.DEFINE', 'NOT_STARTED', 'SEED'
        from client
      on conflict (client, activity_code) do nothing
    `);
    // SCR-020 is newly actionable for existing tenants. Derive missing checklist
    // state from existing Sales Organization definitions rather than the old placeholder.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
      select c.client,
             'CFG.ORG.SALESORG.DEFINE',
             case when exists (select 1 from sales_org o where o.client = c.client) then 'COMPLETED' else 'NOT_STARTED' end,
             (select max(coalesce(o.changed_at, o.created_at)) from sales_org o where o.client = c.client),
             case when exists (select 1 from sales_org o where o.client = c.client) then 'SEED' else null end,
             'SEED'
        from client c
      on conflict (client, activity_code) do nothing
    `);

    // OVXB prerequisite: derive missing Division-definition checklist state for existing
    // tenants from their existing tenant-local definition rows.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
      select c.client,
             'CFG.ORG.DIVISION.DEFINE',
             case when exists (select 1 from division d where d.client = c.client) then 'COMPLETED' else 'NOT_STARTED' end,
             (select max(coalesce(d.changed_at, d.created_at)) from division d where d.client = c.client),
             case when exists (select 1 from division d where d.client = c.client) then 'SEED' else null end,
             'SEED'
        from client c
      on conflict (client, activity_code) do nothing
    `);

    // SCR-021 is newly actionable for existing tenants. Derive missing checklist state from
    // actual assignment rows: an organisation that already carries a Company Code has completed it.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
      select c.client,
             'CFG.ORG.SALESORG.ASSIGN_COMPANY',
             case when exists (select 1 from sales_org o where o.client = c.client and o.company_code is not null) then 'COMPLETED' else 'NOT_STARTED' end,
             (select max(coalesce(o.changed_at, o.created_at)) from sales_org o where o.client = c.client and o.company_code is not null),
             case when exists (select 1 from sales_org o where o.client = c.client and o.company_code is not null) then 'SEED' else null end,
             'SEED'
        from client c
      on conflict (client, activity_code) do nothing
    `);

    // OVXK is newly actionable for existing tenants. Backfill completion only
    // when a real Sales Organization/Distribution Channel pair already exists.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
      select c.client,
             'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL',
             case when exists (
               select 1 from sales_org_distribution_channel a where a.client = c.client
             ) then 'COMPLETED' else 'NOT_STARTED' end,
             (select max(a.created_at) from sales_org_distribution_channel a where a.client = c.client),
             case when exists (
               select 1 from sales_org_distribution_channel a where a.client = c.client
             ) then 'SEED' else null end,
             'SEED'
        from client c
      on conflict (client, activity_code) do nothing
    `);

    // OVXA is newly actionable for existing tenants. Derive assignment completion
    // only from an actual tenant-local Sales Organization/Division pair.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
      select c.client,
             'CFG.ORG.SALESORG.ASSIGN_DIVISION',
             case when exists (
               select 1 from sales_org_division a where a.client = c.client
             ) then 'COMPLETED' else 'NOT_STARTED' end,
             (select max(a.created_at) from sales_org_division a where a.client = c.client),
             case when exists (
               select 1 from sales_org_division a where a.client = c.client
             ) then 'SEED' else null end,
             'SEED'
        from client c
      on conflict (client, activity_code) do nothing
    `);

    // OVXG is newly actionable for existing tenants. Derive completion from
    // retained Sales Area rows without overwriting any in-progress checklist state.
    await client.unsafe(`
      insert into config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
      select c.client,
             'CFG.ORG.SALESAREA.DEFINE',
             case when exists (
               select 1 from sales_area a where a.client = c.client
             ) then 'COMPLETED' else 'NOT_STARTED' end,
             (select max(coalesce(a.changed_at, a.created_at)) from sales_area a where a.client = c.client),
             case when exists (
               select 1 from sales_area a where a.client = c.client
             ) then 'SEED' else null end,
             'SEED'
        from client c
      on conflict (client, activity_code) do nothing
    `);

    console.log('Seeding term registry…');
    // SCR-028 (FS00) replaced the read-only G/L account list with three maintenance
    // activities. Retire the legacy entry before the new ones claim its aliases:
    // term_alias is unique on (external_system, alias), so FS00 and FSP0 have to be
    // released first, and term_alias.term_id cascades so the aliases leave with it.
    // Migration 0037 does the same for a database that is migrated rather than reseeded.
    await client.unsafe(`
      delete from term_registry where our_code = 'FIN.GL.MASTER.LIST'
    `);
    await client.unsafe(`
      delete from capability
       where code = 'FIN.GL.MASTER.CREATE'
         and exists (select 1 from capability where code = 'CFG.FIN.GLACCOUNT.CREATE')
    `);
    // OX09 now identifies Storage Location maintenance, not the Plant definition screen.
    // Repair the prior shared-seed alias ownership before inserting the canonical entry below.
    await client.unsafe(`
      delete from term_alias a
       using term_registry t
       where a.term_id = t.id
         and a.external_system = 'REFERENCE_ERP'
         and a.alias = 'OX09'
         and t.our_code = 'CFG.ORG.PLANT.DEFINE'
    `);
    for (const r of REGISTRY) {
      const id = crypto.randomUUID();
      // ON CONFLICT must name the constraint that actually applies. A NULL our_code
      // never matches a unique index, so table entries need their own target.
      const isTableEntry = r.ourTable !== undefined;
      const conflictTarget = isTableEntry ? '(our_table)' : '(our_code)';

      await client.unsafe(
        `insert into term_registry
           (id, our_code, our_table, title, term_type, module, description, coverage_tier,
            route_path, conformance_tier, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SEED')
         on conflict ${conflictTarget} do update set
           title = excluded.title,
           description = excluded.description,
           route_path = excluded.route_path,
           coverage_tier = excluded.coverage_tier,
           changed_by = 'SEED',
           changed_at = now()`,
        [id, isTableEntry ? null : r.ourCode, r.ourTable ?? null, r.title, r.termType,
         r.module, r.description ?? null, r.tier, r.route, r.conformance ?? null],
      );

      for (const alias of r.aliases ?? []) {
        await client.unsafe(
          `insert into term_alias (id, term_id, external_system, alias, usage, created_by)
           select $1, t.id, 'REFERENCE_ERP', $2, 'SEARCH_ONLY', 'SEED'
           from term_registry t where t.our_code = $3
           on conflict (external_system, alias) do nothing`,
          [crypto.randomUUID(), alias, r.ourCode],
        );
      }
    }

    console.log('Seeding message catalogue…');
    for (const m of MESSAGES) {
      await client.unsafe(
        `insert into message_catalog (code, severity, message_class, text_en, i18n_key, remedy, created_by)
         values ($1,$2,$3,$4,$5,$6,'SEED')
         on conflict (code) do update set
           text_en = excluded.text_en,
           remedy = excluded.remedy`,
        [m.code, m.severity, m.cls, m.text, `msg.${m.code.toLowerCase()}`, m.remedy ?? null],
      );
    }

    const counts = await client.unsafe<Array<{ table_name: string }>>(`
      select 'capability' as table_name, count(*)::text as n from capability
      union all select 'config_activity', count(*)::text from config_activity
      union all select 'message_catalog', count(*)::text from message_catalog
      union all select 'term_registry', count(*)::text from term_registry
      union all select 'term_alias', count(*)::text from term_alias
    `);
    console.log('Seeded:', counts);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});

/** Pure browser-target selection. No database or browser is opened here. */
export const TARGETS = [
  { id: 'foundation', client: 'T998', label: 'Onboarding, numbering and journal regression' },
  { id: 'material-basic', client: 'T994', label: 'Material basic data only' },
  { id: 'material-purchasing', client: 'T995', label: 'Material purchasing only, with basic-data prerequisite' },
  { id: 'material-mrp', client: 'T996', label: 'Material planning settings only, with basic-data prerequisite' },
  { id: 'material-valuation', client: 'T997', label: 'Material valuation and price authorities only, with basic-data prerequisite' },
  { id: 'payment-terms', client: 'T993', label: 'Payment term maintenance and saved due-date preview' },
  { id: 'business-partners', client: 'T992', label: 'Partner identity, roles, bank summary/detail masking and audit' },
  { id: 'supplier-company', client: 'T991', label: 'Supplier company accounting, Payment Methods and financial authority' },
  { id: 'supplier-purchasing', client: 'T990', label: 'Supplier buying defaults, partner-function assignments and procurement authority' },
  { id: 'customer-company', client: 'T988', label: 'Customer company AR settings and financial authority' },
  { id: 'customer-sales-area', client: 'T987', label: 'Customer sales-area maintenance, persistence and history' },
  { id: 'company-code-definition', client: 'T986', label: 'Company Code definition capability gate and create-only form' },
  { id: 'controlling-area', client: 'T972', label: 'SCR-024 OKKP Controlling Area definition, F4, history and transaction lock' },
  { id: 'controlling-area-company-assignment', client: 'T970', label: 'SCR-025 OX19 assignment, compatibility, duplicate no-op, unassign history and dual-capability access' },
  { id: 'chart-of-accounts', client: 'T969', label: 'SCR-026 OB13 Chart of Accounts fields, F4, audit, account-length lock, block behavior, Group CoA registry and lifecycle' },
  { id: 'gl-accounts', client: 'T968', label: 'SCR-028 FS00 G/L account hub, moved registry aliases, Create and Display modes' },
  { id: 'chart-of-accounts-copy', client: 'T964', label: 'SCR-027 OBY7 chart of accounts copy, width refusals, one document for many accounts and idempotence' },
  { id: 'fiscal-year-variant-assignment', client: 'T965', label: 'SCR-030 OB37 fiscal year variant assignment, Controlling Area conflict, active-only choice and the stale-row guard' },
  { id: 'fiscal-year-variants', client: 'T966', label: 'SCR-029 OB29 fiscal year variant registry, derived and maintained period lists, retirement guards' },
  { id: 'posting-period-variants', client: 'T967', label: 'SCR-031 OBBO posting period variant registry, the interval set a variant is born with, deletion guards and audit' },
  { id: 'posting-period-variant-assignment', client: 'T963', label: 'SCR-033 OBBP posting period variant assignment, clearing before and after posting and the stale-row guard' },
  { id: 'exchange-rates', client: 'T962', label: 'SCR-034 OB08 exchange rate maintenance, duplicate-key refusal, ratio arithmetic and deletion' },
  { id: 'tax-codes', client: 'T961', label: 'SCR-035 FTXP tax code definition, duplicate-key refusal, guarded change, usage-blocked deletion' },
  { id: 'banks', client: 'T960', label: 'SCR-036 bank master maintenance, duplicate-key refusal, change, deletion, master left empty' },
  { id: 'house-banks', client: 'T959', label: 'SCR-037 FI12 house bank and account definition, structural deletion refusal, ordered deletion' },
  { id: 'document-types', client: 'T958', label: 'SCR-038 OBA7 document type definition over the delivered registry, lifecycle, in-use deletion refusal' },
  { id: 'tolerance-groups', client: 'T957', label: 'SCR-039 OBA4 employee tolerance group definition, blank scope and group keys, zero unlimited, no deletion offered' },
  { id: 'account-determination', client: 'T956', label: 'SCR-040 OBYC account determination master-detail, per-event modifiers, G/L redirect, deletion documented' },
  { id: 'cost-centers', client: 'T955', label: 'SCR-041 KS01 cost centre periods, assignment-judged company, overlap refusal, posting lock, deletion documented' },
  { id: 'cost-center-hierarchy', client: 'T954', label: 'SCR-042 KSH1/OKEON standard hierarchy and alternative groups, exclusive period placement, ranged leaves, unassign' },
  { id: 'activity-types', client: 'T953', label: 'SCR-043 KL01 activity type periods, unit on existence, digit vocabularies, canonical categories, posting lock, deletion' },
  { id: 'activity-rates', client: 'T952', label: 'SCR-044 KP26 activity rate matrix, per-period validity, documented deletion, master judges served' },
  { id: 'profit-centers', client: 'T951', label: 'SCR-045 KE51 profit centre periods, user-directory responsible, journal-guarded deletion, posting lock' },
  { id: 'profit-center-hierarchy', client: 'T950', label: 'SCR-047a KCH1/KCH5N standard hierarchy and alternative groups, exclusive period placement, ranged leaves, unassign' },
  { id: 'material-types', client: 'T949', label: 'SCR-048 OMS2 material types, range-judged creation, per-plant updating guard, used-type deletion refusal, deactivation' },
  { id: 'material-groups', client: 'T948', label: 'SCR-049 OMSF material groups, duplicate refusal, description change, used-group deletion refusal, deactivation' },
  { id: 'number-range-objects', client: 'T947', label: 'SCR-050 SNRO object registry, external interval creation, guarded current-number act' },
  { id: 'company-code-coa-assignment', client: 'T985', label: 'SCR-013 Company Code CoA assignment capability separation and active tenant-local choices' },
  { id: 'plant-definition', client: 'T984', label: 'SCR-014 Plant create/change, definition-only authority and read-only access' },
  { id: 'plant-company-code-assignment', client: 'T983', label: 'SCR-015 initial Plant Company Code assignment, separate capability, eligible choices and one-way lifecycle' },
  { id: 'storage-locations', client: 'T981', label: 'SCR-016 Storage Location create/change/deactivate, active Plant choices, history and display-only access' },
  { id: 'purchasing-orgs', client: 'T980', label: 'SCR-017 Purchasing Organisation create/change/deactivate, retained history and exact-capability access' },
  { id: 'purchasing-org-company-code', client: 'T979', label: 'SCR-018 initial Purchasing Organisation to Company Code assignment and exact-capability access' },
  { id: 'purchasing-groups', client: 'T978', label: 'SCR-019 Purchasing Group create/change/delete, standalone contacts, history and exact-capability access' },
  { id: 'sales-orgs', client: 'T977', label: 'SCR-020 Sales Organization create/change/deactivate, retained history, separate Company Code assignment and exact-capability access' },
  { id: 'sales-org-company-code', client: 'T976', label: 'SCR-021 OVX3 Sales Organization to Company Code F4 assignment, audited reassignment and exact-capability access' },
  { id: 'sales-org-division', client: 'T973', label: 'OVXA Sales Organization / Division assignment, active F4, idempotence, cross-channel removal guard, history and exact-capability access' },
  { id: 'distribution-channels', client: 'T975', label: 'SCR-022 OVXI Distribution Channel create/change/copy/deactivate and exact-capability access' },
  { id: 'divisions', client: 'T974', label: 'SCR-022 OVXB Division create/change/copy/deactivate and exact-capability access' },
  { id: 'payment-methods', client: 'T989', label: 'Payment Methods create/change/retire, history and display-only access' },
  { id: 'tenant-creation', client: 'T971', label: 'SCR-032 tenant creation: empty and standard paths, copy refused, names shared and a key refused' },
] as const;
export type BrowserTarget = typeof TARGETS[number];
export type BrowserTargetId = BrowserTarget['id'];
export const FIXTURE_NAME = 'Browser verification tenant';
/** Contract default deadline for one browser target (see browserRunTimeoutMs for the effective value). */
export const RUN_TIMEOUT_MS = 120_000;
/**
 * A timeout that may be raised — never lowered — through the environment.
 * Contract defaults stay authoritative for loopback runs; a reviewed run
 * against the higher-latency static remote test database (D-097) raises them
 * explicitly. Invalid or smaller values fall back to the contract default.
 */
export function browserTimeoutMs(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= fallback ? Math.floor(value) : fallback;
}

/** Effective per-target deadline (contract default RUN_TIMEOUT_MS). */
export function browserRunTimeoutMs(): number {
  return browserTimeoutMs('CAIRN_BROWSER_RUN_TIMEOUT_MS', RUN_TIMEOUT_MS);
}
/**
 * Targets approved by owner instruction (2026-10-13) to run browser acceptance
 * against the owner-supplied static test database (D-097) instead of a
 * per-batch disposable cluster. Entries are added only after review; every
 * other target keeps the disposable, loopback-only guard.
 */
export const STATIC_ACCEPTANCE_TARGETS = new Set<BrowserTargetId>([
  'purchasing-org-company-code',
  'purchasing-groups',
  'sales-orgs',
  'sales-org-company-code',
  'distribution-channels',
  'divisions',
]);
export type BrowserCommand = { mode: 'run'; target: BrowserTarget } | { mode: 'help' | 'list' };

export function parseBrowserCommand(args: string[]): BrowserCommand {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  if (args.length === 1 && args[0] === '--list') return { mode: 'list' };
  let name = 'foundation';
  if (args.length === 2 && args[0] === '--target') name = args[1];
  else if (args.length === 1 && args[0].startsWith('--target=')) name = args[0].slice('--target='.length);
  else if (args.length !== 0) throw new Error('Choose exactly one target with --target <name>. Use --list to see targets; combined runs are not supported.');
  const target = TARGETS.find((candidate) => candidate.id === name);
  if (!target) throw new Error(`Unknown browser target ${JSON.stringify(name)}. Use --list to see targets.`);
  return { mode: 'run', target };
}

/** A reserved key alone never authorises deleting a tenant. */
export function isOwnedFixture(target: BrowserTarget, tenant: { client: string; name: string; is_development: boolean }) {
  return tenant.client === target.client && tenant.name === FIXTURE_NAME && tenant.is_development === true;
}

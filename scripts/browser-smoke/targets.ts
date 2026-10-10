/** Pure browser-target selection. No database or browser is opened here. */
export const TARGETS = [
  { id: 'foundation', client: 'T998', label: 'Onboarding, numbering and journal regression' },
  { id: 'material-basic', client: 'T994', label: 'Material basic data only' },
  { id: 'material-purchasing', client: 'T995', label: 'Material purchasing only, with basic-data prerequisite' },
  { id: 'material-mrp', client: 'T996', label: 'Material planning settings only, with basic-data prerequisite' },
  { id: 'material-valuation', client: 'T997', label: 'Material valuation and price authorities only, with basic-data prerequisite' },
  { id: 'payment-terms', client: 'T993', label: 'Payment term maintenance and saved due-date preview' },
  { id: 'business-partners', client: 'T992', label: 'General partner identity, roles, blocking and audit' },
  { id: 'supplier-company', client: 'T991', label: 'Supplier company accounting and financial authority' },
  { id: 'supplier-purchasing', client: 'T990', label: 'Supplier buying defaults and procurement authority' },
] as const;
export type BrowserTarget = typeof TARGETS[number];
export type BrowserTargetId = BrowserTarget['id'];
export const FIXTURE_NAME = 'Browser verification tenant';
export const RUN_TIMEOUT_MS = 120_000;
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

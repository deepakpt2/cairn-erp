/**
 * The capability drop-down on the roles screen.
 *
 * A registered capability carries a description of up to a few thousand
 * characters. Rendering that inside an <option> makes the native list as wide
 * as its longest row, so the popup hangs off the screen and every row reads as
 * a wall of prose. The option therefore shows the code and its module/action
 * pair only; the full description is shown as a hint for the selected row,
 * where it can be read instead of clipped.
 */
import type { RoleAdminOverview } from '@/modules/platform/role-admin';

export type CapabilityOption = RoleAdminOverview['capabilities'][number];

/** Central authorities a tenant role may never be granted from this screen. */
export const WITHHELD_CAPABILITY_CODES = ['CFG.PLT.ROLE.MAINTAIN', 'CFG.PLT.USER.ROLE.MAINTAIN'] as const;

/** Keeps the native list no wider than the field it belongs to. */
export const MAX_OPTION_LABEL_LENGTH = 72;

/**
 * `CODE · MODULE/ACTION`. The code is unique, and the pair tells a reader what
 * kind of capability it is without dragging a paragraph into the list.
 */
export function capabilityOptionLabel(capability: Pick<CapabilityOption, 'code' | 'module' | 'action'>): string {
  return `${capability.code} · ${capability.module}/${capability.action}`;
}

/**
 * Capabilities a role can still be granted: not already held, not a central
 * authority, and matching the reader's search text anywhere it makes sense —
 * including the long description, which is how a capability is usually looked
 * up even though it is not shown in the list.
 */
export function assignableCapabilitiesFor(
  heldCapabilities: readonly string[],
  capabilities: readonly CapabilityOption[],
  query: string,
): CapabilityOption[] {
  const needle = query.trim().toLowerCase();
  return capabilities.filter(
    (capability) =>
      !heldCapabilities.includes(capability.code) &&
      !WITHHELD_CAPABILITY_CODES.includes(capability.code as (typeof WITHHELD_CAPABILITY_CODES)[number]) &&
      (!needle ||
        `${capability.code} ${capability.module}/${capability.action} ${capability.module} ${capability.action} ${capability.description ?? ''}`
          .toLowerCase()
          .includes(needle)),
  );
}

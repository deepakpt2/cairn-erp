/**
 * The capability drop-down on /platform/roles.
 *
 * Registered capability descriptions run to well over a thousand characters.
 * Putting one inside an <option> makes the native list as wide as its longest
 * row, so the popup hangs off the screen and every row reads as clipped prose.
 * These contracts pin the shape that keeps the list usable: a short label, a
 * solid field surface, a search that is local to the role, and the same field
 * name the grant action still expects.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_OPTION_LABEL_LENGTH,
  WITHHELD_CAPABILITY_CODES,
  assignableCapabilitiesFor,
  capabilityOptionLabel,
  type CapabilityOption,
} from '../src/app/platform/roles/capability-option';

const SOURCE = readFileSync(new URL('../src/app/platform/roles/RoleManager.tsx', import.meta.url), 'utf8');

function capability(overrides: Partial<CapabilityOption> = {}): CapabilityOption {
  return {
    code: 'CFG.FIN.COA.DEFINE',
    module: 'CFG',
    action: 'DEFINE',
    isPostingRelevant: false,
    description: 'Define the chart of accounts: G/L account master records, account groups and their number ranges.',
    ...overrides,
  };
}

const CATALOGUE: CapabilityOption[] = [
  capability(),
  capability({ code: 'FIN.JOURNAL.POST', module: 'FIN', action: 'POST', isPostingRelevant: true, description: 'Post a journal entry with balanced debits and credits; documents cannot be deleted, only reversed.' }),
  capability({ code: 'FIN.JOURNAL.PARK', module: 'FIN', action: 'PARK', description: 'Park a journal entry for later posting.' }),
  capability({ code: 'CFG.PLT.ROLE.MAINTAIN', module: 'PLT', action: 'CONFIGURE', description: 'Create and maintain tenant roles.' }),
  capability({ code: 'CFG.PLT.USER.ROLE.MAINTAIN', module: 'PLT', action: 'CONFIGURE', description: 'Assign or revoke ordinary tenant roles.' }),
  capability({ code: 'AUDIT.WORKSPACE', module: 'AUDIT', action: 'DISPLAY', description: null }),
];

describe('the capability option label', () => {
  it('names the code and its module/action pair', () => {
    expect(capabilityOptionLabel(capability())).toBe('CFG.FIN.COA.DEFINE · CFG/DEFINE');
  });

  it('stays short enough for the list to keep the width of the field', () => {
    const longest = capabilityOptionLabel(
      capability({ code: 'PROD.ORDER.AVAILABILITY.COMMIT', module: 'PROD', action: 'COMMIT' }),
    );
    expect(longest.length).toBeLessThanOrEqual(MAX_OPTION_LABEL_LENGTH);
  });

  it('never drags the description into the list, however long the description is', () => {
    // The real catalogue carries descriptions of more than 1,500 characters;
    // this is the defect that made the drop-down unreadable.
    const enormous = 'x'.repeat(1561);
    const label = capabilityOptionLabel(capability({ description: enormous }));
    expect(label).not.toContain(enormous);
    expect(label.length).toBeLessThan(80);
  });

  it('reads the same for a capability with no description at all', () => {
    expect(capabilityOptionLabel(capability({ description: null }))).toBe('CFG.FIN.COA.DEFINE · CFG/DEFINE');
  });
});

describe('what a role may still be granted', () => {
  it('offers everything when nothing is held and nothing is searched', () => {
    const offered = assignableCapabilitiesFor([], CATALOGUE, '');
    expect(offered.map((cap) => cap.code)).toEqual([
      'CFG.FIN.COA.DEFINE',
      'FIN.JOURNAL.POST',
      'FIN.JOURNAL.PARK',
      'AUDIT.WORKSPACE',
    ]);
  });

  it('withholds the two central authorities even when they are not held', () => {
    const offered = assignableCapabilitiesFor([], CATALOGUE, '');
    for (const code of WITHHELD_CAPABILITY_CODES) {
      expect(offered.map((cap) => cap.code)).not.toContain(code);
    }
  });

  it('never offers a capability the role already holds', () => {
    const offered = assignableCapabilitiesFor(['FIN.JOURNAL.POST'], CATALOGUE, '');
    expect(offered.map((cap) => cap.code)).not.toContain('FIN.JOURNAL.POST');
    expect(offered).toHaveLength(3);
  });

  it('searches the description, which is how a capability is usually looked up', () => {
    const offered = assignableCapabilitiesFor([], CATALOGUE, 'for later posting');
    expect(offered.map((cap) => cap.code)).toEqual(['FIN.JOURNAL.PARK']);
  });

  it('searches without regard to case or surrounding space', () => {
    expect(assignableCapabilitiesFor([], CATALOGUE, '  fin.journal  ').map((cap) => cap.code)).toEqual([
      'FIN.JOURNAL.POST',
      'FIN.JOURNAL.PARK',
    ]);
  });

  it('finds a capability by the module/action pair the label shows', () => {
    expect(assignableCapabilitiesFor([], CATALOGUE, 'fin/post').map((cap) => cap.code)).toEqual(['FIN.JOURNAL.POST']);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(assignableCapabilitiesFor([], CATALOGUE, 'no such capability')).toEqual([]);
  });
});

describe('the field the reader sees', () => {
  it('builds its options from the helper, not from the raw description', () => {
    expect(SOURCE).toContain('capabilityOptionLabel(cap)');
    expect(SOURCE).not.toContain('{cap.description ?? cap.action}');
  });

  it('uses the house field style, so the text sits on a solid surface', () => {
    const select = /name="capabilityCode"[\s\S]*?className="([^"]*)"/.exec(SOURCE)?.[1] ?? '';
    expect(select).toContain('field-input');
    expect(select).not.toContain('bg-transparent');
  });

  it('spans the panel instead of one column of a two-column grid', () => {
    expect(SOURCE).not.toContain('md:grid-cols-2"><input type="hidden" name="roleCode"');
  });

  it('searches the whole catalogue for that role, not the catalogue filter at the foot of the page', () => {
    // Typing in "Filter capabilities" used to empty every grant list.
    expect(SOURCE).toContain('capabilities={overview.capabilities}');
    expect(SOURCE).not.toContain('visibleCapabilities.filter((cap) => !role.capabilities');
  });

  it('shows the description of the selected capability where it can be read', () => {
    expect(SOURCE).toContain('chosen.description ??');
  });

  it('still submits the field the grant action expects', () => {
    expect(SOURCE).toContain('name="capabilityCode"');
    expect(SOURCE).toContain('action={grantCapabilityAction}');
    const select = /<select[^>]*name="capabilityCode"[^>]*>/.exec(SOURCE)?.[0] ?? '';
    expect(select).toContain('required');
  });
});

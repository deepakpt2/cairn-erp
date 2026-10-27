import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The identifier boundary pass 31 moved two screens off, and what keeps that move safe.
 *
 * A DOM identifier here has two consumers at once: the accessibility tree the operator's screen
 * reader walks, and a selector the browser harness clicks. Renaming one side and not the other is
 * exactly how a screen stays green in vitest and fails an acceptance run days later — which is
 * why `source-keyword-hygiene` still inventories 18 identifiers rather than having renamed them
 * blind. So the pairing is asserted for both screens, against the harness file as well as the
 * component; and the SAP vocabulary these screens still legitimately own — the registry alias a
 * consultant searches by, and the transaction the change lock names — is asserted to be present,
 * because the rename was meant to reach identifiers only.
 */
const ALLOCATION_FORM = 'src/app/config/batch-search-allocations/AllocationForm.tsx';
const ASSIGNMENT_UI = 'src/app/config/controlling-area/ControllingAreaCompanyAssignmentUI.tsx';
const ASSIGNMENT_HARNESS = 'scripts/browser-smoke/ox19-assignment.ts';
const SEED = 'scripts/seed.ts';

const read = (path: string) => readFileSync(path, 'utf8');

function values(source: string, attribute: string): string[] {
  return [...source.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, 'g'))].map((match) => match[1]);
}

describe('identifier wiring on the two screens that left the transaction-code vocabulary', () => {
  it('keeps every datalist reachable from the input that names it, and orphans none', () => {
    const form = read(ALLOCATION_FORM);
    const lists = values(form, 'list');
    const datalists = [...form.matchAll(/<datalist id="([^"]+)"/g)].map((match) => match[1]);
    expect(lists.length).toBeGreaterThanOrEqual(3); // movement type, search procedure, transfer procedure
    for (const list of lists) expect(datalists).toContain(list);
    for (const datalist of datalists) expect(lists).toContain(datalist);
  });

  it('keeps every aria reference on the assignment screen resolved in its own file', () => {
    const ui = read(ASSIGNMENT_UI);
    const ids = values(ui, 'id');
    for (const value of [...values(ui, 'aria-labelledby'), ...values(ui, 'aria-describedby')]) {
      expect(ids, value).toContain(value);
    }
  });

  it('moves the harness selector with the identifier it reads', () => {
    const ui = read(ASSIGNMENT_UI);
    const selectors = [...read(ASSIGNMENT_HARNESS).matchAll(/section\[aria-labelledby="([^"]+)"\]/g)]
      .map((match) => match[1]);
    expect(selectors).toHaveLength(1);
    for (const value of selectors) expect(values(ui, 'id'), value).toContain(value);
    // The screen still exposes the pair once, so the harness cannot be pointing at a stale twin.
    expect(ui.match(/aria-labelledby="([^"]+)"/g) ?? []).toHaveLength(2);
  });

  it('leaves no registered transaction code in the identifiers of either screen', () => {
    const aliases = new Set<string>();
    for (const block of read(SEED).matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
      for (const alias of block[1].matchAll(/'([^']+)'/g)) aliases.add(alias[1]);
    }
    expect(aliases.size).toBeGreaterThan(200);
    for (const path of [ALLOCATION_FORM, ASSIGNMENT_UI]) {
      const source = read(path);
      const coded = [...values(source, 'id'), ...values(source, 'name'), ...values(source, 'htmlFor')]
        .filter((value) => [...aliases].some((alias) =>
          new RegExp(`(^|[^A-Za-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(value),
        ));
      expect(coded, path).toEqual([]);
    }
  });

  it('keeps the SAP context the screens exist to carry: the registry alias and the lock label', () => {
    const seed = read(SEED);
    expect(seed).toContain("aliases: ['OX19']");
    expect(seed).toContain("aliases: ['OMCG']");
    // The change lock still records the transaction it was opened from, so a blocked operator is
    // still told which activity holds the record — pass 29's recovery line reads that field.
    expect(read(ALLOCATION_FORM)).toContain("useChangeLock('BATCH_SEARCH_ALLOCATION', editing?.movementType ?? null, 'OMCG'");
  });
});

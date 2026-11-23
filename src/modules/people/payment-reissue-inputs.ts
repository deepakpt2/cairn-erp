/**
 * Normalized identity of a reissue PREVIEW/REQUEST. Shared by the service (which computes the signature it
 * returns) and the screen (which compares it before submitting), so the two cannot drift.
 *
 * In `ALL` mode the employee set is server-derived from the source file, so it is deliberately NOT part of the
 * signature: the screen does not know it before previewing, and an empty client-side selection is correct. In
 * `SELECTED` mode the explicit, order-independent employee set is bound. Source, mode and date are always bound.
 */
export interface ReissueInputs {
  source: string;
  selection: 'ALL' | 'SELECTED';
  selected: readonly string[];
  date: string;
}

export function reissueInputSignature(inputs: ReissueInputs): string {
  const employees = inputs.selection === 'ALL' ? [] : [...new Set(inputs.selected.map((n) => n.trim().toUpperCase()).filter(Boolean))].sort();
  return JSON.stringify({ v: 1, source: inputs.source, selection: inputs.selection, selected: employees, date: inputs.date });
}

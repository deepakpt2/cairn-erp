/** Browser-safe defaults: persisted null is intentionally unset, not a new-record default. */
export function materialFormValue(initial: Record<string, string | number | boolean | null | undefined>, name: string, fallback = '') {
  const current = initial[name];
  return current === undefined ? fallback : current === null ? '' : String(current);
}

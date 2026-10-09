/** Pure, browser-safe presentation — no DB or server imports. D-030. */
export function formatNumber(input: {
  value: number;
  prefix?: string | null;
  length?: number;
  style?: string;
  fiscalYear?: number | null;
}): string {
  const padded = String(input.value).padStart(input.length ?? 6, '0');
  if (input.style === 'CLASSIC') return padded;
  const parts: string[] = [];
  if (input.prefix) parts.push(input.prefix);
  if (input.fiscalYear) parts.push(String(input.fiscalYear));
  parts.push(padded);
  return parts.join('-');
}

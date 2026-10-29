/**
 * The sentence the assignments screen says when an open span is ended.
 *
 * It lives beside the screen rather than inside the action because two files have to say it in the same words.
 * Every other write on this screen returns its notice inside the panel the operator was standing in; ending an
 * assignment is the one case where that panel is the panel the write removes — with no open span left there is
 * no "standing today" block to render, and the notice disappears with it, leaving a list that has quietly
 * changed. So the action redirects with the two dates and the page reads the sentence from here and puts it
 * above the history. Shared, so the confirmation and the notice cannot drift apart.
 */
export function endedAssignmentMessage(validFrom: string, validTo: string): string {
  return (
    `Assignment from ${validFrom} now runs to ${validTo} inclusive. `
    + 'The next one may start on the day after it.'
  );
}

/** A query parameter that may be echoed back on the screen: a plain date, nothing else. */
export function dateParam(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

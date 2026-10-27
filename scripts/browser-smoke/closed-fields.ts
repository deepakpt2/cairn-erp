/**
 * Driving a closed constrained field from a browser target.
 *
 * `ConstrainedField` renders one of two controls, and which one it is comes from
 * `CLOSED_KINDS` in `src/modules/foundation/constrained-kinds.ts`: a kind with a short enumerable list
 * becomes a `<select>`, and an open kind becomes a combobox `<input>` with a suggestion list. A target
 * that types into a `<select>` does not fail loudly — it waits for an `<input>` that will never appear
 * and dies on a locator timeout, which reads like a broken screen and is really a stale target.
 *
 * The options of a closed field are also fetched on the client, and for a dependent kind (a storage
 * location follows the plant of the same row) they only exist after the field above has been answered.
 * So the option is waited for before it is chosen, rather than assumed.
 */
import type { Locator, Page } from '@playwright/test';

type Scope = Locator | Page;

/** Choose one value in a closed constrained field, waiting for the option the context unlocks. */
export async function chooseClosed(scope: Scope, name: string, value: string): Promise<void> {
  const field = scope.locator(`select[name="${name}"]`);
  await field.waitFor();
  // An <option> is never "visible" on its own, so the wait is for attachment. Without this the
  // target times out on a select that is standing right there with the option in it.
  await field.locator(`option[value="${value}"]`).waitFor({ state: 'attached' });
  await field.selectOption(value);
}

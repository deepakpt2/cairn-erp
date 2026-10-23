'use server';

/**
 * Command bar action — CAIRN.md §19.1, §4.4
 *
 * Type a code and press Enter. An exact custom code or table name opens that
 * term. Anything else uses the registry ranking: tcode, then our code, then
 * name, then explanation, exact words before a nearest spelling. Enter opens
 * that screen when the top hit has a route. A nearest hit that ties with
 * another does not open: the registry shows the list so the choice is visible.
 */
import { redirect } from 'next/navigation';
import { resolveTerm } from '@/platform/registry';

export async function executeCommand(formData: FormData): Promise<void> {
  const term = String(formData.get('term') ?? '').trim();
  if (term === '') {
    redirect('/');
  }

  const hit = await resolveTerm(term);

  if (hit?.routePath && (hit.matchKind !== 'NEAREST' || hit.matchUnique !== false)) {
    redirect(hit.routePath);
  }

  const miss = hit ? '' : '&miss=1';
  redirect(`/registry?q=${encodeURIComponent(term)}${miss}`);
}

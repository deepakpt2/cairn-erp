'use server';

/**
 * Command bar action — CAIRN.md §19.1, §4.4
 *
 * The single most familiar behaviour we keep: type a code, press Enter, go there.
 * Resolution order is our own codes first, then registry aliases, then a title
 * search — and if nothing matches, land on the registry with the term pre-filled
 * rather than silently doing nothing.
 */
import { redirect } from 'next/navigation';
import { resolveTerm } from '@/platform/registry';

export async function executeCommand(formData: FormData): Promise<void> {
  const term = String(formData.get('term') ?? '').trim();
  if (term === '') {
    redirect('/');
  }

  const hit = await resolveTerm(term);

  if (hit?.routePath) {
    redirect(hit.routePath);
  }

  // Nothing matched — show the search rather than failing silently.
  redirect(`/registry?q=${encodeURIComponent(term)}&miss=1`);
}

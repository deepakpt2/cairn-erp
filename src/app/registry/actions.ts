'use server';

/**
 * Suggestions for the term registry search.
 * The catalogue is the same global lookup the registry page already reads.
 * The query writes nothing, and it does not require a tenant.
 */
import { suggestRegistry } from '@/platform/registry';

export async function suggestRegistryTerms(query: string) {
  if (typeof query !== 'string') return [];
  return suggestRegistry(query, 8);
}

/**
 * Command bar resolution check — CAIRN.md §4.4.
 * Verifies that our own codes win, familiar aliases resolve, and unknown input
 * falls through to the registry search rather than failing silently.
 */
import { resolveTerm } from '../src/platform/registry';
import { closeDb } from '../src/platform/db/client';

async function main() {
  const probes = [
    'FIN.JOURNAL.POST',
    'FB50',
    'spro',
    'number range',
    'journal_entry_line',
    'MD04',
    'zzz-nothing',
  ];
  for (const probe of probes) {
    const hit = await resolveTerm(probe);
    if (hit) {
      console.log(
        `"${probe}" -> ${hit.ourCode ?? hit.ourTable}  [${hit.matchedOn}]  ` +
          `${hit.title}  -> ${hit.routePath ?? 'no route'}  (${hit.coverageTier})`,
      );
    } else {
      console.log(`"${probe}" -> no match (falls through to registry search)`);
    }
  }
  await closeDb();
}
main();

import Link from 'next/link';

import { listBatchClasses } from '@/modules/inventory/batch-class';
import { listConversionChecks } from '@/modules/inventory/batch-conversion';
import { listSortSequences } from '@/modules/inventory/batch-sort-sequence';

/**
 * Readers for settings that already stand. Nothing here assigns a class,
 * applies a sort, or changes a batch level.
 */
export default async function BatchRelations({ client }: { client: string }) {
  const [classes, sorts, conversion] = await Promise.all([
    listBatchClasses(client),
    listSortSequences(client),
    listConversionChecks(client),
  ]);
  const latest = conversion.checks[0] ?? null;
  const classNames = classes.classes.map((row) => `${row.classType} ${row.className}`);
  const released = sorts.sequences.filter((row) => row.status === '1').map((row) => row.sortSequence);

  return (
    <section className="border border-line bg-white p-3 text-sm">
      <h2 className="font-medium">Related batch settings</h2>
      <p className="mt-2">
        {classNames.length > 0
          ? `Batch classes stand: ${classNames.join(', ')}. None is assigned to this batch.`
          : 'No batch class stands. No class is assigned to this batch.'}
        {' '}
        <Link href="/inventory/batch-classes" className="underline">BMC1</Link>
      </p>
      <p className="mt-2">
        {released.length > 0
          ? `Released sort sequences stand: ${released.join(', ')}. They are not applied.`
          : 'No released sort sequence stands. A sort is not applied.'}
        {' '}
        <Link href="/inventory/batch-sort-sequences" className="underline">CU70</Link>
      </p>
      <p className="mt-2">
        {latest
          ? `The last OMCT finding is ${latest.result}. ${latest.summary} The batch level was not changed.`
          : 'No OMCT finding stands. The batch level was not changed.'}
        {' '}
        <Link href="/config/batch-conversion" className="underline">OMCT</Link>
      </p>
    </section>
  );
}

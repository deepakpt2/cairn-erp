import { documentManagementActive } from '@/modules/inventory/batch-document-management';

/** The batch-master documents tab. Visible only when ODOC stored X. It does not link a document. */
export default async function DocumentTab({ client }: { client: string }) {
  const active = await documentManagementActive(client);
  if (!active) return null;
  return (
    <section className="space-y-2 border border-line bg-white p-4 text-sm">
      <h2 className="font-semibold">Documents</h2>
      <p>
        Document management is active. This tab is visible because ODOC stored X.
        No document info record stands. This screen does not create one, upload a file, or store a link.
      </p>
      <p className="text-ink-soft">
        CV01N is not this tab. Deactivating ODOC hides the tab. A batch, a document, and a link are not deleted by that deactivation.
        MB56, MB57, and MB5C are not this tab.
      </p>
    </section>
  );
}

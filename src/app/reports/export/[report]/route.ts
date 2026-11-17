import { can, requireSession } from '@/platform/auth/current';
import { ReportExportError } from '@/modules/output/report-export';
import { reportAdapter, renderReport } from '@/modules/output/report-registry';

/**
 * `/reports/export/<report>?format=csv|pdf&<the screen's own query string>`.
 *
 * Read-only: the adapter calls the same service the screen calls, with the same selection, so the file
 * is what the user saw. Authority is the screen's capability; a service refusal comes back as a 400
 * carrying the service's own message and remedy.
 */
export async function GET(request: Request, context: { params: Promise<{ report: string }> }) {
  const { report } = await context.params;
  const adapter = reportAdapter(report);
  if (!adapter) return new Response('Unknown report.', { status: 404 });
  const session = await requireSession(adapter.route);
  if (!can(session, adapter.capability)) {
    return new Response(`You do not hold ${adapter.capability}, which this report needs.`, { status: 403 });
  }
  const query = new URL(request.url).searchParams;
  const format = query.get('format') === 'pdf' ? 'pdf' : 'csv';
  try {
    const doc = await adapter.build(session.user.client, query);
    const out = await renderReport(doc, format, new Date().toISOString().slice(0, 16).replace('T', ' '));
    return new Response(out.body as BodyInit, {
      headers: {
        'content-type': out.contentType,
        'content-disposition': `attachment; filename="${out.fileName}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ReportExportError || (error instanceof Error && 'remedy' in error)) {
      const remedy = (error as { remedy?: string }).remedy;
      return new Response(remedy ? `${error.message} ${remedy}` : error.message, { status: 400 });
    }
    throw error;
  }
}

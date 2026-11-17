/**
 * "Export CSV" and "Export PDF" for a report screen. Plain links: the export route reads the same query
 * string the screen was opened with, so the file is the selection on screen.
 */
export function ReportExport({ report, params }: { report: string; params: Record<string, string | string[] | undefined> }) {
  const query = (format: 'csv' | 'pdf') => {
    const q = new URLSearchParams();
    for (const [key, raw] of Object.entries(params)) {
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value !== undefined && value !== '') q.set(key, value);
    }
    q.set('format', format);
    return `/reports/export/${report}?${q.toString()}`;
  };
  return (
    <span data-print-hide className="inline-flex flex-wrap items-center gap-2">
      <a href={query('csv')} className="btn btn-default min-h-9" download>Export CSV</a>
      <a href={query('pdf')} className="btn btn-default min-h-9" download>Export PDF</a>
    </span>
  );
}

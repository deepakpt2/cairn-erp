import Link from 'next/link';

import { requireSession } from '@/platform/auth/current';
import {
  type RegisterFilter, type RegisterKind, REGISTER_KINDS, REGISTER_KIND_MEANING,
  REGISTER_LIMIT, listDocumentRegister, listDueRegister, listRegisterChoices,
} from '@/modules/sales/registers';

export const dynamic = 'force-dynamic';

const ROUTE = '/sales/documents';
const CAPABILITY = 'SALES.DOCUMENTS.LIST';

const KINDS_WITH_A_DUE_LIST = ['DELIVERY', 'BILLING'];

const asKind = (value: string | undefined): RegisterKind => (
  (REGISTER_KINDS as readonly string[]).includes(value ?? '') ? value as RegisterKind : 'ORDER'
);

const one = (value: string | string[] | undefined): string => (
  Array.isArray(value) ? value[0] ?? '' : value ?? ''
);

/**
 * The sales registers — SAP's VA05, VL06 and VF05.
 *
 * A document screen answers "show me this document". A register answers "show me the documents":
 * what stands, what it is worth, and what is still to do. It is filtered by what the business asks
 * about rather than by what the primary key happens to be, and it says plainly where its read was
 * cut, because a register that silently shows two hundred of four thousand rows is a report you
 * cannot trust.
 *
 * The two due lists are read here as well, through the same services the delivery and the billing
 * screens use and under the same filter, so what a planner sees is what the act will do.
 */
export default async function SalesDocumentsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;

  const kind = asKind(one(params.kind));
  const mode = one(params.mode) === 'due' && KINDS_WITH_A_DUE_LIST.includes(kind) ? 'due' : 'standing';
  const filter: RegisterFilter = {
    documentNumber: one(params.documentNumber),
    orderNumber: one(params.orderNumber),
    deliveryNumber: one(params.deliveryNumber),
    customerNumber: one(params.customerNumber),
    materialNumber: one(params.materialNumber),
    salesOrg: one(params.salesOrg),
    plant: one(params.plant),
    documentType: one(params.documentType),
    status: one(params.status),
    dateFrom: one(params.dateFrom),
    dateTo: one(params.dateTo),
  };

  const choices = await listRegisterChoices(client);
  const due = mode === 'due' && KINDS_WITH_A_DUE_LIST.includes(kind)
    ? await listDueRegister(client, { kind: kind as 'DELIVERY' | 'BILLING', filter })
    : null;
  const register = due ? null : await listDocumentRegister(client, { kind, filter });

  const query = (next: Record<string, string>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ kind, mode, ...filter, ...next })) {
      if (value) search.set(key, value);
    }
    return `${ROUTE}?${search.toString()}`;
  };

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CAPABILITY} · SD</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Sales documents</h1>
          <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          What stands, and what is still to do. Choose a register, narrow it by what the business
          asks about, and read the totals at the foot — they are the totals of what the register
          answered, not of the whole of the table. The delivery and billing due lists are read
          through the same services the delivery and the billing screens use, under the same filter,
          so what is listed here is what the act will do.
        </p>
      </header>

      <nav aria-label="Register" className="flex flex-wrap gap-2">
        {REGISTER_KINDS.map((candidate) => (
          <Link
            key={candidate}
            href={query({ kind: candidate, mode: 'standing' })}
            className={`btn min-h-11 sm:min-h-8 ${candidate === kind ? 'btn-primary' : 'btn-default'}`}
          >
            {candidate === 'ORDER' ? 'Orders'
              : candidate === 'DELIVERY' ? 'Deliveries'
                : candidate === 'BILLING' ? 'Billing'
                  : candidate === 'RETURNS' ? 'Returns' : 'Cancellations'}
          </Link>
        ))}
      </nav>

      {KINDS_WITH_A_DUE_LIST.includes(kind) && (
        <nav aria-label="What the register reads" className="flex flex-wrap gap-2">
          <Link
            href={query({ mode: 'standing' })}
            className={`btn min-h-11 sm:min-h-8 ${mode === 'standing' ? 'btn-primary' : 'btn-default'}`}
          >
            What stands
          </Link>
          <Link
            href={query({ mode: 'due' })}
            className={`btn min-h-11 sm:min-h-8 ${mode === 'due' ? 'btn-primary' : 'btn-default'}`}
          >
            {kind === 'DELIVERY' ? 'What is due to deliver' : 'What is due to bill'}
          </Link>
        </nav>
      )}

      <form method="get" action={ROUTE} className="border border-line bg-surface p-4">
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="mode" value={mode} />
        <h2 className="text-sm font-semibold">Narrow it</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Document</span>
            <input name="documentNumber" defaultValue={filter.documentNumber} className="field-input code" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Customer</span>
            <select name="customerNumber" defaultValue={filter.customerNumber} className="field-input">
              <option value="">Any customer</option>
              {choices.customers.map((row) => (
                <option key={row.partnerNumber} value={row.partnerNumber}>
                  {row.partnerNumber}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Material</span>
            <select name="materialNumber" defaultValue={filter.materialNumber} className="field-input">
              <option value="">Any material</option>
              {choices.materials.map((row) => (
                <option key={row.materialNumber} value={row.materialNumber}>
                  {row.materialNumber}{row.description ? ` · ${row.description}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Sales organisation</span>
            <select name="salesOrg" defaultValue={filter.salesOrg} className="field-input">
              <option value="">Any sales organisation</option>
              {choices.salesOrgs.map((row) => (
                <option key={row.salesOrg} value={row.salesOrg}>
                  {row.salesOrg}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Plant</span>
            <select name="plant" defaultValue={filter.plant} className="field-input">
              <option value="">Any plant</option>
              {choices.plants.map((row) => (
                <option key={row.plant} value={row.plant}>
                  {row.plant}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Document type</span>
            <select name="documentType" defaultValue={filter.documentType} className="field-input">
              <option value="">Any type</option>
              {choices.documentTypes.map((row) => (
                <option key={row.documentType} value={row.documentType}>
                  {row.documentType}{row.name ? ` · ${row.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Status</span>
            <select name="status" defaultValue={filter.status} className="field-input">
              <option value="">Any status</option>
              {choices.statuses.map((row) => (
                <option key={row} value={row}>{row}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">From</span>
              <input type="date" name="dateFrom" defaultValue={filter.dateFrom} className="field-input" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">To</span>
              <input type="date" name="dateTo" defaultValue={filter.dateTo} className="field-input" />
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Read the register</button>
          <Link href={`${ROUTE}?kind=${kind}`} className="btn btn-default min-h-11 sm:min-h-8">
            Clear the filter
          </Link>
        </div>
      </form>

      <section aria-labelledby="register" className="border border-line bg-surface p-4">
        <h2 id="register" className="text-sm font-semibold">
          {mode === 'due'
            ? (kind === 'DELIVERY' ? 'What is due to deliver' : 'What is due to bill')
            : REGISTER_KIND_MEANING[kind]}
        </h2>

        {due ? (
          due.rows.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">
              Nothing is due. Either everything has been delivered and billed, or what is
              outstanding is incomplete — and what it is missing is on the{' '}
              <Link href="/sales/incomplete" className="underline">incomplete documents</Link> list.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="grid-table text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    {dueColumns(due.rows).map((column) => (
                      <th key={column}>{column.replace(/([A-Z])/g, ' $1').toLowerCase()}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {due.rows.map((row, index) => (
                    <tr key={String(row.orderNumber ?? row.deliveryNumber ?? index)}>
                      {dueColumns(due.rows).map((column) => (
                        <td key={column} className="font-mono">{String(row[column] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-ink-faint">
                {due.count} answer{duplicate(due.count)}.
                {due.truncated ? ` Cut at ${REGISTER_LIMIT}: narrow the filter to see the rest.` : ''}
              </p>
            </div>
          )
        ) : register && register.rows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">
            Nothing answers. {kind === 'RETURNS'
              ? 'Either no returns have been raised, or the tenant has named no returns document types.'
              : 'Either no document of this kind stands, or the filter narrowed it to nothing.'}
          </p>
        ) : register ? (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Document</th>
                  <th>Type</th>
                  <th>Dated</th>
                  <th>Customer</th>
                  <th>Sales org</th>
                  <th>Plant</th>
                  <th>Status</th>
                  <th>Raised against</th>
                  <th>Net</th>
                  <th>Gross</th>
                </tr>
              </thead>
              <tbody>
                {register.rows.map((row) => (
                  <tr key={`${row.kind}/${row.documentNumber}`}>
                    <td className="font-mono">{row.documentNumber}</td>
                    <td className="font-mono">{row.documentType}</td>
                    <td>{row.documentDate}</td>
                    <td className="font-mono">
                      {row.customerNumber}
                      {row.customerName ? <span className="text-ink-faint"> · {row.customerName}</span> : null}
                    </td>
                    <td className="font-mono">{row.salesOrg}</td>
                    <td className="font-mono">{row.plant ?? '—'}</td>
                    <td>{row.status}</td>
                    <td className="font-mono">
                      {row.referenceNumber ?? '—'}
                      {row.invoiceListNumber
                        ? <span className="text-ink-faint"> · list {row.invoiceListNumber}</span>
                        : null}
                    </td>
                    <td className="font-mono">{row.netValue ?? '—'}</td>
                    <td className="font-mono">{row.grossValue ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-ink-faint">
              {register.totals.documents} shown of {register.count} answering
              {register.truncated ? ` — cut at ${REGISTER_LIMIT}, so narrow the filter to see the rest` : ''}
              {register.totals.grossValue
                ? `. Total of what is shown: ${register.totals.netValue ?? '—'} net, ${register.totals.grossValue} gross${register.rows[0]?.currency ? ` ${register.rows[0].currency}` : ''}.`
                : '.'}
            </p>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function duplicate(count: number): string {
  return count === 1 ? '' : 's';
}

/** The columns a due row carries. The two due lists answer different questions, so they differ. */
function dueColumns(rows: Array<Record<string, string | number | null>>): string[] {
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}

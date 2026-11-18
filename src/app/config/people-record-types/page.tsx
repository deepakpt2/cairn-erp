
import { can, requireSession } from '@/platform/auth/current';
import { RECORD_TYPE_CAPABILITY, RECORD_TYPE_ROUTE, getRecordType, listRecordTypes } from '@/modules/people/record-types';
import RecordTypes from './RecordTypes';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Record types: what the tenant decides to keep about a person.
 *
 * DV-012 replaced SAP's fixed infotype numbering with configurable record types, so this screen — and not a
 * migration — is where a type comes from. A type names itself and lists the fields it asks for, and each field
 * carries the kind of answer that fits it (`TEXT`, `NUMBER`, `DATE`), which is what lets a dated record be
 * validated and stored in a column Postgres can judge instead of a wall of text.
 *
 * Two things this screen will not do, both because the data says so. A type is **retired rather than deleted**:
 * `is_valid = false` stops new records and leaves the standing ones readable, and the database refuses to
 * remove a type any record cites — so a definition that payroll history depends on cannot vanish (the same
 * rule OBA4 set for tolerance groups). And a field&apos;s **kind is not renamed while records answer it**: the
 * value lives in the column its kind picks, so re-typing it would strand the answers already written.
 *
 * Pay components, deduction rules, org units and positions have their own decisions to make first
 * (docs/operational-readiness.md §4 items 4 and 5), so they are not offered here as empty forms: an
 * `enables` entry in the configuration workbench stays unreached until the rule behind it exists.
 */
export default async function PeopleRecordTypesPage({ searchParams }: {
  searchParams: Promise<{ type?: string }>;
}) {
  const session = await requireSession(RECORD_TYPE_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const wanted = (params.type ?? '').trim().toUpperCase();

  const [types, selected] = await Promise.all([
    listRecordTypes(client),
    // A code nobody defined is a refusal the screen shows, not a crash: read it, and say so when it is absent.
    wanted ? getRecordType(client, wanted).catch(() => null) : Promise.resolve(null),
  ]);

  return (
    <Page
      title="Employee record types" code={RECORD_TYPE_CAPABILITY} width="5xl"
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              A record type says what is kept about a person, and a field says what kind of answer fits it. Every
              employee&apos;s knowledge is a dated record of one of these types, so a change is a new record rather
              than a rewritten history.
            </p>
        </>
      }
      actions={
        <>
          <LinkButton href="/people/employees">Employees</LinkButton>
          <LinkButton href="/config">Configuration</LinkButton>
        </>
      }
    >
      <RecordTypes
        types={types}
        selected={selected}
        wanted={wanted}
        allowed={can(session, RECORD_TYPE_CAPABILITY)}
      />
    </Page>
  );
}

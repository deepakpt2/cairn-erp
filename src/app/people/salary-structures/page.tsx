/**
 * Salary structures — PEOPLE.PAYROLL.STRUCTURE.DEFINE. SAP: pay scale group/level (T510).
 *
 * Payroll phase 1: define a structure, its components and each component's amount rule (fixed or a
 * percentage of base). Employees are assigned a structure on /people/employees. Nothing here
 * calculates or posts. A component can be removed from a structure; calculated results keep
 * their lines. `?structure=` opens one structure.
 */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PAY_COMPONENT_ROUTE,
  SALARY_STRUCTURE_CAPABILITY,
  SALARY_STRUCTURE_ROUTE,
  defaultPayrollCurrency,
  getStructure,
  listAssignableComponents,
  listStructures,
} from '@/modules/people/payroll-structure';

import { ChangeStructureForm, ComponentForm, DefineStructureForm, RemoveComponentForm } from './StructureForms';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = SALARY_STRUCTURE_ROUTE;
const CAPABILITY = SALARY_STRUCTURE_CAPABILITY;

export default async function SalaryStructurePage({ searchParams }: { searchParams: Promise<{ structure?: string }> }) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const access = { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } };
  const allowed = can(session, CAPABILITY);
  const client = session.user.client;
  const [structures, components, currency] = allowed
    ? await Promise.all([listStructures(client, access), listAssignableComponents(client), defaultPayrollCurrency(client)])
    : [[], [], null];
  const selectedCode = params.structure?.toUpperCase();
  const selected = allowed && selectedCode && structures.some((s) => s.code === selectedCode)
    ? await getStructure(client, selectedCode, access)
    : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title="Salary structures" code={<>{CAPABILITY} · T510</>} back={{ href: '/', label: t('nav.launchpad') }}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              A structure is a named set of pay components, each with its amount rule — a fixed amount or a percentage of
              the employee&apos;s base. Employees are assigned a structure and a base on the employee screen. Nothing here
              calculates or posts.
            </p>
        </>
      }
      actions={
        <>
          <LinkButton href={PAY_COMPONENT_ROUTE}>Pay components</LinkButton>
        </>
      }
    >

      {!allowed && (
        <p role="status" className="text-sm text-ink-soft">
          You do not hold the salary structure capability. Ask for {CAPABILITY}.
        </p>
      )}

      {allowed && (
        <>
          <section className="panel overflow-x-auto" aria-label="Structures">
            <h2 className="panel-title px-4 pt-4">Structures</h2>
            {structures.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No salary structure is defined yet.</p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr><th>Code</th><th>Name</th><th>Currency</th><th>Valid from</th><th>Valid to</th><th>Components</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {structures.map((s) => (
                    <tr key={s.code}>
                      <td className="code"><Link href={`${ROUTE}?structure=${s.code}`} className="underline">{s.code}</Link></td>
                      <td>{s.name}</td>
                      <td className="code">{s.currency}</td>
                      <td className="text-xs">{s.validFrom}</td>
                      <td className="text-xs">{s.validTo ?? 'open'}</td>
                      <td>{s.components}</td>
                      <td><span className={s.isValid ? 'chip' : 'chip chip-warn'}>{s.isValid ? 'valid' : 'retired'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {selected && (
            <>
              <section className="panel overflow-x-auto" aria-label={`Components of ${selected.code}`}>
                <h2 className="panel-title px-4 pt-4">{selected.code} — {selected.name}: components and amount rules</h2>
                {selected.components.length === 0 ? (
                  <p className="p-4 text-sm text-ink-soft">Structure {selected.code} names no components yet; a payroll run cannot include anyone on it.</p>
                ) : (
                  <table className="grid-table">
                    <thead><tr><th>Component</th><th>Name</th><th>Kind</th><th>Rule</th><th></th></tr></thead>
                    <tbody>
                      {selected.components.map((c) => (
                        <tr key={c.componentCode}>
                          <td className="code">{c.componentCode}</td>
                          <td>{c.componentName}</td>
                          <td className="text-xs">{c.componentKind}</td>
                          <td className="code">{c.amountKind === 'FIXED' ? `fixed ${c.amountValue} ${selected.currency}` : `${c.amountValue} % of base`}</td>
                          <td><RemoveComponentForm structureCode={selected.code} componentCode={c.componentCode} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <ComponentForm structureCode={selected.code} components={components} />
              <ChangeStructureForm code={selected.code} name={selected.name} validTo={selected.validTo} isValid={selected.isValid} />
            </>
          )}

          {components.length === 0 && (
            <p role="status" className="panel p-4 text-sm text-ink-soft">
              No valid pay component exists yet. Define them at <Link href={PAY_COMPONENT_ROUTE} className="underline">{PAY_COMPONENT_ROUTE}</Link> first.
            </p>
          )}

          <DefineStructureForm defaultCurrency={currency ?? ''} today={today} />
        </>
      )}
    </Page>
  );
}

/**
 * BOM explosion and where-used — CS11 / CS12 / CS15, guarded by PROD.BOM.DISPLAY. Read-only.
 *
 * GET: `mode` (EXPLODE | WHERE_USED), `materialNumber`, `plant`, `keyDate`, `depth` (SINGLE | MULTI),
 * and for the explosion `quantity`, `usage`, `alternative`, `productionVersion`; for where-used
 * `allPlants` (every plant the user's Plant scope reaches). Diagnostics are shown on their rows.
 */

import { can, requireSession } from '@/platform/auth/current';
import {
  BOM_EXPLOSION_CAPABILITY,
  BOM_EXPLOSION_ROUTE,
  BomExplosionError,
  explodeBom,
  whereUsedBom,
  type ExplosionDiagnostic,
  type ExplosionView,
  type WhereUsedView,
} from '@/modules/production/bom-explosion';
import { withTenant } from '@/platform/db/client';
import { sql } from 'drizzle-orm';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

function last(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[value.length - 1] : value)?.trim() ?? '';
}

const SEVERITY: Record<string, string> = { INFO: 'text-ink-soft', WARNING: 'text-signal-warn', ERROR: 'text-signal-error' };

function Diagnostics({ list }: { list: ExplosionDiagnostic[] }) {
  if (list.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {list.map((d, i) => <li key={i} className={`text-xs ${SEVERITY[d.severity] ?? ''}`}><span className="code">{d.code}</span> {d.message}</li>)}
    </ul>
  );
}

function markers(r: { isPhantom: boolean; isBulk: boolean; isCoProduct: boolean; isFixed: boolean }) {
  return [r.isPhantom && 'phantom', r.isBulk && 'bulk', r.isCoProduct && 'co-product', r.isFixed && 'fixed qty'].filter(Boolean) as string[];
}

export default async function BomExplosionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession(BOM_EXPLOSION_ROUTE);
  const params = await searchParams;
  const allowed = can(session, BOM_EXPLOSION_CAPABILITY);
  const client = session.user.client;
  const mode = last(params.mode) === 'WHERE_USED' ? 'WHERE_USED' : 'EXPLODE';
  const materialNumber = last(params.materialNumber).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const keyDate = last(params.keyDate) || today;
  const depth = last(params.depth) === 'SINGLE' ? 'SINGLE' : 'MULTI';
  const plants = allowed
    ? ((await withTenant(client, (tx) => tx.execute(sql`select plant, name from plant where client = ${client} order by plant`))) as unknown as Array<{ plant: string; name: string }>)
    : [];
  const plant = (last(params.plant) || plants[0]?.plant || '').toUpperCase();
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };

  let explosion: ExplosionView | null = null;
  let whereUsed: WhereUsedView | null = null;
  let problem: string | null = null;
  if (allowed && materialNumber && plant) {
    try {
      if (mode === 'EXPLODE') {
        explosion = await explodeBom({
          client, materialNumber, plant, keyDate, depth, quantity: last(params.quantity),
          usage: last(params.usage), alternative: last(params.alternative), productionVersion: last(params.productionVersion),
        }, { authorization });
      } else {
        whereUsed = await whereUsedBom({ client, materialNumber, plant, keyDate, depth, allScopedPlants: last(params.allPlants) === 'yes' }, { authorization });
      }
    } catch (error) {
      if (!(error instanceof BomExplosionError)) throw error;
      problem = `${error.message}${error.remedy ? ` ${error.remedy}` : ''}`;
    }
  }

  return (
    <Page
      title="BOM explosion and where-used" code={<>{BOM_EXPLOSION_CAPABILITY} · CS11 / CS12 / CS15</>} width="7xl"
      description="The explosion shows what a material is made of, with the quantities MRP would plan for the quantity entered (the BOM base quantity when none is). Where-used lists every BOM a material is used in, with BOM quantities — never a requirement."
      actions={
        <>
          <LinkButton href="/production/bom-display">Display BOM</LinkButton>
        </>
      }
    >

      {!allowed ? (
        <p role="status" className="text-sm text-ink-soft">You do not hold {BOM_EXPLOSION_CAPABILITY}. Ask for it to read bills of material.</p>
      ) : (
        <form method="get" className="panel flex flex-wrap items-end gap-3 p-3" aria-label="Selection">
          <label>
            <span className="field-label">Report</span>
            <select name="mode" defaultValue={mode} className="field-input">
              <option value="EXPLODE">Explosion (CS11 / CS12)</option>
              <option value="WHERE_USED">Where-used (CS15)</option>
            </select>
          </label>
          <label>
            <span className="field-label">Material</span>
            <input name="materialNumber" defaultValue={materialNumber} required maxLength={40} className="field-input code w-36" />
          </label>
          <label>
            <span className="field-label">Plant</span>
            <select name="plant" defaultValue={plant} className="field-input">
              {plants.map((p) => <option key={p.plant} value={p.plant}>{p.plant} — {p.name}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Key date</span>
            <input type="date" name="keyDate" defaultValue={keyDate} className="field-input" />
          </label>
          <label>
            <span className="field-label">Levels</span>
            <select name="depth" defaultValue={depth} className="field-input">
              <option value="MULTI">Multi-level</option>
              <option value="SINGLE">Single level</option>
            </select>
          </label>
          <label>
            <span className="field-label">Quantity (explosion)</span>
            <input name="quantity" defaultValue={last(params.quantity)} inputMode="decimal" className="field-input w-24" placeholder="base qty" />
          </label>
          <label>
            <span className="field-label">BOM usage</span>
            <input name="usage" defaultValue={last(params.usage)} maxLength={1} className="field-input code w-14" />
          </label>
          <label>
            <span className="field-label">Alternative</span>
            <input name="alternative" defaultValue={last(params.alternative)} maxLength={2} className="field-input code w-14" />
          </label>
          <label>
            <span className="field-label">Production version</span>
            <input name="productionVersion" defaultValue={last(params.productionVersion)} maxLength={4} className="field-input code w-20" />
          </label>
          <label>
            <span className="field-label">Where-used plants</span>
            <select name="allPlants" defaultValue={last(params.allPlants) === 'yes' ? 'yes' : 'no'} className="field-input">
              <option value="no">This plant</option>
              <option value="yes">Every plant in my scope</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8">Show</button>
        </form>
      )}

      {problem && <p role="status" className="panel p-4 text-sm text-signal-error">{problem}</p>}

      {explosion && (
        <section className="panel space-y-2 p-4" aria-label="Explosion">
          <h2 className="panel-title">
            {explosion.materialNumber} {explosion.materialName ? `— ${explosion.materialName}` : ''} · plant {explosion.plant} · {explosion.depth === 'MULTI' ? 'multi-level (CS12)' : 'single level (CS11)'} · on {explosion.keyDate}
          </h2>
          <p className="text-sm">
            BOM {explosion.bom.usage}/{explosion.bom.alternative}{explosion.bom.bomNumber ? ` (BOM ${explosion.bom.bomNumber})` : ''}, status {explosion.bom.status ?? '—'},
            base quantity {explosion.bom.baseQuantity} {explosion.bom.baseUnit}, valid {explosion.bom.validFrom} to {explosion.bom.validTo} —{' '}
            {explosion.bom.productionVersion ? `chosen by production version ${explosion.bom.productionVersion}` : 'named directly (production version overridden)'}.
            Exploding {explosion.quantity} {explosion.bom.baseUnit}{explosion.quantityWasDefaulted ? ' (the BOM base quantity)' : ''}.
            {` ${explosion.rows.length} rows, deepest level ${explosion.maxLevel}.`}
          </p>
          <div className="overflow-x-auto">
            <table className="grid-table text-xs">
              <thead><tr><th>Level</th><th>Item</th><th>Component</th><th>Per base</th><th>Required</th><th>Scrap %</th><th>Markers</th><th>Notes</th></tr></thead>
              <tbody>
                {explosion.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="code">{'· '.repeat(r.level - 1)}{r.level}</td>
                    <td className="code">{r.itemNumber} <span className="text-ink-faint">{r.itemCategory}</span></td>
                    <td style={{ paddingLeft: `${(r.level - 1) * 1.25}rem` }}>
                      {r.materialNumber
                        ? <><span className="code">{r.materialNumber}</span> {r.materialName}</>
                        : <span className="italic">{r.itemText ?? 'text item'}</span>}
                      {r.explodedBom && <div className="text-ink-faint">exploded with BOM {r.explodedBom}</div>}
                    </td>
                    <td className="code">{r.quantity ?? ''} {r.unit ?? ''}</td>
                    <td className="code">{r.requiredQuantity ?? '—'} {r.requiredQuantity ? r.requiredUnit ?? '' : ''}</td>
                    <td className="code">{r.scrapPercent ?? ''}</td>
                    <td>
                      {markers(r).map((m) => <span key={m} className="chip mr-1">{m}</span>)}
                      {r.issuingPlant && <span className="chip mr-1">issues from {r.issuingPlant}</span>}
                      {r.followUpMaterial && <span className="chip mr-1">follow-up {r.followUpMaterial}</span>}
                    </td>
                    <td><Diagnostics list={r.diagnostics} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {whereUsed && (
        <section className="panel space-y-2 p-4" aria-label="Where-used">
          <h2 className="panel-title">
            Where {whereUsed.materialNumber} {whereUsed.materialName ? `(${whereUsed.materialName})` : ''} is used · plant{whereUsed.plants.length > 1 ? 's' : ''} {whereUsed.plants.join(', ')} · {whereUsed.depth === 'MULTI' ? 'multi-level' : 'single level'} · on {whereUsed.keyDate}
          </h2>
          <p className="text-xs text-ink-soft">Quantities are BOM quantities per the parent&apos;s base quantity — not requirements. For a requirement, explode the parent with a quantity.</p>
          {whereUsed.note ? (
            <p role="status" className="text-sm">{whereUsed.note}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-table text-xs">
                <thead><tr><th>Level</th><th>Used in</th><th>Plant</th><th>BOM</th><th>Item</th><th>Quantity per base</th><th>Scrap %</th><th>Markers</th><th>Notes</th></tr></thead>
                <tbody>
                  {whereUsed.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="code">{r.level}</td>
                      <td style={{ paddingLeft: `${(r.level - 1) * 1.25}rem` }}><span className="code">{r.parentMaterial}</span> {r.parentName}<div className="text-ink-faint">contains {r.componentMaterial}</div></td>
                      <td className="code">{r.plant}</td>
                      <td className="code">{r.usage}/{r.alternative}</td>
                      <td className="code">{r.itemNumber} <span className="text-ink-faint">{r.itemCategory}</span></td>
                      <td className="code">{r.quantity} {r.unit} per {r.baseQuantity} {r.baseUnit}</td>
                      <td className="code">{r.scrapPercent ?? ''}</td>
                      <td>{markers(r).map((m) => <span key={m} className="chip mr-1">{m}</span>)}</td>
                      <td><Diagnostics list={r.diagnostics} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </Page>
  );
}

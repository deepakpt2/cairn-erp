'use client';

import { useActionState, useEffect, useState } from 'react';

import { ChangeLock } from '@/ui/lock/ChangeLock';
import type { MaterialBomView } from '@/modules/production/material-bom';
import { saveBomAction, type BomActionState } from './actions';

const INITIAL: BomActionState = { ok: false };

export interface BomItemDraft {
  itemNumber: string;
  itemCategory: string;
  componentMaterial: string;
  quantity: string;
  unit: string;
  scrapPercent: string;
  sortString: string;
  itemText: string;
  validFrom: string;
  validTo: string;
  fixedQuantity: string;
  bulkMaterial: string;
  phantom: string;
  coproduct: string;
  followUpMaterial: string;
  specialProcurement: string;
  issuingPlant: string;
  deletionFlag: string;
  persisted: boolean;
}

function blankItem(itemNumber: string): BomItemDraft {
  return {
    itemNumber,
    itemCategory: '',
    componentMaterial: '',
    quantity: '',
    unit: '',
    scrapPercent: '',
    sortString: '',
    itemText: '',
    validFrom: '',
    validTo: '',
    fixedQuantity: ' ',
    bulkMaterial: ' ',
    phantom: ' ',
    coproduct: ' ',
    followUpMaterial: '',
    specialProcurement: '',
    issuingPlant: '',
    deletionFlag: ' ',
    persisted: false,
  };
}

function nextNumber(items: BomItemDraft[]): string {
  const used = items.map((item) => Number(item.itemNumber)).filter((value) => Number.isInteger(value) && value > 0);
  const cursor = used.length === 0 ? 10 : Math.max(...used) + 10;
  return String(cursor).padStart(4, '0');
}

export default function BomForm({
  document,
  plants,
  materials,
  usages,
  statuses,
  categories,
  locked,
}: {
  document: MaterialBomView | null;
  plants: Array<{ plant: string; name: string }>;
  materials: Array<{ materialNumber: string; description: string; baseUnit: string | null }>;
  usages: Array<{ usage: string; description: string }>;
  statuses: Array<{ status: string; description: string }>;
  categories: Array<{ category: string; description: string }>;
  locked: boolean;
}) {
  const [state, action, pending] = useActionState(saveBomAction, INITIAL);
  const saved = state.bom ?? document;
  const mode = document ? 'CHANGE' : 'CREATE';
  const [items, setItems] = useState<BomItemDraft[]>(saved?.items.map((item) => ({
    itemNumber: item.itemNumber,
    itemCategory: item.itemCategory,
    componentMaterial: item.componentMaterial ?? '',
    quantity: item.quantity ?? '',
    unit: item.unit ?? '',
    scrapPercent: item.scrapPercent ?? '',
    sortString: item.sortString ?? '',
    itemText: item.itemText ?? '',
    validFrom: item.validFrom,
    validTo: item.validTo,
    fixedQuantity: item.fixedQuantity,
    bulkMaterial: item.bulkMaterial,
    phantom: item.phantom,
    coproduct: item.coproduct,
    followUpMaterial: item.followUpMaterial ?? '',
    specialProcurement: item.specialProcurement ?? '',
    issuingPlant: item.issuingPlant ?? '',
    deletionFlag: item.deletionFlag,
    persisted: true,
  })) ?? []);
  const [dirty, setDirty] = useState(false);
  const [requestKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirty || state.ok) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty, state.ok]);

  function update(index: number, patch: Partial<BomItemDraft>) {
    setDirty(true);
    setItems(items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row);
    setDirty(true);
    setItems(next.map((item, itemIndex) => ({ ...item, sortString: String(itemIndex + 1).padStart(4, '0') })));
  }

  return (
    <form action={action} className="space-y-4" onChange={() => setDirty(true)}>
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="version" value={saved?.version ?? ''} />
      <input type="hidden" name="requestKey" value={mode === 'CREATE' ? requestKey : ''} />
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      {mode === 'CHANGE' && (
        <>
          <input type="hidden" name="materialNumber" value={saved?.materialNumber ?? ''} />
          <input type="hidden" name="plant" value={saved?.plant ?? ''} />
          <input type="hidden" name="usage" value={saved?.usage ?? ''} />
          <input type="hidden" name="alternative" value={saved?.alternative ?? ''} />
        </>
      )}
      {state.message && (
        <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      {state.warnings?.map((warning) => <p key={warning} className="text-sm text-ink-soft">{warning}</p>)}
      {locked && <p className="text-sm text-ink-soft">This BOM is open for change elsewhere. It is not editable here.</p>}
      {document && !locked && <ChangeLock lockObject="MATERIAL_BOM" argument={`${document.plant}/${document.materialNumber}/${document.usage}/${document.alternative}`} />}

      <section className="panel space-y-3 p-4">
        <h2 className="text-sm font-semibold">Header</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="field-label">Material</span>
            <input className="input mt-1 w-full" name="materialNumber" list="bom-materials" defaultValue={saved?.materialNumber ?? ''} required readOnly={mode === 'CHANGE'} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Plant</span>
            <select className="input mt-1 w-full" name="plant" defaultValue={saved?.plant ?? ''} required disabled={mode === 'CHANGE' || locked}>
              <option value="">Select</option>
              {plants.map((row) => <option key={row.plant} value={row.plant}>{row.plant} · {row.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="field-label">BOM usage</span>
            <select className="input mt-1 w-full" name="usage" defaultValue={saved?.usage ?? ''} required disabled={mode === 'CHANGE' || locked}>
              <option value="">Select</option>
              {usages.map((row) => <option key={row.usage} value={row.usage}>{row.usage} · {row.description}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="field-label">Alternative</span>
            <input className="input mt-1 w-full" name="alternative" defaultValue={saved?.alternative ?? ''} maxLength={2} readOnly={mode === 'CHANGE'} placeholder="Blank assigns the next 01–99" />
          </label>
          <label className="block text-sm">
            <span className="field-label">Status</span>
            <select className="input mt-1 w-full" name="status" defaultValue={saved?.status ?? ''} disabled={locked}>
              <option value="">None</option>
              {statuses.map((row) => <option key={row.status} value={row.status}>{row.status} · {row.description}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="field-label">Base quantity</span>
            <input className="input mt-1 w-full" name="baseQuantity" defaultValue={saved?.baseQuantity ?? ''} required disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Base unit</span>
            <input className="input mt-1 w-full" name="baseUnit" defaultValue={saved?.baseUnit ?? ''} maxLength={6} required disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Valid from</span>
            <input className="input mt-1 w-full" type="date" name="validFrom" defaultValue={saved?.validFrom ?? ''} required disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Valid to</span>
            <input className="input mt-1 w-full" type="date" name="validTo" defaultValue={saved?.validTo === '9999-12-31' ? '' : saved?.validTo ?? ''} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Header text</span>
            <input className="input mt-1 w-full" name="headerText" defaultValue={saved?.headerText ?? ''} maxLength={40} disabled={locked} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Change number</span>
            <input className="input mt-1 w-full" name="changeNumber" maxLength={12} disabled={locked} />
          </label>
        </div>
        <p className="text-sm text-ink-soft">A blank valid-to is stored as 9999-12-31. A change number is refused. Engineering change management is not implemented. The component description is read from the material master.</p>
        {mode === 'CHANGE' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="deletionFlag" value="X" defaultChecked={saved?.deletionFlag === 'X'} disabled={locked} />
            Deletion flag. The BOM is not physically deleted.
          </label>
        )}
        {saved && <p className="text-sm">BOM {saved.bomNumber} · version {saved.version}. {saved.unchangedProductionOrders} production order{saved.unchangedProductionOrders === 1 ? '' : 's'} for this material {saved.unchangedProductionOrders === 1 ? 'is' : 'are'} not rewritten.</p>}
      </section>

      {mode === 'CREATE' && (
        <section className="panel space-y-3 p-4">
          <h2 className="text-sm font-semibold">Copy</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <input className="input" name="copyMaterial" placeholder="Reference material" maxLength={40} disabled={locked} />
            <input className="input" name="copyPlant" placeholder="Plant" maxLength={10} disabled={locked} />
            <input className="input" name="copyUsage" placeholder="Usage" maxLength={1} disabled={locked} />
            <input className="input" name="copyAlternative" placeholder="Alternative" maxLength={2} disabled={locked} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="copyItems" value="X" defaultChecked disabled={locked} />
            Copy components when this grid is empty. The deletion flag is not copied.
          </label>
        </section>
      )}

      <section className="panel space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Components</h2>
          <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled={locked} onClick={() => { setDirty(true); setItems([...items, blankItem(nextNumber(items))]); }}>
            Add
          </button>
        </div>
        {items.length === 0 && <p className="text-sm text-ink-soft">No component is entered.</p>}
        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={`${item.itemNumber}-${index}`} className="grid gap-2 border border-line p-3 sm:grid-cols-4">
              <label className="text-sm">Item
                <input className="input mt-1 w-full" aria-label={`Item number ${index + 1}`} value={item.itemNumber} readOnly={item.persisted} onChange={(event) => update(index, { itemNumber: event.target.value })} />
              </label>
              <label className="text-sm">Category
                <select className="input mt-1 w-full" aria-label={`Item category ${index + 1}`} value={item.itemCategory} disabled={locked} onChange={(event) => update(index, { itemCategory: event.target.value })}>
                  <option value="">Select</option>
                  {categories.map((row) => <option key={row.category} value={row.category}>{row.category} · {row.description}</option>)}
                </select>
              </label>
              <label className="text-sm">Component
                <input className="input mt-1 w-full" aria-label={`Component ${index + 1}`} list="bom-materials" value={item.componentMaterial} disabled={locked} onChange={(event) => update(index, { componentMaterial: event.target.value })} />
              </label>
              <label className="text-sm">Quantity
                <input className="input mt-1 w-full" aria-label={`Quantity ${index + 1}`} value={item.quantity} disabled={locked} onChange={(event) => update(index, { quantity: event.target.value })} />
              </label>
              <label className="text-sm">Unit
                <input className="input mt-1 w-full" aria-label={`Unit ${index + 1}`} value={item.unit} disabled={locked} onChange={(event) => update(index, { unit: event.target.value })} />
              </label>
              <label className="text-sm">Scrap %
                <input className="input mt-1 w-full" aria-label={`Scrap ${index + 1}`} value={item.scrapPercent} disabled={locked} onChange={(event) => update(index, { scrapPercent: event.target.value })} />
              </label>
              <label className="text-sm">Sort string
                <input className="input mt-1 w-full" aria-label={`Sort string ${index + 1}`} value={item.sortString} maxLength={10} disabled={locked} onChange={(event) => update(index, { sortString: event.target.value })} />
              </label>
              <label className="text-sm">Item text
                <input className="input mt-1 w-full" aria-label={`Item text ${index + 1}`} value={item.itemText} maxLength={40} disabled={locked} onChange={(event) => update(index, { itemText: event.target.value })} />
              </label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.fixedQuantity === 'X'} disabled={locked} onChange={(event) => update(index, { fixedQuantity: event.target.checked ? 'X' : ' ' })} /> Fixed quantity</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.bulkMaterial === 'X'} disabled={locked} onChange={(event) => update(index, { bulkMaterial: event.target.checked ? 'X' : ' ' })} /> Bulk</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.phantom === 'X'} disabled={locked} onChange={(event) => update(index, { phantom: event.target.checked ? 'X' : ' ' })} /> Phantom</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.coproduct === 'X'} disabled={locked} onChange={(event) => update(index, { coproduct: event.target.checked ? 'X' : ' ' })} /> Co-product</label>
              <label className="text-sm">Follow-up
                <input className="input mt-1 w-full" aria-label={`Follow-up ${index + 1}`} value={item.followUpMaterial} disabled={locked} onChange={(event) => update(index, { followUpMaterial: event.target.value })} />
              </label>
              <label className="text-sm">Special procurement
                <input className="input mt-1 w-full" aria-label={`Special procurement ${index + 1}`} value={item.specialProcurement} maxLength={2} disabled={locked} onChange={(event) => update(index, { specialProcurement: event.target.value })} />
              </label>
              <label className="text-sm">Issuing plant
                <input className="input mt-1 w-full" aria-label={`Issuing plant ${index + 1}`} value={item.issuingPlant} disabled={locked} onChange={(event) => update(index, { issuingPlant: event.target.value })} />
              </label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.deletionFlag === 'X'} disabled={locked || !item.persisted} onChange={(event) => update(index, { deletionFlag: event.target.checked ? 'X' : ' ' })} /> Deletion flag</label>
              <div className="flex flex-wrap gap-2 sm:col-span-4">
                <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled={locked} onClick={() => move(index, -1)}>Up</button>
                <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled={locked} onClick={() => move(index, 1)}>Down</button>
                <button type="button" className="btn btn-default min-h-11 sm:min-h-8" disabled={locked} onClick={() => { setDirty(true); setItems([...items, { ...item, itemNumber: nextNumber(items), deletionFlag: ' ', persisted: false }]); }}>Copy</button>
                {!item.persisted && <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => { setDirty(true); setItems(items.filter((_, itemIndex) => itemIndex !== index)); }}>Remove</button>}
              </div>
            </div>
          ))}
        </div>
      </section>
      <datalist id="bom-materials">
        {materials.map((row) => <option key={row.materialNumber} value={row.materialNumber}>{row.description} · {row.baseUnit ?? ''}</option>)}
      </datalist>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending || locked}>{pending ? 'Saving' : mode === 'CHANGE' ? 'Save change' : 'Create BOM'}</button>
    </form>
  );
}

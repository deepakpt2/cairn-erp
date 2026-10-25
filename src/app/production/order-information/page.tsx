import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { MATERIAL_DOC_DISPLAY_CAPABILITY } from '@/modules/inventory/material-document-display';
import {
  ORDER_INFORMATION_CAPABILITY,
  ORDER_INFORMATION_ROUTE,
  OrderInformationError,
  listOrderInformationLayouts,
  orderInformationFields,
  orderInformationLists,
  orderInformationRefusal,
  runOrderInformation,
} from '@/modules/production/order-information';
import { PLANNED_ORDER_DISPLAY_CAPABILITY } from '@/modules/production/planned-order-display';
import { PRODUCTION_ORDER_CHANGE_CAPABILITY } from '@/modules/production/production-order-change';
import { ORDER_CONFIRMATION_CAPABILITY } from '@/modules/production/order-confirmation';
import { TIME_TICKET_CAPABILITY } from '@/modules/production/time-ticket';
import OrderInformationResultView from './OrderInformationResult';

export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function many(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => item.trim()).filter(Boolean);
}

export default async function OrderInformationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ORDER_INFORMATION_ROUTE);
  const params = await searchParams;
  const lists = orderInformationLists();
  const selection = one(params.selection);
  const [object = 'PRODUCTION_ORDER', listType = ''] = selection.split(':');
  const refusal = orderInformationRefusal({
    orderType: one(params.orderType),
    productionSupervisor: one(params.productionSupervisor),
    productionVersion: one(params.productionVersion),
    deletionIndicator: one(params.deletionIndicator),
    workCenter: one(params.workCenter),
    operation: one(params.operation),
    cost: one(params.cost),
    price: one(params.price),
    automaticGoodsMovement: one(params.automaticGoodsMovement),
    goodsMovementError: one(params.goodsMovementError),
    purchaseRequisition: one(params.purchaseRequisition),
    purchaseOrder: one(params.purchaseOrder),
    co14: one(params.co14),
    teco: one(params.teco),
    relativeDate: one(params.relativeDate),
    sharedLayout: one(params.sharedLayout),
  });
  let result = null;
  let layouts: Awaited<ReturnType<typeof listOrderInformationLayouts>> = [];
  let openError = refusal ?? '';
  const run = one(params.run) === '1';
  if (!refusal && run && can(session, ORDER_INFORMATION_CAPABILITY) && listType) {
    try {
      result = await runOrderInformation(session.user.client, {
        object,
        listType,
        plant: one(params.plant),
        orderNumber: one(params.order),
        plannedOrderNumber: one(params.plannedOrder),
        materialNumber: one(params.material),
        materialDescription: one(params.description),
        mrpController: one(params.mrpController),
        status: one(params.status),
        componentMaterial: one(params.component),
        storageLocation: one(params.storageLocation),
        batch: one(params.batch),
        movementType: one(params.movementType),
        confirmationType: one(params.confirmationType),
        dateBasis: one(params.dateBasis),
        dateFrom: one(params.dateFrom),
        dateTo: one(params.dateTo),
        fields: many(params.field),
        sortField: one(params.sortField),
        sortDirection: one(params.sortDirection),
        limit: one(params.limit) ? Number(one(params.limit)) : undefined,
        offset: one(params.offset) ? Number(one(params.offset)) : undefined,
        reduced: one(params.reduced) === '1',
        layoutId: one(params.layout),
        owner: session.user.username,
        named: {
          orderType: one(params.orderType),
          cost: one(params.cost),
          price: one(params.price),
        },
      });
      layouts = await listOrderInformationLayouts(session.user.client, session.user.username, object, listType);
    } catch (error) {
      openError = error instanceof OrderInformationError ? error.message : 'The list could not be read.';
    }
  }
  const fields = listType ? orderInformationFields(object === 'PLANNED_ORDER' ? 'PLANNED_ORDER' : 'PRODUCTION_ORDER', listType) : [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">PROD.ORDER.INFO · COOIS</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Production order information</h1>
          <Link href="/production/production-order-display" className="btn btn-default min-h-11 sm:min-h-8">CO03</Link>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          List production orders or planned orders. Execute reads. It does not change an order, confirm one, or post.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-ink-soft" data-coois-gaps>
          Operations, sequences, capacities, automatic goods movements, purchase documents, and cost are not this list. Cancellation is CO13. CO14 is not implemented.
        </p>
      </header>
      {openError && <p role="status" data-coois-refused className="text-sm text-red-700">{openError}</p>}
      {!can(session, ORDER_INFORMATION_CAPABILITY) && (
        <p className="text-sm">You do not hold the list capability ({ORDER_INFORMATION_CAPABILITY}).</p>
      )}
      <form className="grid gap-2 sm:grid-cols-4" method="get">
        <input type="hidden" name="run" value="1" />
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">List</span>
          <select className="input w-full" name="selection" defaultValue={selection} required>
            <option value="">Choose</option>
            <optgroup label="Production orders">
              {lists.filter((row) => row.available && row.objects.includes('PRODUCTION_ORDER')).map((row) => (
                <option key={`PRODUCTION_ORDER:${row.id}`} value={`PRODUCTION_ORDER:${row.id}`}>{row.label}</option>
              ))}
            </optgroup>
            <optgroup label="Planned orders">
              {lists.filter((row) => row.available && row.objects.includes('PLANNED_ORDER')).map((row) => (
                <option key={`PLANNED_ORDER:${row.id}`} value={`PLANNED_ORDER:${row.id}`}>{row.id === 'COMPONENTS' ? 'Dependent requirements' : row.label}</option>
              ))}
            </optgroup>
          </select>
        </label>
        <input className="input" name="plant" defaultValue={one(params.plant)} maxLength={10} placeholder="Plant" />
        <input className="input" name="material" defaultValue={one(params.material)} maxLength={40} placeholder="Material" />
        <input className="input" name="order" defaultValue={one(params.order)} maxLength={80} placeholder="Production order" />
        <input className="input" name="plannedOrder" defaultValue={one(params.plannedOrder)} maxLength={80} placeholder="Planned order" />
        <input className="input" name="component" defaultValue={one(params.component)} maxLength={40} placeholder="Component" />
        <input className="input" name="status" defaultValue={one(params.status)} maxLength={32} placeholder="Status" />
        <input className="input" name="mrpController" defaultValue={one(params.mrpController)} maxLength={3} placeholder="MRP controller" />
        <input className="input" name="batch" defaultValue={one(params.batch)} maxLength={40} placeholder="Batch" />
        <input className="input" name="storageLocation" defaultValue={one(params.storageLocation)} maxLength={10} placeholder="Storage location" />
        <input className="input" name="movementType" defaultValue={one(params.movementType)} maxLength={20} placeholder="Movement type" />
        <input className="input" name="confirmationType" defaultValue={one(params.confirmationType)} maxLength={8} placeholder="Partial or final" />
        <select className="input" name="dateBasis" defaultValue={one(params.dateBasis)}>
          <option value="">Date basis</option>
          <option value="SCHEDULED_START">Scheduled start</option>
          <option value="SCHEDULED_FINISH">Scheduled finish</option>
          <option value="CREATED">Created</option>
          <option value="POSTING">Posting date</option>
          <option value="START">Planned start</option>
          <option value="FINISH">Planned finish</option>
          <option value="REQUIREMENT">Requirement date</option>
        </select>
        <input className="input" type="date" name="dateFrom" defaultValue={one(params.dateFrom)} />
        <input className="input" type="date" name="dateTo" defaultValue={one(params.dateTo)} />
        <input className="input" name="limit" defaultValue={one(params.limit) || '25'} inputMode="numeric" placeholder="Limit" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="reduced" value="1" defaultChecked={one(params.reduced) === '1'} />
          Reduced reading
        </label>
        {fields.map((field) => (
          <label key={field.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="field" value={field.id} defaultChecked={many(params.field).length === 0 || many(params.field).includes(field.id)} />
            {field.label}
          </label>
        ))}
        <button className="btn" type="submit" data-coois-execute>Execute</button>
      </form>
      <ul className="text-sm text-ink-soft" data-coois-unavailable>
        {lists.filter((row) => !row.available).map((row) => (
          <li key={row.id}>{row.label}: {row.reason}</li>
        ))}
      </ul>
      {result && (
        <OrderInformationResultView
          result={result}
          layouts={layouts}
          layoutQuery={new URLSearchParams(Object.entries(params).flatMap(([key, value]) => {
            if (key === 'layout' || value == null) return [];
            return (Array.isArray(value) ? value : [value]).filter((item) => item != null).map((item) => [key, item]);
          })).toString()}
          canChange={can(session, PRODUCTION_ORDER_CHANGE_CAPABILITY)}
          canConfirm={can(session, TIME_TICKET_CAPABILITY)}
          canConfirmOrder={can(session, ORDER_CONFIRMATION_CAPABILITY)}
          canDisplayPlanned={can(session, PLANNED_ORDER_DISPLAY_CAPABILITY)}
          canDisplayDocument={can(session, MATERIAL_DOC_DISPLAY_CAPABILITY)}
        />
      )}
    </div>
  );
}

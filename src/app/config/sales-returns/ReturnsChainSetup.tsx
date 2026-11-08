'use client';

import { useActionState } from 'react';

import { saveReturnsConfigurationAction, type ReturnsConfigurationActionState } from './actions';

const INITIAL: ReturnsConfigurationActionState = { ok: false, message: '' };

export interface ReturnsChainChoice {
  documentTypes: Array<{ documentType: string; name: string }>;
  movements: Array<{ movementType: string; description: string }>;
}

export interface ReturnsChainValues {
  returnsOrderType: string;
  returnsDeliveryType: string;
  complaintType: string;
  creditMemoType: string;
  receiptMovementType: string;
}

function DocumentTypeSelect({
  name, label, help, value, types,
}: {
  name: string;
  label: string;
  help: string;
  value: string;
  types: Array<{ documentType: string; name: string }>;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <select name={name} defaultValue={value} className="field w-full font-mono">
        <option value="">(none)</option>
        {types.map((type) => (
          <option key={type.documentType} value={type.documentType}>
            {type.documentType} — {type.name}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-xs text-ink-faint">{help}</span>
    </label>
  );
}

export function ReturnsChainSetup({
  choices, values,
}: {
  choices: ReturnsChainChoice;
  values: ReturnsChainValues;
}) {
  const [state, action, pending] = useActionState(saveReturnsConfigurationAction, INITIAL);

  return (
    <section aria-labelledby="returns-chain-save" className="border border-line bg-surface p-4">
      <h2 id="returns-chain-save" className="text-sm font-semibold">Name the chain</h2>
      <p className="mt-1 max-w-3xl text-sm text-ink-soft">
        Four document types and one movement. What is chosen here is what the returns screen raises, what the
        warehouse receives against, and what the credit is raised from — the services read this row before they
        create anything. Changing it does not rewrite what already stands: a returns order raised as one type
        stays that type.
      </p>

      <form action={action} className="mt-4 space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <DocumentTypeSelect
            name="returnsOrderType"
            label="Returns order"
            help="The complaint recorded against the invoice: what the customer says they are sending back."
            value={values.returnsOrderType}
            types={choices.documentTypes}
          />
          <DocumentTypeSelect
            name="returnsDeliveryType"
            label="Returns delivery"
            help="The document the goods come back on, and the one the warehouse receives against."
            value={values.returnsDeliveryType}
            types={choices.documentTypes}
          />
          <DocumentTypeSelect
            name="complaintType"
            label="Complaint"
            help="The credit memo request: held with a block until somebody releases it."
            value={values.complaintType}
            types={choices.documentTypes}
          />
          <DocumentTypeSelect
            name="creditMemoType"
            label="Credit memo"
            help="The document that gives the customer their money back."
            value={values.creditMemoType}
            types={choices.documentTypes}
          />
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium">Receipt movement</span>
          <select name="receiptMovementType" defaultValue={values.receiptMovementType} className="field w-full font-mono">
            <option value="">(none)</option>
            {choices.movements.map((movement) => (
              <option key={movement.movementType} value={movement.movementType}>
                {movement.movementType} — {movement.description}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-ink-faint">
            The movement that receives the goods back into returns stock. Only movements that receive into
            returns stock carrying no value are offered: a return is counted, and becomes valuated stock again
            only when inspected goods are transferred out of it.
          </span>
        </label>

        <button type="submit" disabled={pending} className="btn btn-primary min-h-11">
          {pending ? 'Saving…' : 'Save the chain'}
        </button>
      </form>

      {state.message && (
        <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
          {state.message}
          {state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
    </section>
  );
}

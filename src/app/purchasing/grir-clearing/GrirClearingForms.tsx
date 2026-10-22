'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import {
  checkGrIrClearingAction,
  postGrIrClearingAction,
  reverseGrIrClearingAction,
  type GrIrClearingActionState,
} from './actions';

const idle: GrIrClearingActionState = { ok: false, message: '' };
const ROUTE = '/purchasing/grir-clearing';

function useRemember(state: GrIrClearingActionState) {
  const router = useRouter();
  useEffect(() => {
    if (!state.ok || !state.wrote) return;
    const params = new URLSearchParams(window.location.search);
    params.set('notice', state.message);
    router.replace(`${ROUTE}?${params.toString()}`);
  }, [router, state.ok, state.wrote, state.message]);
}

function Notice({ state }: { state: GrIrClearingActionState }) {
  if (!state.message) return null;
  return (
    <p
      className={state.ok ? 'text-sm text-ink' : 'text-sm text-red-700'}
      role={state.ok ? 'status' : 'alert'}
      data-grir-notice
      data-grir-nothing-written={state.wrote === true ? undefined : 'true'}
    >
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export function ClearResidualForm({
  orderNumber, itemNumber, keyDate, fingerprint, postingDateLabel, reasonLabel, checkLabel, postLabel, checkingLabel, postingLabel, acknowledgeLabel,
}: {
  orderNumber: string;
  itemNumber: number;
  keyDate: string;
  fingerprint: string;
  postingDateLabel: string;
  reasonLabel: string;
  checkLabel: string;
  postLabel: string;
  checkingLabel: string;
  postingLabel: string;
  acknowledgeLabel: string;
}) {
  const [key, setKey] = useState('');
  const [postingDate, setPostingDate] = useState('');
  const [comment, setComment] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  useEffect(() => { setKey(crypto.randomUUID()); }, []);
  const [checkState, checkAction, checking] = useActionState(checkGrIrClearingAction, idle);
  const [postState, postAction, posting] = useActionState(postGrIrClearingAction, idle);
  useRemember(postState);
  const notice = postState.message ? postState : checkState;
  return (
    <form className="space-y-2" data-grir-clear={orderNumber}>
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <input type="hidden" name="itemNumber" value={itemNumber} />
      <input type="hidden" name="keyDate" value={keyDate} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <input type="hidden" name="requestKey" value={key} />
      <input type="hidden" name="category" value="STANDARD" />
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-ink-soft">{postingDateLabel}</span>
          <input name="postingDate" type="date" className="input" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} required />
        </label>
        <label className="min-w-40 flex-1 text-sm">
          <span className="mb-1 block text-ink-soft">{reasonLabel}</span>
          <input name="comment" className="input w-full" value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={100} />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="acknowledge" value="1" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} />
          {acknowledgeLabel}
        </label>
        <button type="submit" formAction={checkAction} formNoValidate className="btn btn-default min-h-11 sm:min-h-8" disabled={!key || checking || posting} data-grir-check>{checking ? checkingLabel : checkLabel}</button>
        <button type="submit" formAction={postAction} className="btn btn-primary min-h-11 sm:min-h-8" disabled={!key || checking || posting} data-grir-post>{posting ? postingLabel : postLabel}</button>
      </div>
      <Notice state={notice} />
    </form>
  );
}

export function ReverseClearingForm({
  documentNumber, fiscalYear, reversalDateLabel, reasonLabel, reverseLabel, reversingLabel,
}: {
  documentNumber: string;
  fiscalYear: number;
  reversalDateLabel: string;
  reasonLabel: string;
  reverseLabel: string;
  reversingLabel: string;
}) {
  const [key, setKey] = useState('');
  const [reversalDate, setReversalDate] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => { setKey(crypto.randomUUID()); }, []);
  const [state, action, reversing] = useActionState(reverseGrIrClearingAction, idle);
  useRemember(state);
  return (
    <form className="flex flex-wrap items-end gap-2" data-grir-reverse={documentNumber}>
      <input type="hidden" name="documentNumber" value={documentNumber} />
      <input type="hidden" name="fiscalYear" value={fiscalYear} />
      <input type="hidden" name="requestKey" value={key} />
      <label className="text-sm">
        <span className="mb-1 block text-ink-soft">{reversalDateLabel}</span>
        <input name="reversalDate" type="date" className="input" value={reversalDate} onChange={(event) => setReversalDate(event.target.value)} required />
      </label>
      <label className="min-w-40 flex-1 text-sm">
        <span className="mb-1 block text-ink-soft">{reasonLabel}</span>
        <input name="comment" className="input w-full" value={comment} onChange={(event) => setComment(event.target.value)} required maxLength={100} />
      </label>
      <button type="submit" formAction={action} className="btn btn-default min-h-11 sm:min-h-8" disabled={!key || reversing} data-grir-reverse-save>{reversing ? reversingLabel : reverseLabel}</button>
      <Notice state={state} />
    </form>
  );
}

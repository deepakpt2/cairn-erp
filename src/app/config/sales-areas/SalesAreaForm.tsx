'use client';

import { useActionState, useRef, useState } from 'react';
import { t } from '@/platform/i18n';
import { saveSalesAreaAction, salesAreaValueHelpAction } from './actions';

interface Choice {
  code: string;
  name: string;
  isActive: boolean;
}

type HelpField = 'salesOrg' | 'distributionChannel' | 'division';

export function SalesAreaForm({ salesOrganizations }: { salesOrganizations: Choice[] }) {
  const [state, action, pending] = useActionState(saveSalesAreaAction, { ok: true });
  const [salesOrgValue, setSalesOrgValue] = useState('');
  const [distributionChannelValue, setDistributionChannelValue] = useState('');
  const [divisionValue, setDivisionValue] = useState('');
  const [channelChoices, setChannelChoices] = useState<Choice[]>([]);
  const [divisionChoices, setDivisionChoices] = useState<Choice[]>([]);
  const [lookupPending, setLookupPending] = useState(false);
  const [lookupMessage, setLookupMessage] = useState('');
  const [helpField, setHelpField] = useState<HelpField | null>(null);
  const [helpSearch, setHelpSearch] = useState('');
  const requestSequence = useRef(0);

  function loadDependentChoices(code: string) {
    const normalized = code.trim().toUpperCase().slice(0, 4);
    setSalesOrgValue(normalized);
    setDistributionChannelValue('');
    setDivisionValue('');
    setChannelChoices([]);
    setDivisionChoices([]);
    setLookupMessage('');
    if (!/^[A-Z0-9]{4}$/.test(normalized)) return;

    const requestId = ++requestSequence.current;
    setLookupPending(true);
    void salesAreaValueHelpAction(normalized)
      .then((result) => {
        if (requestId !== requestSequence.current) return;
        if (!result.ok || !result.choices) {
          setLookupMessage(result.message ?? t('salesArea.valueHelpUnavailable'));
          return;
        }
        setChannelChoices(result.choices.distributionChannels);
        setDivisionChoices(result.choices.divisions);
      })
      .catch(() => {
        if (requestId === requestSequence.current) setLookupMessage(t('salesArea.valueHelpUnavailable'));
      })
      .finally(() => {
        if (requestId === requestSequence.current) setLookupPending(false);
      });
  }

  function openHelp(field: HelpField) {
    if ((field === 'distributionChannel' || field === 'division') && !/^[A-Z0-9]{4}$/.test(salesOrgValue)) return;
    setHelpSearch('');
    setHelpField(field);
  }

  function chooseValue(code: string) {
    if (helpField === 'salesOrg') loadDependentChoices(code);
    if (helpField === 'distributionChannel') setDistributionChannelValue(code);
    if (helpField === 'division') setDivisionValue(code);
    setHelpField(null);
  }

  const visibleChoices = (items: Choice[]) => {
    const search = helpSearch.trim().toLocaleLowerCase();
    return items.filter((item) => `${item.code} ${item.name}`.toLocaleLowerCase().includes(search));
  };
  const helpChoices = helpField === 'salesOrg'
    ? visibleChoices(salesOrganizations)
    : helpField === 'distributionChannel'
      ? visibleChoices(channelChoices)
      : visibleChoices(divisionChoices);
  const helpTitle = helpField === 'salesOrg'
    ? t('salesArea.salesOrgHelpTitle')
    : helpField === 'distributionChannel'
      ? t('salesArea.distributionChannelHelpTitle')
      : t('salesArea.divisionHelpTitle');
  const helpEmpty = helpField === 'salesOrg'
    ? t('salesArea.salesOrgLookupEmpty')
    : helpField === 'distributionChannel'
      ? t('salesArea.distributionChannelLookupEmpty')
      : t('salesArea.divisionLookupEmpty');
  const helpSearchLabel = t('salesArea.valueHelpSearch');

  return (
    <>
      <section className="panel overflow-hidden" aria-labelledby="sales-area-form-title">
        <div className="border-b border-line bg-sunken px-4 py-3">
          <h2 id="sales-area-form-title" className="font-semibold">{t('salesArea.formTitle')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('salesArea.formHint')}</p>
        </div>

        {state.message && (
          <div role={state.ok ? 'status' : 'alert'} className={`mx-3 mt-3 border p-3 text-sm ${state.ok ? 'border-signal-ok/30 bg-signal-ok-soft text-signal-ok' : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}>
            <p>{state.message}</p>
            {state.remedy && <p className="mt-1">{state.remedy}</p>}
          </div>
        )}
        {lookupMessage && <p role="alert" className="mx-3 mt-3 border border-signal-error/30 bg-signal-error-soft p-3 text-sm text-signal-error">{lookupMessage}</p>}

        <form action={action} className="space-y-4 p-3 sm:p-5">
          <input type="hidden" name="mode" value="CREATE" />
          <input type="hidden" name="expectedVersion" value="0" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="ovxg-sales-org" className="field-label">{t('salesArea.salesOrgField')} <span className="text-signal-error" aria-hidden="true">*</span></label>
              <div className="mt-1 flex gap-2">
                <input
                  id="ovxg-sales-org"
                  name="salesOrg"
                  type="text"
                  required
                  minLength={4}
                  maxLength={4}
                  pattern="[A-Z0-9]{4}"
                  title={t('salesArea.fourCharHelp')}
                  autoComplete="off"
                  value={salesOrgValue}
                  onChange={(event) => {
                    const code = event.target.value.toUpperCase().slice(0, 4);
                    if (code.length === 4) loadDependentChoices(code);
                    else {
                      requestSequence.current++;
                      setLookupPending(false);
                      setLookupMessage('');
                      setSalesOrgValue(code);
                      setDistributionChannelValue('');
                      setDivisionValue('');
                      setChannelChoices([]);
                      setDivisionChoices([]);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'F4') { event.preventDefault(); openHelp('salesOrg'); }
                  }}
                  className="field-input code min-h-11 min-w-0 flex-1 uppercase sm:min-h-9"
                  aria-label={t('salesArea.salesOrgField')}
                  disabled={pending || salesOrganizations.length === 0}
                />
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-12 items-center justify-center border border-line bg-sunken px-3 font-mono text-sm font-semibold text-accent hover:bg-white disabled:opacity-50 sm:min-h-9"
                  aria-label={t('salesArea.openSalesOrgHelp')}
                  title={t('salesArea.openSalesOrgHelp')}
                  onClick={() => openHelp('salesOrg')}
                  disabled={pending || salesOrganizations.length === 0}
                >F4</button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{t('salesArea.salesOrgRule')}</p>
            </div>

            <div>
              <label htmlFor="ovxg-distribution-channel" className="field-label">{t('salesArea.distributionChannelField')} <span className="text-signal-error" aria-hidden="true">*</span></label>
              <div className="mt-1 flex gap-2">
                <input
                  id="ovxg-distribution-channel"
                  name="distributionChannel"
                  type="text"
                  required
                  minLength={2}
                  maxLength={2}
                  pattern="[A-Z0-9]{2}"
                  title={t('salesArea.twoCharHelp')}
                  autoComplete="off"
                  value={distributionChannelValue}
                  onChange={(event) => setDistributionChannelValue(event.target.value.toUpperCase().slice(0, 2))}
                  onKeyDown={(event) => {
                    if (event.key === 'F4') { event.preventDefault(); openHelp('distributionChannel'); }
                  }}
                  className="field-input code min-h-11 min-w-0 flex-1 uppercase sm:min-h-9"
                  aria-label={t('salesArea.distributionChannelField')}
                  disabled={pending || lookupPending || channelChoices.length === 0}
                />
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-12 items-center justify-center border border-line bg-sunken px-3 font-mono text-sm font-semibold text-accent hover:bg-white disabled:opacity-50 sm:min-h-9"
                  aria-label={t('salesArea.openDistributionChannelHelp')}
                  title={t('salesArea.openDistributionChannelHelp')}
                  onClick={() => openHelp('distributionChannel')}
                  disabled={pending || lookupPending || channelChoices.length === 0}
                >F4</button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{t('salesArea.distributionChannelRule')}</p>
            </div>

            <div>
              <label htmlFor="ovxg-division" className="field-label">{t('salesArea.divisionField')} <span className="text-signal-error" aria-hidden="true">*</span></label>
              <div className="mt-1 flex gap-2">
                <input
                  id="ovxg-division"
                  name="division"
                  type="text"
                  required
                  minLength={2}
                  maxLength={2}
                  pattern="[A-Z0-9]{2}"
                  title={t('salesArea.twoCharHelp')}
                  autoComplete="off"
                  value={divisionValue}
                  onChange={(event) => setDivisionValue(event.target.value.toUpperCase().slice(0, 2))}
                  onKeyDown={(event) => {
                    if (event.key === 'F4') { event.preventDefault(); openHelp('division'); }
                  }}
                  className="field-input code min-h-11 min-w-0 flex-1 uppercase sm:min-h-9"
                  aria-label={t('salesArea.divisionField')}
                  disabled={pending || lookupPending || divisionChoices.length === 0}
                />
                <button
                  type="button"
                  className="inline-flex min-h-11 min-w-12 items-center justify-center border border-line bg-sunken px-3 font-mono text-sm font-semibold text-accent hover:bg-white disabled:opacity-50 sm:min-h-9"
                  aria-label={t('salesArea.openDivisionHelp')}
                  title={t('salesArea.openDivisionHelp')}
                  onClick={() => openHelp('division')}
                  disabled={pending || lookupPending || divisionChoices.length === 0}
                >F4</button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{t('salesArea.divisionRule')}</p>
            </div>

            <div>
              <label htmlFor="ovxg-name" className="field-label">{t('salesArea.nameField')} <span className="text-signal-error" aria-hidden="true">*</span></label>
              <input
                id="ovxg-name"
                name="name"
                type="text"
                required
                minLength={1}
                maxLength={160}
                autoComplete="off"
                placeholder={t('salesArea.namePlaceholder')}
                className="field-input mt-1 min-h-11 w-full sm:min-h-9"
                disabled={pending}
              />
              <p className="mt-1 text-xs text-ink-faint">{t('salesArea.nameRule')}</p>
            </div>
          </div>

          {salesOrganizations.length === 0 && <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">{t('salesArea.noSalesOrganizations')}</p>}
          {salesOrgValue && !lookupPending && channelChoices.length === 0 && <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">{t('salesArea.noLinkedChannels')}</p>}
          {salesOrgValue && !lookupPending && divisionChoices.length === 0 && <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">{t('salesArea.noLinkedDivisions')}</p>}
          {lookupPending && <p role="status" className="text-sm text-ink-soft">{t('salesArea.loadingLookups')}</p>}

          <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-3xl text-xs text-ink-soft">{t('salesArea.assignmentRule')}</p>
            <button type="submit" className="btn btn-primary min-h-11 w-full sm:min-h-9 sm:w-auto" disabled={pending || lookupPending || channelChoices.length === 0 || divisionChoices.length === 0}>
              {pending ? t('common.saving') : t('salesArea.createButton')}
            </button>
          </div>
        </form>
      </section>

      {helpField && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={() => setHelpField(null)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="ovxg-value-help-title"
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto border border-[#8faabd] bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === 'Escape') setHelpField(null); }}
          >
            <header className="flex items-center gap-3 border-b border-[#9eb6c8] bg-[#c9dce9] px-4 py-3 text-[#28445b]">
              <h2 id="ovxg-value-help-title" className="min-w-0 flex-1 font-semibold">{helpTitle}</h2>
              <button type="button" className="inline-flex h-11 w-11 shrink-0 items-center justify-center border border-[#8faabd] bg-white text-lg hover:bg-[#eef3f7] sm:h-9 sm:w-9" aria-label={t('common.close')} onClick={() => setHelpField(null)}>×</button>
            </header>
            <div className="border-b border-[#d6dce1] bg-[#eef3f7] p-3">
              <label htmlFor="ovxg-value-help-search" className="field-label">{helpSearchLabel}</label>
              <input id="ovxg-value-help-search" type="search" className="field-input mt-1 min-h-11 w-full sm:min-h-9" value={helpSearch} autoFocus onChange={(event) => setHelpSearch(event.target.value)} />
            </div>
            {helpChoices.length ? (
              <ul className="divide-y divide-[#d6dce1]">
                {helpChoices.map((item) => (
                  <li key={item.code}>
                    <button type="button" className="flex min-h-14 w-full flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-[#f4f8fa]" onClick={() => chooseValue(item.code)}>
                      <span className="code w-20 shrink-0 font-semibold">{item.code}</span>
                      <span className="min-w-0 flex-1 break-words text-sm">{item.name}</span>
                      <span className={`chip ${item.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(item.isActive ? 'salesArea.active' : 'salesArea.inactive')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="p-5 text-center text-sm text-ink-soft">{helpEmpty}</p>
            )}
            <footer className="flex justify-end border-t border-[#d6dce1] p-3">
              <button type="button" className="btn btn-default min-h-11 sm:min-h-9" onClick={() => setHelpField(null)}>{t('common.cancel')}</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

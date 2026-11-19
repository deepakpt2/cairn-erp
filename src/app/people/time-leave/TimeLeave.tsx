'use client';

import Link from 'next/link';

import type { AccrualStatus } from '@/modules/people/leave-accrual';
import type { ExportView } from '@/modules/people/leave-export';
import type { LeaveReport } from '@/modules/people/leave-report';
import type { AbsenceRow, PickerEmployee, TimeRecordRow } from '@/modules/people/leave-views';
import type { TimeTypeView } from '@/modules/people/time-leave';
import AbsencesTab from './AbsencesTab';
import BalancesTab from './BalancesTab';
import TimeRecordsTab from './TimeRecordsTab';

export type Tab = 'absences' | 'time' | 'balances';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'absences', label: 'Absences' }, { id: 'time', label: 'Time records' }, { id: 'balances', label: 'Leave balances' },
];

interface Props {
  tab: Tab; today: string; year: number;
  caps: { enter: boolean; approve: boolean; adjust: boolean; view: boolean; exportCsv: boolean; accrue: boolean };
  params: { q?: string; status?: string; emp?: string; employees?: string; group?: string; year?: string; asOf?: string };
  timeTypes: TimeTypeView[]; employees: PickerEmployee[]; absences: AbsenceRow[]; times: TimeRecordRow[];
  report: LeaveReport | null; accrual: AccrualStatus | null; exportsList: ExportView[]; groups: Array<{ code: string; name: string }>;
  errors: string[];
}

export default function TimeLeave(p: Props) {
  return (
    <div className="space-y-4">
      <nav role="tablist" aria-label="Time and leave" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <Link key={t.id} role="tab" aria-selected={p.tab === t.id} href={`/people/time-leave?tab=${t.id}`}
            className={`px-3 py-2 text-sm ${p.tab === t.id ? 'border-b-2 border-accent font-semibold' : 'text-ink-soft'}`}>{t.label}</Link>
        ))}
      </nav>
      {p.errors.map((e) => <p key={e} className="panel panel-danger p-3 text-sm" role="alert">{e}</p>)}
      {p.tab === 'absences' ? <AbsencesTab absences={p.absences} types={p.timeTypes} employees={p.employees} caps={p.caps} params={p.params} /> : null}
      {p.tab === 'time' ? <TimeRecordsTab times={p.times} types={p.timeTypes} employees={p.employees} canEnter={p.caps.enter} params={p.params} /> : null}
      {p.tab === 'balances' ? (
        <BalancesTab report={p.report} employees={p.employees} groups={p.groups} params={p.params} caps={p.caps}
          types={p.timeTypes} accrual={p.accrual} exportsList={p.exportsList} today={p.today} year={p.year} />
      ) : null}
    </div>
  );
}

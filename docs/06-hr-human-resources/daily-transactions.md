# HR — Daily Transactions

Hiring, moving, leave, and the monthly payroll cycle. Sample data: company code `1000`, employee `10000002`, position `P2110` Production Clerk, cost centre `CC2000`, structure `STAFF`, time types `ANNUAL`, `SICK`, `UNPAID`.

## Table of Contents

- [1. Hire and assign an employee](#1-hire-and-assign-an-employee)
- [2. Time and leave](#2-time-and-leave)
- [3. Payroll](#3-payroll)
- [4. End an employment](#4-end-an-employment)

> [!IMPORTANT]
> **Prerequisites**
> - [HR master data](master-data.md) is in place: organisation, cost centres, pay structure, pay-component mappings.
> - Your capability and tier fit the act. You can never act on an employee whose tier equals or exceeds yours.
> - For payroll posting you also need finance posting authority and an open posting period ([FICO](../05-fico-finance-controlling/master-data.md#7-document-types-number-ranges-and-posting-periods)).

---

## 1. Hire and assign an employee

1. **Request the hire** at `/people/employees` → **Request a hire**: **Personnel number** `10000010`, **Name** `Fatima Al-Rashid`, **Position** `P2110 · Production Clerk · tier …`, **Plant** `1000`. Click **Request a hire**.
2. **Approve it**: a different user with a higher tier opens the employee under **Awaiting approval** and clicks **Approve hire** (or **Reject**).
3. **Start an assignment** at `/people/assignments`: **Personnel number** `10000010`, **First day it applies** `2026-12-01`, **Position** `P2110`, **Controlling area** and **Cost centre** `CC2000`, **Plant** `1000` → **Start an assignment**.
4. **Assign a pay structure** at `/people/employees` → **Pay structure**: **Structure** `STAFF`, **Base amount** `450.000`, **Currency** `KWD`, **Valid from** `2026-12-01` → **Assign structure**.
5. Optional: add **Recurring pay components** (for example a transport allowance with **Fixed amount per payroll period**).
6. Optional: link the sign-in user under **Linked user**.

> [!NOTE]
> **What Happens in the Background?**
> - Steps 1–2 create the employee in a *pending* state, then active. **No accounting is posted** and no stock is touched.
> - The assignment places the person in the organisation and decides the company and cost centre payroll uses.
> - The pay structure and base amount are dated records; payroll reads whatever covers each day of the period.
> - Every record is kept as history; "Written by" records who made it.

| Refusal | Fix |
|---|---|
| Your tier is not above the employee's | Ask a person of higher tier |
| You approved your own request | A different approver must approve |
| "A retired position takes no new assignment" | Use an active position |
| Cost centre not found as of the first day | Create or correct the cost centre, controlling area, or date |
| "The plant has to belong to the cost centre's company" | Fix the plant |
| Date overlaps another record of the same type | End the earlier record first, or choose a later start |

---

## 2. Time and leave

**HR – People → Time & leave** (`/people/time-leave`). Tabs: **Time records**, **Absences**, **Balances**. Each shows only employees inside your scope.

### 2.1 Request leave

1. On **Absences** open **Request an absence**.
2. Choose the **Employee** (search by number or name) and **Time type** (`ANNUAL`), then **From** `2026-12-14` and **To** `2026-12-18`, and a **Reason**.
3. Click **Preview**. The preview shows **Days**, **Charged to** (which balance) and **Pay**: if some days exceed the earned balance, those days are charged to the fallback (for example `UNPAID`) and shown as unpaid.
4. If any day is unpaid you must tick the box and enter the **unpaid days to accept**, then submit the request.
5. A manager approves in the **Decide** column: **Approve** or **Reject** (with note); the requester can **Cancel**.

> [!NOTE]
> **What Happens in the Background?**
> - Status moves **REQUESTED → APPROVED / REJECTED / CANCELLED**.
> - For a **policy-managed** employee, approval charges the days to the leave ledger under a per-employee lock (so two leaves can never spend the same day). A day counts as covered only by a **whole day of balance already earned**: credits count up to today in the tenant time zone; no future month funds a request.
> - For an employee with **no policy**, the legacy rule applies: a hand-set quota and the time type's paid flag. The screen then says "No leave policy governs this request: the legacy rules apply and no split is made."
> - Approved **unpaid** leave reduces pay in the next payroll run (days the person is paid).
> - Nothing is posted to accounting by leave itself.

### 2.2 Record time

On **Time records**: **Employee**, **Time type** (attendance or overtime), **Date** (`recordingDate`), **Hours**. Only **absences** reduce a leave balance; attendance and overtime records do not.

### 2.3 Balances, accrual and export

On **Balances**: choose employees or a leave group, **Year**, and click **Show balances**. Columns: **Policy, Annual target, Opening, Accrued, Granted, Adjusted, Taken, Expired, Available, Pending (not reserved), Last / next credit**. A ledger view lists **Effective, Kind, Amount, Running total, Absence, Recorded, Note**.

- **Adjustments**: a signed number of days (for example `-1.5`) can be entered against a balance and is kept in the ledger as **Adjusted**.
- **Run catch-up now**: credits every month that is complete and due. Running it again credits nothing twice; a catch-up posts exactly what an on-time run would have. **Backfill from assignment start (intensive)** back-fills from the first assignment.
- **Year-end**: the unused balance of a completed year is written off once as **Expired**; there is **no carry-over**.
- **Download CSV** (needs capability `PEOPLE.LEAVE.EXPORT`); a large export runs in the background and appears under **Download**.

---

## 3. Payroll

**HR – People → Payroll runs** (`/people/payroll-runs`). One run = **one company code and one fiscal period**.

### 3.1 Propose a run

1. Under **Propose a run**: **Company code** `1000`, **Fiscal year** `2026`, **Period** `11`. Click **Propose**.
2. The run opens as **PROPOSED**. Read the **Run** summary: **Employees, Exceptions, Days in period, Currency, Gross, Deductions, Net pay, Employer cost**.
3. Read **Exceptions**: any employee who cannot be calculated is **named, not dropped**, with **Reason**, **What stands in the way** and **Remedy** (for example "No pay structure stands for employee … Assign a pay structure", "Component … is not mapped to an account", "holds no position covering the period").
4. Fix the data, then click **Recalculate**.

### 3.2 One-time adjustments (optional)

**Enter adjustment**: **Company**, **Fiscal year**, **Period**, **Employee (personnel number)**, **Pay component**, **Amount (payroll currency, fixed, positive)**, **Reason (required)**, **Source reference** (optional), **Corrects result** (optional result id of an earlier period). Someone else must **Approve** (or **Reject**, note required): "You entered this; someone else must approve it." A correction is always a new adjustment in a later period; nothing retroactive is changed.

### 3.3 Release

When there are **no exceptions**, click **Release**. A run with exceptions cannot be released; a calculation out of date shows "recalculate before release". After release the results are **frozen**: never recalculated.

### 3.4 Post to the ledger

Click **Post to G/L** (needs `PEOPLE.PAYROLL.POST` and `FIN.JOURNAL.POST`). It runs in the background: nothing posts until it finishes, then it is **one document or none**.

> [!NOTE]
> **What Happens in the Background?**
> - **One document per run**, type `PR`, dated the **last day of the period**, built from the frozen results (not re-read from configuration).
> - **Debits:** earnings and employer contributions, each on the employee's snapshotted **cost centre**.
> - **Credits:** deductions, employer-contribution payables and **net pay payable** (the account comes from account determination event `PAYROLL_NET_PAY`), with no cost centre.
> - Lines are grouped by account, cost centre and component. A **posted run cannot be cancelled or posted again**.

### 3.5 Pay salaries

After posting, **Pay salaries**: **Payment date**, **Pay from** (the house bank and account; maintain them at `/config/house-banks`), then **Pay**.

> [!NOTE]
> **What Happens in the Background?** Type `PY`: **one debit per employee** with positive net pay on the net-pay payable account, **one credit** to the house bank's G/L account. The amount is reconciled against the posted document's uncleared net-pay credit first, so you pay **what was posted**, not what is calculated; a determination changed after posting is refused rather than paid around. The PR document's net-pay credit and the PY debits are stamped cleared together. Employees are not business partners, so no line carries a partner.

### 3.6 Cancel a run

Before posting, use **Cancel run** with a **Reason for cancelling**; this frees the period for a new proposal.

---

## 4. End an employment

1. `/people/assignments`: select the employee's standing assignment → **End it** → **Last day it applies** `2026-12-31` (inclusive).
2. `/people/employees`: **End record** on the pay structure assignment with the same last day.
3. If the person has a **Linked user**, tell your administrator so the sign-in can be reviewed.

> [!NOTE]
> **What Happens in the Background?** Nothing is deleted. Payroll for the final period counts only the days the person still holds a position, and leave policy entitlement is **clipped to the employment span**. An inactive employee, or one without a resolvable employment, receives no leave credit and is reported.

---

**← Previous** [HR master data](master-data.md) · **Next →** [HR reports and troubleshooting](reports-and-troubleshooting.md)

# HR — Reports and Troubleshooting

How to read people, leave and payroll data, and what to do when an HR step is refused.

## Table of Contents

- [Who and where](#who-and-where)
- [Leave reports](#leave-reports)
- [Payroll results: the pay slips](#payroll-results-the-pay-slips)
- [Common messages and what to do](#common-messages-and-what-to-do)
- [Checklist: "why is this employee not in the payroll run?"](#checklist-why-is-this-employee-not-in-the-payroll-run)

> [!IMPORTANT]
> **Prerequisites**
> - You hold the display capability for the screen. HR data is the most restricted in the system: you see only employees **inside your scope** (your plant for an HR clerk, your company for an HR officer). Others are simply not shown.
> - For payroll results you hold the payroll display capability.

> [!NOTE]
> **What Happens in the Background?** Reports post nothing and change nothing. Payroll results are frozen snapshots; leave balances are read from the leave ledger, which is append-only.

## Who and where

| Screen | Route | Shows |
|---|---|---|
| **Employees** | `/people/employees` | The employee, every dated record with **current** value, pay structure and recurring components, and the approval state |
| **Assignments** | `/people/assignments` | **Standing now** and **Assignment history** (**From, To, Position, Unit, Cost centre, Written by**); search by employee or position, with an **open** filter for assignments still running |
| **Organisation** | `/people/organization` | Unit tree, jobs, positions, who holds each position *today* ("nobody today" for a vacancy) |
| **Authority** | `/people/authority` | Your reporting line and, for a person, what they hold and have delegated |

## Leave reports

**Time & leave → Balances** (`/people/time-leave`).

| Column | Meaning |
|---|---|
| **Policy** | The leave policy that governs the person |
| **Annual target** | Days a year the policy grants |
| **Opening** | Balance carried in |
| **Accrued** | Credited so far this year (month by month, once each month is complete) |
| **Granted**, **Adjusted** | One-off grants and corrections |
| **Taken** | Approved leave |
| **Expired** | Unused balance written off at year end (no carry-over) |
| **Available** | What a request can use today |
| **Pending (not reserved)** | Requested leave not yet approved; it does not hold a balance |
| **Last / next credit** | When the accrual last ran and when it is next due |

Year-end preview: **Year**, **Entitlement**, **Remaining → opening**, **Blocker**. "Everything due has been processed." means no catch-up is needed.

**Partial results:** the screen says "Partial: the selection was cut at the report limit. Use the background export for the full list." Narrow the selection, or use **Download CSV** (needs `PEOPLE.LEAVE.EXPORT`); exports appear under **Download**.

**Absences** tab: filter by status (**REQUESTED, APPROVED, REJECTED, CANCELLED**) and employee; columns **Employee, Type, Dates, Days, Charged to, Pay, Status, Split, Decide**.

## Payroll results: the pay slips

**HR – People → Payroll results** (`/people/payroll-results`). Choose a **Run**, optionally a **Personnel number**, and click **Show**.

| Section | Columns |
|---|---|
| Employees in the run | **Employee, Name, Days paid, Unpaid leave, Gross, Deductions, Net, Employer cost, Cost centre** |
| One employee's slip (click to open, **Close** to hide) | Per line: **Segment** (a stretch of days with its own rule, base and cost centre), **Days**, **Component**, **Kind**, **Source**, **Rule and basis**, **Amount**, **Cost receiver** |

For a run that is not posted the screen says "Not posted yet: each slip shows the accounts its lines will post to." Totals are sums of the lines, each rounded once to the currency's decimals, so a slip always adds up.

On `/people/payroll-runs`, **Open the results of this run** goes straight to the slips, and the **Runs** table shows **Dates, Status, Net**. Statuses: **PROPOSED → RELEASED → POSTED**, or **CANCELLED**.

## Common messages and what to do

| Message (shortened) | Cause | What to do |
|---|---|---|
| "You do not hold …" / "This session lacks the authority for this form." | Missing capability | Ask the administrator ([roles](../01-getting-started/login-and-roles.md#roles-authorities-and-scope)) |
| Action refused because of **tier** | The employee's tier equals or exceeds yours | A person of higher tier must do it |
| "…approving needs PEOPLE.EMPLOYEE.APPROVE" | Approver lacks the capability | Use an approver |
| "Employee … holds no position covering the period …" | No assignment for the period | Assign a position at `/people/assignments` |
| "…position … names no company code, and its cost centre … resolves to none…" | Assignment cost centre has no company | Correct the cost centre / controlling area |
| "No pay structure stands for employee … on …" | No structure assigned | Assign one at `/people/employees` |
| "Two pay structures cover employee … on …" | Overlap | **End** one of them |
| "Structure … is not valid for the whole period" | Retired or dated out | Extend or choose another structure |
| "Structure … names no components" | Empty structure | Add components at `/people/salary-structures` |
| "…names end-of-service provision component …; a payroll run does not calculate end-of-service provisions yet" | Unsupported component | Remove it from the structure |
| "Component … is not mapped to an account in chart …" | No mapping | Map it at `/config/pay-components` |
| "Component … charges to the employee's cost centre, and employee … has none" | Assignment has no cost centre | Give the assignment a cost centre |
| Run cannot be released | Exceptions exist | Fix each, then **Recalculate** |
| "The calculation is out of date: recalculate before release." | Data changed after proposal | **Recalculate** |
| "A posted run cannot be cancelled or posted again." | Already posted | Correct in a later period with an adjustment |
| "You entered this; someone else must approve it." | Four-eyes rule | Another user approves the adjustment |
| Posting refused: period closed | Posting period not open | [Open it](../05-fico-finance-controlling/master-data.md#7-document-types-number-ranges-and-posting-periods) |
| Pay salaries refused: determination changed | Net-pay account differs from the posted document | Restore the determination, or have finance review |
| "No leave policy governs this request: the legacy rules apply" | Employee has no policy | Informational; assign a policy for ledger-based leave |
| "A retired position takes no new assignment" | Position retired | Use an active one |
| "Code … cannot be reused once defined" | Unit code taken | Choose a new code |
| Record "overlaps" another | Dated record already covers those days | End the older record first |

## Checklist: "why is this employee not in the payroll run?"

1. Open the run and look at **Exceptions**: an employee who cannot be calculated is listed with the reason, never silently dropped.
2. **Hire approved?** A pending hire is not in use.
3. **Assignment** covers the whole period and names a company and cost centre.
4. **Pay structure** assigned, valid for the whole period, with components, none of them end-of-service.
5. **Mappings** exist for every component in the company's chart.
6. Fix the data and **Recalculate**.
7. Give the personnel number and the exact message to your administrator.

---

**← Previous** [HR daily transactions](daily-transactions.md) · **Next →** [End-to-end workflows: procure to pay](../07-end-to-end-workflows/procure-to-pay.md)

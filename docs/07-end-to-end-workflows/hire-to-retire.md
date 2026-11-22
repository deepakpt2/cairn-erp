# Workflow: Hire to Retire

From "we are hiring a production clerk" to "their last payslip and their record closed".

## Table of Contents

- [The story](#the-story)
- [The whole flow at a glance](#the-whole-flow-at-a-glance)
- [Step 1 — Organisation and pay set up](#step-1--organisation-and-pay-set-up)
- [Step 2 — Hire and approve](#step-2--hire-and-approve)
- [Step 3 — Assign position and pay](#step-3--assign-position-and-pay)
- [Step 4 — Time and leave through the year](#step-4--time-and-leave-through-the-year)
- [Step 5 — Monthly payroll](#step-5--monthly-payroll)
- [Step 6 — Changes during employment](#step-6--changes-during-employment)
- [Step 7 — Retire](#step-7--retire)
- [Step 8 — Check the result](#step-8--check-the-result)
- [What can go wrong, and where to look](#what-can-go-wrong-and-where-to-look)

> [!IMPORTANT]
> **Prerequisites**
> - Organisation: unit, job and position `P2110` Production Clerk ([HR master data](../06-hr-human-resources/master-data.md#3-the-organisation-units-jobs-positions)); cost centre `CC2000` ([FICO](../05-fico-finance-controlling/master-data.md#4-cost-centres-and-profit-centres)); salary structure `STAFF` and pay-component account mappings ([pay](../06-hr-human-resources/master-data.md#5-pay-structures-and-pay-components)); leave policy ([policies](../06-hr-human-resources/master-data.md#6-time-types-and-leave-policies)).
> - Roles: an **HR clerk** (hires, assigns), a **higher-tier approver**, a **manager** (approves leave), a **payroll accountant** (needs finance posting authority too).
> - An open posting period for payroll posting.

## The story

Fatima Al-Rashid joins as a production clerk on 1 December 2026, takes leave, is paid monthly, and leaves on 31 December 2027.

## The whole flow at a glance

| # | Step | Screen | Books |
|---|---|---|---|
| 2 | Request hire, approve | `/people/employees` | — |
| 3 | Assignment + pay structure | `/people/assignments`, `/people/employees` | — |
| 4 | Leave, time | `/people/time-leave` | — |
| 5 | Payroll: propose → release → post → pay | `/people/payroll-runs` | **PR** (Dr expenses / Cr payables, net pay) then **PY** (Dr net pay payable / Cr bank) |
| 7 | End assignment and records | `/people/assignments`, `/people/employees` | — |

Only payroll touches the books.

## Step 1 — Organisation and pay set up

Done once, before hiring. See the checklist [ready to run payroll?](../06-hr-human-resources/master-data.md#checklist-ready-to-run-payroll).

## Step 2 — Hire and approve

The HR clerk uses **Request a hire**: **Personnel number** `10000010`, **Name**, **Position** `P2110`, **Plant** `1000`. A different, **higher-tier** user then clicks **Approve hire**. Instructions: [Hire and assign](../06-hr-human-resources/daily-transactions.md#1-hire-and-assign-an-employee).

> [!NOTE]
> **What Happens in the Background?** The person exists as *pending* and cannot be assigned or paid. You cannot approve your own request, and nobody acts on a person of equal or higher tier. No accounting posts.

## Step 3 — Assign position and pay

1. **Start an assignment**: position `P2110`, controlling area and cost centre `CC2000`, plant `1000`, **First day it applies** `2026-12-01`.
2. **Assign structure** `STAFF` with **Base amount** `450.000` KWD from the same date. Add any **recurring pay components**.

> [!NOTE]
> **What Happens in the Background?** The assignment decides the **company** the person is paid in and the **cost centre** their pay is charged to; the structure decides **what** they earn. Both are dated records: history is never overwritten.

## Step 4 — Time and leave through the year

The employee (or HR) [requests leave](../06-hr-human-resources/daily-transactions.md#21-request-leave) after **Preview**; the manager **Approve**s. Balances are credited month by month under the leave policy.

> [!NOTE]
> **What Happens in the Background?** Approved leave is charged to the earned balance; days beyond it fall to the fallback type (for example unpaid) and reduce that month's pay. Unused leave of a completed year **expires** (no carry-over). Nothing posts to accounting by itself.

## Step 5 — Monthly payroll

For each period: [Propose a run](../06-hr-human-resources/daily-transactions.md#31-propose-a-run) (company `1000`, year, period) → clear **Exceptions** and **Recalculate** → [Release](../06-hr-human-resources/daily-transactions.md#33-release) → [Post to G/L](../06-hr-human-resources/daily-transactions.md#34-post-to-the-ledger) → [Pay salaries](../06-hr-human-resources/daily-transactions.md#35-pay-salaries).

> [!NOTE]
> **What Happens in the Background?**
> - **Proposal and release post nothing.** Released results are frozen; corrections are one-time adjustments in a later period, approved by someone else.
> - **Post to G/L:** one `PR` document dated the last day of the period. **Dr** earnings and employer contributions on the employee's cost centre / **Cr** deductions, contribution payables and **net pay payable**.
> - **Pay salaries:** a `PY` document: **Dr** net pay payable per employee / **Cr** the house bank account. It pays exactly what was posted.
> - **Generic salary payment file:** a CSV working file (not a bank format) downloaded from a posted run; you convert and upload it yourself. The ERP does not send it to the bank, and creating/downloading it posts nothing and marks no salary paid.
> - No tax, social insurance or country leave law is built in.

## Step 6 — Changes during employment

| Change | Do this |
|---|---|
| Promotion or transfer | **Start an assignment** from the new date (the old one ends the day before); the earlier cost centre stays on earlier periods |
| Raise | Assign the new structure/base amount from the effective date, ending the previous one |
| Fix a typo in the open record | **Correct it (values only)** |
| Extra monthly allowance | **Recurring pay component** with a reason |

## Step 7 — Retire

[End the employment](../06-hr-human-resources/daily-transactions.md#4-end-an-employment): **End it** on the assignment with **Last day it applies** `2027-12-31`, **End** the pay-structure assignment on the same day, and tell your administrator about the linked sign-in. Run the final payroll for the last period.

> [!NOTE]
> **What Happens in the Background?** Nothing is deleted. The final run counts only the days a position is held. Leave entitlement is clipped to the employment span and an inactive employee gets no further credit.

## Step 8 — Check the result

| Question | Where |
|---|---|
| Was everyone paid? | [Payroll results](../06-hr-human-resources/reports-and-troubleshooting.md#payroll-results-the-pay-slips) |
| Did payroll reach the ledger? | [G/L line items](../05-fico-finance-controlling/reports-and-troubleshooting.md#ledger-reports), document type `PR` |
| What is left of the leave? | [Leave reports](../06-hr-human-resources/reports-and-troubleshooting.md#leave-reports) |
| Was the person's history kept? | [Assignment history](../06-hr-human-resources/reports-and-troubleshooting.md#who-and-where) |

## What can go wrong, and where to look

| Symptom | Cause | Where |
|---|---|---|
| Employee missing from the run | No position, no structure, unmapped component | [Checklist](../06-hr-human-resources/reports-and-troubleshooting.md#checklist-why-is-this-employee-not-in-the-payroll-run) |
| Cannot approve a hire | Your own request, or tier too low | [Overview](../06-hr-human-resources/overview.md#key-ideas-in-plain-words) |
| Run cannot be released | Exceptions remain | [Messages](../06-hr-human-resources/reports-and-troubleshooting.md#common-messages-and-what-to-do) |
| Posting refused | Period closed | [Posting periods](../05-fico-finance-controlling/master-data.md#7-document-types-number-ranges-and-posting-periods) |

---

**← Previous** [Order to cash](order-to-cash.md) · **Next →** [Back to the documentation index](../README.md)

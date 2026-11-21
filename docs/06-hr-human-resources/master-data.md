# HR — Master Data

The records HR depends on: employees, their assignments, the organisation, authority, pay structures, time types and leave policies.

## Table of Contents

- [1. Employees](#1-employees)
- [2. Assignments](#2-assignments)
- [3. The organisation: units, jobs, positions](#3-the-organisation-units-jobs-positions)
- [4. Authority and delegation](#4-authority-and-delegation)
- [5. Pay structures and pay components](#5-pay-structures-and-pay-components)
- [6. Time types and leave policies](#6-time-types-and-leave-policies)
- [7. Employee record types](#7-employee-record-types)
- [Checklist: ready to run payroll?](#checklist-ready-to-run-payroll)

> [!IMPORTANT]
> **Prerequisites**
> - [Login and roles](../01-getting-started/login-and-roles.md#roles-authorities-and-scope) read: HR clerks work within a plant, HR officers company-wide.
> - Cost centres exist ([FICO master data](../05-fico-finance-controlling/master-data.md#4-cost-centres-and-profit-centres)).
> - For anything about a person you also need a **tier above theirs** ([overview](overview.md#key-ideas-in-plain-words)).

> [!NOTE]
> **Dated records.** Nothing in HR is overwritten or deleted. A change is a new record with a start date, covering its span inclusively; writing over days another record of the same type already covers is refused, naming the record in the way. You may **end** the newest open record, or **correct its values** while it is still open.

## 1. Employees

**HR – People → Employees** (`/people/employees`, alias **PA30**). Search by number or name with **Search**.

### Request a hire

| Field | Meaning | Required |
|---|---|---|
| **Personnel number** | Yours to choose (max 20); no number range is drawn, so a payroll provider's numbering carries over | **Yes** |
| **Name as the contract writes it** | Full name (max 60) | **Yes** |
| **Position** | Choose from the list `code · title · tier n`; its tier decides who may add and approve | **Yes** |
| **Plant** | Max 4; blank = company-wide. Plant clerks must name their own plant | Optional (mandatory for plant clerks) |

Click **Request a hire**. The person is **not in use** until an approver with a higher tier approves.

**Approve:** under **Awaiting approval**, an approver (capability `PEOPLE.EMPLOYEE.APPROVE`, tier above the new employee's) clicks **Approve hire** or **Reject**. You cannot approve your own request.

### Change the master data

Select an employee. **Change the master** shows the answers each record type holds, with **current**, a **→** to the new value, and:

- **Write a record**: a new dated record of a chosen record type (see [record types](#7-employee-record-types)).
- **Correct record values**: change the values of the record still open (*leaving a box empty keeps the answer it holds today*).
- **End record**: enter the **Last day** (e.g. `2026-10-31`) and click **End**.

**Linked user**: connects the employee to a sign-in username. This is the *only* link, and it is what gives that user a tier.

### Pay structure and recurring components

On the same page:

1. **Pay structure** → choose a **Structure** (`STAFF`), **Base amount**, **Currency**, **Valid from**, optional **Valid to (optional, last day)** → **Assign structure**. This is what the person earns as basic pay.
2. **Recurring pay components** — employee-specific lines: choose the **Pay component**, **Relation to the salary structure** (**Add — a separate line beside the structure** or **Replace — suppress this component's structure rule**), **Calculation** (**Fixed amount per payroll period** or **Percent of the employee's assigned base salary**), **Value** (amount, or percent 0–100), **Proration** (**Payable calendar days (less approved unpaid leave)**, **Covered days, unpaid leave not deducted**, **Full period, applied once**), **Reason (required)**; click **Add component**. **Withdraw** with a reason.

> [!NOTE]
> **What Happens in the Background?** A hire creates a *pending* employee, not yet usable in assignments or payroll. Approval makes the person active. Nothing is posted to accounting. Assigning a structure creates a dated record; a second structure overlapping the first is refused until one is ended.

## 2. Assignments

**HR – People → Assignments** (`/people/assignments`). An assignment says *which position the employee holds, whose cost centre carries them, and from when to when*.

**Start an assignment** (sample: personnel number `10000002` → position `P2110 Production Clerk`, cost centre `CC2000`, plant `1000`)

| Field | Notes | Required |
|---|---|---|
| **Personnel number** | | **Yes** |
| **First day it applies** | | **Yes** |
| **Position** | Not retired: "A retired position takes no new assignment" | **Yes** |
| **Controlling area** + **Cost centre** | Four characters + cost centre; checked against the cost-centre master on the first day | Together, required |
| **Plant** | Where the person works; blank = company-wide; must belong to the cost centre's company | Optional |

Then **Start an assignment**. The screen **Standing now** shows the current one and the **Assignment history** (**From, To, Position, Unit, Cost centre, Written by**).

- **End it**: **Last day it applies** (inclusive).
- **Correct it (values only)**: change position, controlling area, cost centre or plant of the assignment still open; **blank leaves a value as it is**. Dates cannot be moved.

> [!NOTE]
> **What Happens in the Background?** The assignment decides the **company** an employee is paid in and the **cost centre** their pay is charged to. Payroll proration counts the days the person holds a position in the run's company. Moving a person is a new row, so earlier periods keep their old cost centre.

## 3. The organisation: units, jobs, positions

**HR – People → Organisation** (`/people/organization`). Tabs: **Units**, **Jobs**, **Positions**; search by code or name.

- **Define a unit**: **Code** (one to ten characters, starts with a letter, **cannot be reused once defined**), **Name**, **Description** (max 200) and a parent unit.
- **Define a job**: **Code**, **Name**, **Description**.
- **Define a position**: **Code**, **Title**, **Description**, **Unit** ("a position always stands in a unit"), job, the **superior position** it reports to, **Tier (1–9)** — the authority tier of whoever holds it.

Each object has a status: **Valid — new objects may be filed under it** or **Retired — nothing new, but what stands keeps standing**. Select an object to see **Units below**, **Positions in this unit** (who holds them *today*, or "nobody today") and **Assignments naming this position**.

> [!NOTE]
> **What Happens in the Background?** The tree has one answer: a unit has one parent and a position one unit. **No rings** (a unit cannot sit under itself) and a maximum depth is enforced. Moving a unit rewrites its single parent row.

## 4. Authority and delegation

**HR – People → Authority** (`/people/authority`) is a read screen. You see **your own reporting line and nobody else's**: **Name, Position, Grants**. Pick a person to read:

- **Where they stand**: position, title, org unit.
- **What they hold**: **Capability**, **Source**, **Via**, **Level**, **Values**, **Until**.
- **Delegated to them** / **What they have delegated away** / **Pending acceptance**.

Delegation is an *agreement*, not a copy: the delegate's authority is derived from the delegator's at every check, so it can never outlive the original and revoking takes effect at once. It needs the chain of command's approval and both parties' acceptance.

## 5. Pay structures and pay components

**Pay components** (`/config/pay-components`) name *kinds of pay* and where they post. Demo components: `BASIC` Basic salary, `HOUSING` Housing allowance, `TRANSPORT` Transport allowance, `PENSION` Employee pension contribution, `ERCONTRIB` Employer contribution, `EOSPROV` End of service provision.

- **Define a pay component**: **Code**, **Name**, **Kind**: **Earning** (debits an expense account), **Deduction** (credits a payable), **Employer contribution** (debits an expense, credits a payable) or **End-of-service provision** (debits an expense, credits a provision; payroll runs refuse it for now). Net pay is derived, not a component.
- **Mappings**: choose the **Chart** to map within, then per component **Debit** and **Credit** G/L account and **Cost object**: **Charge the employee's assignment centre**, **Charge one fixed cost centre** (**Fixed cost centre**), or **Charge nothing**. Components can be **retired** or kept **open for new mappings**; the kind never changes.

**Salary structures** (`/people/salary-structures`): **Define a structure**: **Code** (`STAFF`), **Name**, **Currency**, **Valid from**, **Valid to (optional, last day)**. Then **Add or change a component**: choose **Component**, **Amount rule** (**Fixed amount** or **Percent of base**, e.g. `7.5` = 7.5 %), **Save component**; **Remove** to take one off. *The amount rule lives on the structure; the pay component only names the kind of pay and where it posts.*

> [!NOTE]
> **What Happens in the Background?** Nothing posts. At payroll calculation each line takes its accounts and cost receiver from the company's chart **at that moment** and keeps them: later changes to mappings do not alter results already calculated.

## 6. Time types and leave policies

**Configuration → Time types & leave policies** (`/config/time-types`). Needs authority; otherwise "This session lacks the authority for this form."

- **Time types**: **Code** (e.g. `ANNUAL`, `SICK`, `UNPAID`), **Name**, **Kind** (**absence**, **attendance**, **overtime**), **Reduces a balance** (yes/no), **Paid** (**yes** / **no (unpaid)**), **Description**, **Valid from**. A type is retired by validity, never deleted. Only **absence** reduces a balance.
- **Policies**: **Code**, **Name**, **Valid from (first of month)**, **Partial month (joiner or leaver)** (**Prorate by days** or **Full month if any day**), **Description**, and **Lines** — one line per time type: *type, annual days, `MONTHLY` or `ANNUAL_UPFRONT`, optional fallback type*. Example: `ANNUAL 24 MONTHLY UNPAID` gives 24 days a year credited monthly, with days beyond the balance charged to `UNPAID`.
- **Groups** (e.g. a leave group): who the policy applies to.
- **Assignments**: **Applies to** a **Person** or a **Group**, with **Policy** and **Valid from (first of month)**.

> [!NOTE]
> **What Happens in the Background?** An employee covered by a policy is **policy-managed**: leave days are charged to a ledger of earned balance. An employee with no policy keeps the **legacy** behaviour (a hand-set quota, and the time type's paid flag). Country leave law is not built in: everything here is your own configuration.

## 7. Employee record types

**Configuration → Employee record types** (`/config/people-record-types`). A record type is a *form* of dated facts about a person (personal data, bank details …).

1. **Define a record type**: **Code** (e.g. `PERSGR`), **Name** (e.g. Personal data), and its **first field**: field **Code** (`NACHN`), **Name** (Last name), type **Text — words, up to 500 characters**, **Number — up to two decimals** or **Date — one day**, and whether it is **required**.
2. Select the type and **Add a field** for the others.
3. **Write a record of this type →** takes you to the employee.

A type is **retired, never deleted**, so no record of it can be lost. A type with no fields cannot be used ("No field is defined, so nothing can be recorded with this type").

## Checklist: ready to run payroll?

1. Employee approved (not pending) and **assigned a position** that covers the whole period, with a company code and cost centre.
2. A **pay structure** is assigned and valid for the whole period, and has components.
3. Every component used is **mapped to an account** in the company's chart, and charges an existing cost centre if it charges the employee's centre.
4. The structure names **no end-of-service provision** component (not supported by payroll runs).
5. Leave policies and time types are configured if leave affects pay.

---

**← Previous** [HR overview](overview.md) · **Next →** [HR daily transactions](daily-transactions.md)

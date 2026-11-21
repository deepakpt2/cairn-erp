# HR — Human Resources: Overview

Human Resources (HR) holds **who works here, in which job, under whom, how much leave they have, and what they are paid** — and turns payroll into accounting entries.

## Table of Contents

- [What HR does for you](#what-hr-does-for-you)
- [Who uses it](#who-uses-it)
- [The HR menu](#the-hr-menu)
- [The life of an employee in the system](#the-life-of-an-employee-in-the-system)
- [Key ideas in plain words](#key-ideas-in-plain-words)
- [What HR does not do](#what-hr-does-not-do)
- [Where to go next](#where-to-go-next)

> [!IMPORTANT]
> **Prerequisites**
> - You have read [Login and roles](../01-getting-started/login-and-roles.md) and [Master data concepts](../01-getting-started/master-data-concepts.md).
> - The organisation (units, jobs, positions) and cost centres exist ([HR master data](master-data.md)).
> - Your role carries HR authorities: an **HR clerk** (limited to a plant) or an **HR officer** (company-wide). Without the matching capability a form is replaced by a message such as "You do not hold …".

## What HR does for you

| Business question | HR answers it with |
|---|---|
| "Hire someone." | **Request a hire**, then an approver approves (`/people/employees`) |
| "Where do they sit and what does it cost?" | **Assignment**: position → unit → cost centre (`/people/assignments`) |
| "Who reports to whom?" | **Organisation** (`/people/organization`) and **Authority** (`/people/authority`) |
| "How much leave do they have? Approve this leave." | **Time & leave** (`/people/time-leave`) |
| "What do they earn?" | **Salary structures** and **Pay components** |
| "Run payroll." | **Payroll runs** → **Payroll results** → post to G/L → pay salaries |

## Who uses it

| Role | Typical work |
|---|---|
| **HR clerk** (`DEMO_HR`-style, plant scope) | Hires, assignments and leave for the plant's staff, **never above their own tier** |
| **HR officer** (company scope) | All of the above company-wide; approves hires; maintains structures and pay components |
| **Payroll accountant** | Proposes, releases and posts payroll runs, pays salaries (needs finance posting authority as well) |
| **Manager** | Approves leave of their team; reads their reporting line |
| **Employee** | Requests leave |

## The HR menu

Choose **HR – People** in the left menu.

| Activity | Route | Covered in |
|---|---|---|
| Employees (alias **PA30**) | `/people/employees` | [Master data](master-data.md#1-employees) |
| Assignments | `/people/assignments` | [Master data](master-data.md#2-assignments) |
| Organisation | `/people/organization` | [Master data](master-data.md#3-the-organisation-units-jobs-positions) |
| Authority | `/people/authority` | [Master data](master-data.md#4-authority-and-delegation) |
| Salary structures | `/people/salary-structures` | [Master data](master-data.md#5-pay-structures-and-pay-components) |
| Time & leave | `/people/time-leave` | [Daily transactions](daily-transactions.md#2-time-and-leave) |
| Payroll runs | `/people/payroll-runs` | [Daily transactions](daily-transactions.md#3-payroll) |
| Payroll results | `/people/payroll-results` | [Reports](reports-and-troubleshooting.md#payroll-results-the-pay-slips) |
| *Configuration:* Time types & leave policies | `/config/time-types` | [Master data](master-data.md#6-time-types-and-leave-policies) |
| *Configuration:* Employee record types | `/config/people-record-types` | [Master data](master-data.md#7-employee-record-types) |
| *Configuration:* Pay components | `/config/pay-components` | [Master data](master-data.md#5-pay-structures-and-pay-components) |

## The life of an employee in the system

```
 Request a hire ─► Approve hire ─► Start an assignment ─► Assign a pay structure ─► Time & leave
   (not in use)     (higher tier)    (position, cost centre)   (what they earn)         │
                                                                                         ▼
                              End the assignment ◄── ... ◄── Payroll run ─► post to G/L ─► Pay salaries
```

## Key ideas in plain words

- **Dated records, never overwritten.** A change is a **new record with a start date**. History stays. You can end the newest open record or correct its values, but you cannot delete anything.
- **Tiers.** Every position has a tier (1–9). To hire, approve, assign, move or end someone, your own tier must be **strictly above** theirs. A plant HR clerk can take on staff but never a plant manager, and nobody acts on an equal or a superior. A user with no linked employee record cannot act on tiers.
- **Four eyes.** The person who requests a hire or enters a payroll adjustment cannot approve it.
- **Assignment** is the link *employee → position → cost centre*. It decides which company a person is paid in and where their cost lands.
- **Payroll run** = one company code and one fiscal period. It is a calculation first; **nothing posts until you post it**.

## What HR does not do

> [!NOTE]
> No statutory content ships: **no income tax, no social-insurance rates and no country leave law**. Everything is what your organisation configures. End-of-service provisions are not calculated by payroll runs: a structure that names one is refused.

## Where to go next

1. [HR master data](master-data.md).
2. [HR daily transactions](daily-transactions.md).
3. [HR reports and troubleshooting](reports-and-troubleshooting.md).

---

**← Previous** [FICO reports and troubleshooting](../05-fico-finance-controlling/reports-and-troubleshooting.md) · **Next →** [HR master data](master-data.md)

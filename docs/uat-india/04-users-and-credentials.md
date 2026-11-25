# Deliverable 3 — Generated users and credentials

**These are test credentials for a fictional company. They are not reusable anywhere.**

The passwords are generated at install time, one per account, and written to
`credentials/demo-credentials.txt` at mode `0600`. They are never written to the database, which
holds only a scrypt hash, and they are never logged. The same rows are served in the application
at **`/platform/users/test-credentials`**, which returns 404 outside a development build.

The list below is the **shape** of the accounts, without passwords. Read the password for each
from the credential file after installing — the file is the single source of truth, because a
value copied into documentation would be stale the moment the dataset is reinstalled.

---

## How to get the list after an install

```
npx tsx scripts/in01-install.ts --until=phase2     # installs and prints the list
cat credentials/demo-credentials.txt              # the same list, with passwords
```

The in-app view is `/platform/users/test-credentials` (development builds only).

---

## The accounts

Fifteen sign-ins: two founders and thirteen working roles. Every one is linked to an employee,
so each step of the UAT guide can name both the person and the login.

| # | Username | Role | Department | Employee | Personnel no. | What it can do |
|---|---|---|---|---|---|---|
| 1 | `in01.owner` | Platform administrator | — | Demo Platform Administrator | — | Creates users, roles and grants capabilities. **Cannot post or configure.** Platform role, tenant-local. |
| 2 | `in01.admin` | Administrator | Management | Rajesh Deshpande, Managing Director | 10000001 | The wildcard: everything. The tenant administrator `createTenant` made. |
| 3 | `in01.buyer` | Buyer | Purchase | Kavita Pawar, Buyer | 10000010 | Requisitions, purchase orders, supplier negotiation. No posting to FI. |
| 4 | `in01.planner` | Production planner | Production | Mahesh Chavan, Production Manager | 10000014 | MRP, planned orders, production orders. Plant 1000 only. |
| 5 | `in01.supervisor` | Production clerk | Production — Cutting | Santosh Waghmare, Shift Supervisor | 10000015 | Confirmations, component issue, FG receipt. Plant 1000 only. |
| 6 | `in01.storekeeper` | Storekeeper — plant | Stores | Sanjay Gaikwad, Storekeeper | 10000012 | Goods movements at plant 1000, including delivery PGI. |
| 7 | `in01.dispatch` | Storekeeper — DC | Dispatch | Akash Pawar, Dispatch Clerk | 10000037 | Goods movements at plant 2000 only. |
| 8 | `in01.sales` | Sales clerk | Sales | Neha Kulkarni, Sales Executive | 10000034 | Quotations, orders, deliveries, billing. No goods movement, no FI. |
| 9 | `in01.ap` | Accountant (AP/AR) | Finance | Amit Joshi, Accounts Executive — Payables | 10000003 | General ledger, payables, receivables, banking. |
| 10 | `in01.ar` | Accountant (AP/AR) | Finance | Priya Nair, Accounts Executive — Receivables | 10000004 | Same authority as AP; a second person, so a two-person control can be shown. |
| 11 | `in01.payroll` | Accountant (AP/AR) | Finance | Deepak Patil, Payroll Officer | 10000005 | Same authority as AP; the payroll run and posting are reached by `in01.admin` (see GAP B/payroll authority). |
| 12 | `in01.controller` | Controller | Finance | Meera Iyer, Costing Controller | 10000006 | Costing, profitability, internal orders and settlement. Releases parked journals and payment runs. |
| 13 | `in01.qc` | QC inspector | Quality | Arun Kulkarni, QC Inspector | 10000029 | Inspection lots, results, usage decisions. Plant 1000 only. |
| 14 | `in01.hr` | HR officer | Human Resources | Vikram Shinde, HR Manager | 10000007 | Employee data company-wide, position tiers, hire approval, leave. |
| 15 | `in01.auditor` | Auditor | Quality | Anita Gaikwad, QC Inspector | 10000051 | Read-only. The audit grant in Phase 3 is time-boxed and scoped. |

### Notes a tester needs

- **`in01.owner` cannot post.** It exists to create accounts and roles. Any attempt to post as
  it is refused, by design.
- **`in01.admin` is the only account that reaches payroll.** No role in the product holds
  `PEOPLE.PAYROLL.*` or `PEOPLE.PAYROLLRUN.EXECUTE` (`docs/OPEN-GAPS.md` A1). This is a GAP, and
  the guide says so where it matters.
- **Plant scopes are real.** `in01.storekeeper` reaches plant 1000 and not 2000;
  `in01.dispatch` the converse. A movement at the wrong plant is refused, which is a thing worth
  seeing.
- **`in01.ap` and `in01.ar` hold the same role.** They are two people, not two authorities; that
  is what lets the guide demonstrate a four-eyes control without inventing a capability.

---

## The employees (52)

The employees without a login are still real employees: they appear in the org chart, hold
positions and cost centres, and are paid. They simply never sign in.

| Department | Cost centre | People | Who |
|---|---|---|---|
| Management | CC5000 | 1 | Rajesh Deshpande, Managing Director |
| Finance | CC5000 | 6 | Sunita Kulkarni (Finance Manager), Amit Joshi (AP), Priya Nair (AR), Deepak Patil (Payroll), Meera Iyer (Controller), and the accounts staff grade |
| Human Resources | CC5100 | 3 | Vikram Shinde (HR Manager), Anjali More, Sneha Jadhav |
| Purchase | CC3000 | 3 | Sandeep Bhosale (Purchase Manager), Kavita Pawar, Amol Chavan |
| Stores | CC2000 | 4 | Ramesh Jadhav (Supervisor), Sanjay Gaikwad, Pooja Kadam, Jyoti Deshpande |
| Production — Cutting | CC1000 | 9 | Mahesh Chavan (Production Manager), Santosh Waghmare, operators, helpers |
| Production — Welding | CC1010 | 6 | Imran Shaikh, welders, one helper |
| Production — Painting | CC1020 | 6 | Nitin Salunkhe, painters, helpers |
| Quality | CC6000 | 4 | Snehal Deshmukh (Quality Manager), Arun Kulkarni, Swati Bhosale, Anita Gaikwad |
| Maintenance | CC7000 | 3 | Yogesh Patil, Nilesh Chavan, Prashant Mane |
| Sales | CC4000 | 4 | Rahul Bhise (Sales Manager), Neha Kulkarni, Rohit Deshmukh, Sameer Shaikh |
| Dispatch | CC8000 | 2 | Akash Pawar, Pravin Sawant |

Grades are a realistic mix: **Management** (MD, functional heads), **Staff** (executives,
supervisors), **Skilled worker** (welders, operators, fitters), **Semi-skilled** (painters),
**Unskilled** (helpers). Salaries run from ₹15,000 (helper) to ₹1,80,000 (MD) per month — the
range a Pune fabricator actually pays.

---

## What each account proves for segregation of duties

The reason the dataset gives each role its own account is that the UAT can show the product
*refusing* things, which is the interesting behaviour:

- `in01.sales` cannot post a goods issue — the delivery is picked and PGI'd by the storekeeper.
- `in01.storekeeper` cannot raise a purchase order.
- `in01.buyer` cannot post a supplier invoice.
- `in01.qc` can move goods out of inspection stock, because a usage decision posts a transfer,
  but cannot receive or issue them.
- `in01.ap` cannot release what it parks; `in01.controller` releases.

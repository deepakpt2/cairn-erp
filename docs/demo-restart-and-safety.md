# The demo dataset: what happens when the run stops

This is the operator's reference for an interrupted or refused dummy-data
installation. It answers three questions: what state the database is in, what the
next run will do, and what you should do about it.

Everything here is asserted by `tests/demo-safety-matrix.test.ts`, so a change that
breaks a guarantee described in this document fails the suite. Where a claim depends
on something a test cannot reach — Docker behaviour on a host, for instance — it is
marked as verified statically only.

---

## 1. The ledger

Two tables hold the whole history. They are global, not tenant-scoped, because
eligibility requires that no tenant exist — a record living inside a tenant could be
neither written before the work nor read after an interrupted run.

```sql
select installation_id, operation, database_name, status,
       timeline, started_at, completed_at, password_issued_at
  from demo_installation;

select phase_code, status, attempt, started_at, completed_at, detail
  from demo_installation_phase
 order by phase_code;
```

`demo_installation.status` is `RUNNING`, `COMPLETED` or `FAILED`.
`demo_installation_phase.status` is `PENDING`, `RUNNING`, `COMPLETED` or `FAILED`.
`attempt` is 1 for a phase that ran once; a phase re-entered after an interruption
counts 2.

The provisioner is granted `select, insert, update` on both tables and **no
`delete`**. There is no force flag, no reset, and no truncate anywhere in the
provisioning path.

---

## 2. The four dispositions

Every run begins by claiming the installation, under an advisory transaction lock, in
one transaction with the eligibility survey. It is handed one of four answers.

| Disposition | When | What the run does |
|---|---|---|
| `FRESH` | No installation record, and every tenant-owned table is empty. | Writes the record and all eleven pending phases, then runs all eleven. |
| `RESUME` | A record stands for this database and this build, not failed, with phases outstanding. | Skips the phases already `COMPLETED`, and resumes at the first one that is not — a phase left `RUNNING` by a dead process is resumed and counted as a retry. Also: a record that is `COMPLETED` but does not name a phase a later build added (e.g. `D6_AUDIT`) has that phase appended and run; a phase it names but never finished is still refused. A resumed run resets every account to a new password and rewrites the credential file. |
| `ALREADY_COMPLETE` | The record is `COMPLETED` and all nineteen phases are. | Changes nothing. Rewrites the credential file, because a deployment that lost the file cannot be given the password back — with the password shown as *not recoverable* rather than blank. Returns 0. |
| `REFUSE` | Any of the five refusals in §4. | Writes nothing. Returns 1, so the application never starts. |

---

## 3. The nineteen phases

A phase is a unit of resumption, not a unit of tidiness. The organisation and the
people are split because the second takes minutes and opens administrator sessions: a
run that dies there continues with the accounts that are missing rather than
rebuilding the company they hang from.

| Phase | What it writes | How a resumed run knows it already did it |
|---|---|---|
| `A_FOUNDATION` | The installation record, the frozen timeline, the client and its foundation. | Claimed once. Once the record stands, eligibility is never consulted again. |
| `B_ORGANISATION` | Company code, both plants, storage locations, the organisation and its positions, cost centres, profit centres, the internal order, the demo roles. | Adoption: an element that already stands is adopted rather than created again. |
| `B_PEOPLE` | The ten accounts, their capability grants and organisational restrictions. | Adoption, and one password: a resumed run issues a new password and resets every account to it, because the first run's password was never stored. |
| `C_MASTERS` | Materials, partners, info records, prices, tax codes, BOMs, routings, production versions. **No documents.** | Idempotent by adoption. |
| `D1_PROCUREMENT` | Opening balances, opening stock, purchase orders, goods receipts, supplier invoices, first payments. | Request-keyed: `DEMO-OPENING-*`, `DEMO-GR-*`, `DEMO-IR-*`, `DEMO-PAY-*`, `DEMO-ISS-*`. |
| `D2_PRODUCTION` | Production orders, component issues, confirmations, receipts of finished material. | Request-keyed: `DEMO-PO-*`, `DEMO-GI-*`, `DEMO-CF-*`, `DEMO-GR-*`, `DEMO-SC-*`. |
| `D3_SALES` | Sales orders, deliveries with goods issues, billing documents, incoming payments. | Request-keyed, through the phase's own `findByRequestKey` before each post. |
| `D4_FINANCE` | Outgoing payments, operating costs, the internal order and its settlement, GR/IR reclassification, tax returns, a dunning run. | Request-keyed, through the phase's own `findByRequestKey` before each post. |
| `D5_QUALITY` | A purchase of inspection stock, two lots, their results, the usage decisions, and the 321 and 323 transfers behind them. | Request-keyed: `DEMO-QM-*`, through the phase's own `findByRequestKey`. |
| `D6_AUDIT` | One time-boxed, scoped, read-only audit grant to `demo.auditor`, the auditor's findings, note, bookmark and two requests, and the controller's answer to one of them. | Request-keyed grant (fixed request key → grant id); findings found by subject; a request is answered only while open. |
| `D7_PAYROLL` | Pay components mapped to the payroll accounts, time types (incl. leave without pay), salary structures STAFF and MGMT, and a structure assignment for every demo employee but 10000016. Nothing calculated or posted. | Adoption; request-keyed assignments `DEMO-SAL-*`. |
| `D8_PAYROLL_RUN` | A joiner (10000017) and a leaver (10000018) with positions and STAFF assignments, unpaid leave (approved for 10000004, approved across the month end for 10000007, still requested for 10000008), EOSPROV taken out of STAFF and MGMT, and a **proposed** payroll run for the period the installation was claimed in — 10000016 stands as its named exception. Nothing released or posted. | Employees, positions and absences looked up before they are written; request-keyed assignments `DEMO-SAL-*` and run `DEMO-PAYRUN-*`; a run already standing for the period is left alone. |
| `D9_PAYROLL_POST` | A MGMT structure for 10000016 from the first day of the run's period (clearing D8's exception), then the run recalculated, released and **posted** as one PR document by `demo.admin` — who is given explicit Company Code 1000 and Plant 1000/2000 scope, its whole reach, because the judged posting services refuse an unscoped actor. Only that period: the earlier months' salaries are already booked by D4's journals. Nothing paid. | Request-keyed assignment `DEMO-SAL-10000016-*`; scopes granted only when missing; each step runs only from the status before it; posting request-keyed `PAYROLL-POST-<run>`. |
| `D10_PAYROLL_PAY` | Bank `VFDEMO01` in the bank master, house bank `VFB` account `MAIN` (KWD, G/L 101000) for company 1000, and the posted run paid from it on the last day of its period as one PY document — a debit per employee on the net pay payable, one bank credit — clearing the payroll document's payable. | Bank, house bank and account created only when missing; a paid run is left alone; payment request-keyed `SALARY-PAY-<run>`. |
| `D11_PAYROLL_OFFCYCLE` | A late joiner (10000019, Yara Khalil) from the 20th of the run's period, STAFF from that day, and a **proposed off-cycle run** for the same period that pays only her; the 18 employees the paid run covers are listed as information naming it, and it is the off-cycle run's predecessor. | Employee and position looked up; request-keyed assignment `DEMO-SAL-10000019` and run `DEMO-PAYRUN-OFFCYCLE-*`; an off-cycle run already standing is left alone. |
| `D12_CO_PLAN` | A primary-cost plan (version 000) for the installation's fiscal year: every cost centre and cost element carrying cost, each period the centre is valid in planned at the element's average actual month, saved through KP06 as `demo.admin`. | A save replaces its selection, so a repeat changes nothing; request-keyed `DEMO-COPLAN-<year>-<centre>`. |
| `D13_ACTIVITY_PRICE` | Activity types MIXH (Mixing, CC1000) and PACKH (Packing, CC1010) on automatic price indicator 1, QCH (Quality, CC6000) manual at 25.00, with planned hours for the periods the centres stand in, and the activity prices calculated from D12's plan (annual basis); QCH is skipped. | Types adopted when standing; a rate save replaces its matrix; the calculation is request-keyed `DEMO-KSPI-<year>` and recomputes the same prices. |
| `D14_ASSESSMENT` | A dedicated allocation account 690000 "Internal cost allocation" in the demo chart, the CO_ASSESSMENT determination naming it, cycle SVC01 (Warehousing CC2000 and Administration CC5000 to Mixing CC1000 60 % and Packing CC1010 40 %), and its assessment run for the installation's period — one AL document; then distribution cycle DST01 (Maintenance CC3000 and Facilities CC6000 to Mixing 60 % and Packing 40 %, every cost kept on its own G/L account) and its run for the same period — a second AL document. | Account and determination created only when missing; each cycle adopted when it stands; a period with a live run left alone; postings request-keyed. |
| `D15_BOM_STRUCTURE` | Text item category T; phantom glaze PH-GLAZE (MRP type NONE) with its BOM (cocoa, sugar), routing and production version; alternative 02 of FG-CHOC with the phantom, 2 % scrap on the dough, a fixed carton quantity and a text item — selected by **no** production version, so MRP plans exactly what it did before (verified on a scratch install: identical proposals and dependent requirements; the only new MRP row is PH-GLAZE skipped as not planned). | Adoption; each BOM, routing and version request-keyed. |
| `D16_COST_ESTIMATE` | Costing data the demo lacked, **only where missing**: control key PP01 made relevant for costing, operation hours (against the base quantity of 1200) on the routing operations, and a costing line on work centres WC01 (CC1000 / MIXH) and WC02 (CC1010 / PACKH); then one saved standard cost estimate of FG-CHOC on the anchor date, costing the made sub-assembly SEMI-DOUGH from its own components and hours. **No price or rate is changed and nothing is released** (releasing is CK24, a later item). | Each fill is conditional on the value being missing; a SAVED estimate of the date is read back; request-keyed. |
| `D17_SALES_AVAILABILITY` | Availability configuration **only where missing**: checking rules OR and LF, checking group D1 with a scope for each (safety stock deducted, other orders' promises subtracted, open purchase orders counted), D1 assigned to TRAD-JUICE at the distribution centre. Then one sales order (SO for CUS-1000, 2,000 BOX, requested a week after the anchor) confirmed partially as it is raised, and the delivery created from the confirmation. **No document type names a rule and no other material has a group**, so every other order is checked exactly as before. | Each configuration row is created only when missing; the order and delivery are request-keyed. |
| `D18_SALES_QUOTATION` | Three sales quotations: an open one for CUS-2000 (three items, changed once with an item rejected, then raised to one sales order), a rejected one for CUS-3000, and an expired one for CUS-1000 given in the past whose status stays `OPEN`. The one order takes 20 BOX of TRAD-JUICE and about 489 KWD of CUS-2000's credit headroom. Nothing else is changed. | Every document is request-keyed (`DEMO-VA21-OPEN-1`, `DEMO-VA21-REJECTED-1`, `DEMO-VA21-EXPIRED-1`, `DEMO-VA21-ORDER-1`); the change and the rejection run only while the quotation still stands at version 1 and open. |

The ledger says which phases finished. It cannot say what a phase had committed
before it died, which is why each phase asks its own question — does a document
carrying this request key already stand — rather than trusting the marker.

Ordering is append-only. Later work adds phases to the end of `DEMO_PHASE_PLAN`; it
never reorders them. A phase declared but not implemented stops the run rather than
being skipped.

---

## 4. The refusals

Five ways a run is refused, all of them before anything is written:

1. **The survey examined nothing.** If the catalogue cannot be enumerated, the count
   of tenant-owned tables is zero, and a scan that examined nothing has established
   nothing. Counting that as an empty database would populate the very database it
   failed to read.
2. **The database already holds business data.** Eligibility is decided by counting
   rows in every table carrying a `client` column, never by reading a marker. The
   count has to run through the `security definer` functions
   `demo_tenant_table_count()` and `demo_eligibility_conflicts()`: a direct count
   under row-level security, with no tenant set, reported 7 conflicting tables of 424
   and missed the tenant entirely.
3. **The record belongs to another database.** `demo_installation.database_name` is
   compared with the database the connection is actually in.
4. **The record is from a different build.** `DEMO_PROVISION_OPERATION` changed, and a
   different dataset is not a continuation of this one.
5. **A previous run failed, or a marker disagrees with the data.** A `FAILED`
   installation, a `FAILED` phase, or a `COMPLETED` installation whose declared
   phases never all finished.

Two further guards sit outside the ledger:

- **Named databases are refused outright** — `cairn_b210`, `cairn_hr_accept`,
  `cairn_demo`, `cairn_acceptance`, `cairn_integration` — in addition to the target
  guard every connection passes. A database name that is not a plausible identifier is
  refused before it is compared with anything.
- **Two advisory keys, never one.** The run holds a session-level lock on its own
  connection for the whole run; the claim takes a transaction-level lock on a
  different key. Session and transaction advisory locks share one lock space, so a run
  using one key for both waits on itself forever. `pg_try_advisory_lock` is used for
  the run lock so a second instance is told immediately rather than queued. If the
  process dies, the session ends and PostgreSQL releases the lock, so a crashed run
  does not wedge the next one.

---

## 5. What to do when it stops

```
Did the migrate container exit 0?
│
├─ yes ──> nothing to do. The dataset is complete; sign in with the credential file.
│
└─ no ──> read `docker compose logs migrate`.
          │
          ├─ "already contains business data"
          │     This is the refusal, not a failure. Nothing was written, modified or
          │     deleted. Either point the deployment at a genuinely fresh volume, or
          │     set ENABLE_DUMMY_DATA=false and onboard the system that is there.
          │
          ├─ "another provisioning run already holds this installation"
          │     Two instances started together. Stop one and re-run the other. The
          │     lock is released with its session, so if no run is alive it is already
          │     free.
          │
          ├─ "failed and was never recovered" / "left in place and marked failed"
          │     The partial dataset was left exactly as it was found. Look at the
          │     failed phase's `detail`. There is no automatic resume and no cleanup
          │     command: either provision a fresh database, or — only if the failure
          │     was environmental and the phase is genuinely idempotent — correct the
          │     cause and re-run. A FAILED installation is never resumed silently.
          │
          └─ anything else
                A migration, reference-init, seed or phase error. The log names it.
```

The one thing not to do is reach for `docker compose down -v` to make the symptom go
away. It deletes the database volume.

---

## 6. Credentials across a restart

One shared password is generated at provisioning time and held in memory for the life
of the run. It is never written to the database, the log, or the repository — only to
`./credentials/demo-credentials.txt`, at mode `0600`, at the end, once there is
something for it to open. The database holds a SHA-256 fingerprint and a timestamp,
which is enough to know a password was issued and not enough to recover it.

A resumed run issues a **new** password and resets every demo account to it, because
the first run's password was never stored. The credential file is rewritten with it,
so there is one file, one password, and no gap between them. The reset runs on any
resumed run that reaches the end, including one that skipped the people phase —
otherwise the file would name a password no account answers to.

A completed installation is never re-issued. If you lose the file, provision a fresh
database; the report says so.

---

## 7. What was verified, and how

| Claim | Evidence |
|---|---|
| All nineteen phases complete, first attempt, one record naming the right database | `tests/demo-safety-matrix.test.ts`, against a provisioned database |
| The disposition, refusal, lock and ordering guarantees | `tests/demo-safety-matrix.test.ts`, against the source |
| Every phase request-keyed, or idempotent by adoption | `tests/demo-safety-matrix.test.ts`, against the phase modules |
| Credential file permissions, ownership and atomic write | `tests/demo-credentials.test.ts` |
| The dataset reconciles after a full run | `tests/demo-reconciliation.test.ts` — twelve checks, see §8 |

**Not executed: Docker.** The test host has no Docker, so the container-level
behaviour — the one-shot `migrate` service, the bind-mounted `credentials` directory,
the gating of `app` and `worker` on `migrate` succeeding — is verified as a static
contract against `docker-compose.yml` and `Dockerfile` only. It should be confirmed
once on a real host.

---

## 8. The reconciliation, in one line each

The twelve checks in `tests/demo-reconciliation.test.ts`, for when you want to know
whether the dataset is sound rather than merely present:

1. The stock the inventory ledger holds is the stock the movements moved, at the value
   the inventory accounts carry — in total and per valuation class.
2. The general ledger balances: every debit has a credit.
3. GR/IR stands at nothing, and the close named what replaced it.
4. The payables subledger is the general ledger.
5. The receivables subledger is the general ledger.
6. Revenue is what was billed.
7. The tax account is what was collected, less what was paid, less what was filed.
8. Production received what the orders said they would make.
9. The internal order stands at nil, settled to the receiver its rule names.
10. Every expense is charged to the object that incurred it.
11. Every document is posted inside the periods the timeline froze.
12. The dataset is the size the task asked for, written by the people whose job it is,
    and left nothing half finished.

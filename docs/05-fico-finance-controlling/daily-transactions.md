# FICO — Daily Transactions

The postings and runs an accountant or controller performs every day and every month-end. Sample data: company code `1000` (currency `KWD`), vendor `SUP-1000`, customer `CUS-1000`, bank account `101000` Bank — current account, expense account `510200` Repairs and maintenance.

## Table of Contents

- [1. General ledger](#1-general-ledger)
- [2. Accounts payable](#2-accounts-payable)
- [3. Accounts receivable](#3-accounts-receivable)
- [4. Asset accounting](#4-asset-accounting)
- [5. Period-end close](#5-period-end-close)
- [6. Controlling](#6-controlling)

> [!IMPORTANT]
> **Prerequisites**
> - [FICO master data](master-data.md) is in place and the **posting period is open**.
> - You hold the capability for the screen; otherwise it shows a message such as "You do not hold the … capability" and no form.
> - Dates are `YYYY-MM-DD` in the form; amounts are entered without thousands separators.

> [!NOTE]
> **Posted documents are final.** None of these screens edits or deletes a posted document. To correct, **reverse** (section 1.4) and post again.

---

## 1. General ledger

### 1.1 Post a journal entry

**FICO → General ledger → Post a journal entry** (`/finance/journal/new`, alias **FB50**).

Example: pay `120.000 KWD` for a repair in cash. Debit the expense, credit the bank.

1. **Company code** `1000`. **Document date** and **Posting date** `2026-11-21` (both mandatory). The posting date decides the period.
2. **Type** `SA — General journal entry`. **Currency** is shown for the company (read-only).
3. Optional **Reference** (max 16 characters, `JE-2026-001`) and **Header text** (max 25, `Monthly repair`).
4. Under **Line items** enter at least two lines. For each: **Account** (a G/L account), **D / C** (Debit or Credit), **Amount** (greater than zero), and optionally **Cost centre**, **Profit centre**, **Assignment** (max 18) and **Line text** (max 50).

   | # | Account | D / C | Amount | Cost centre | Line text |
   |---|---|---|---|---|---|
   | 1 | `510200` | Debit | 120.000 | `CC1000` | Pump repair |
   | 2 | `101000` | Credit | 120.000 | | Paid in cash |

5. Use **Add line**, **Insert**, **Copy** or **×** to change the grid. A banner shows **Document balances. Ready to post.** or **Document does not balance. Difference …**.
6. Click **Review posting**, read the summary ("Post 2 lines for company 1000, type SA, 120.000 KWD on 2026-11-21?") and click **Confirm posting**. To save for later instead, choose **Park a draft instead…**.

> [!NOTE]
> **What Happens in the Background?**
> - One balanced accounting document is created with the next number of the document type's range, in the period of the posting date.
> - The G/L balances, line-item report and trial balance change **immediately**.
> - No stock or subledger is touched, because neither account is a reconciliation account.
> - Posting is protected against double click: the same request cannot post twice.

| Refusal | Fix |
|---|---|
| "The document does not balance. Debits …, credits …" | Make debit total equal credit total |
| "A document must have at least two line items" | Add the offsetting line |
| "Line n has a zero / negative amount" | Enter a positive amount; use D/C for the side |
| "Line n has no G/L account" / "G/L account … does not exist in this chart" | Correct the account |
| "Period … is closed" / "Posting date … belongs to period …" | Use an open period or ask the administrator |
| "Document type … is not active or does not exist" | Choose a configured type |

### 1.2 Park and release a journal

**Park a journal entry** (`/finance/journal/park`) stores an unfinished document **without** touching any balance; it may stand incomplete or unbalanced. Mark it complete when every line is complete and balanced, then **post** it. The parked record stays as a reference to the posted document. Deleting a parked document is a logical delete and needs a reason. Another user's edit to the same parked document is detected by version.

### 1.3 Display a document

**Display an accounting document** (`/finance/journal`) and **Accounting document display and flow** (`/finance/journal/document`): enter **Company code**, **Document number** (e.g. `1000/2026/1`) and **Fiscal year**. The flow shows the source (goods receipt, invoice) and any reversal.

### 1.4 Reverse a document

**Reverse accounting document** (`/finance/document-reversal`).

1. Enter **Company code**, **Document number**, **Fiscal year**; click **Display document**.
2. Check the **Line**, **Account**, **Partner**, **D/C** and **Clearing** columns. Click **Check posting date** or **Derive period** if needed.
3. Enter **Reversal reason (required)**, **Reversal document date** and **Reversal posting date**.
4. Tick **I confirm the reversal of this document** and click **Reverse document**.

> [!NOTE]
> **What Happens in the Background?** A new document (type `AB`) posts every line back with debit and credit swapped. The original is marked **REVERSED**; the pair is linked and exactly one reversal can ever exist. Balances net to zero.

| Refusal | Meaning |
|---|---|
| "has already been reversed by …" | Already corrected |
| "is itself a reversal and cannot be reversed" | Post the original again instead |
| Items are cleared | **Reset cleared items** first (`/finance/clearing-reset`), then reverse |

### 1.5 Clearing and other G/L acts

- **Clear G/L account** (`/finance/gl-clearing`): open items on an *open-item-managed* account that sum to zero are cleared against each other under one clearing document.
- **Reset cleared items** (`/finance/clearing-reset`): lifts the clearing so items stand open again. It posts nothing; it records the reason.
- **Post an intercompany journal** (`/finance/intercompany`): one submission posts **two balanced documents in one transaction**: the sending company's lines plus a clearing line on its intercompany clearing account, and the mirror lines plus its own clearing line in the receiving company. If either fails, both roll back. Each line names the other company as trading partner so consolidation can eliminate the pair; the clearing balances are cleared later with **Clear G/L account**. Clearing accounts are set at `/config/intercompany-clearing`.

---

## 2. Accounts payable

### 2.1 Enter a vendor invoice

**FICO → Accounts payable → Enter vendor invoice** (`/finance/vendor-invoice`). For invoices **with** a purchase order use [MM invoice verification](../02-mm-materials-management/daily-transactions.md#6-enter-an-incoming-invoice) instead; this screen is for invoices without one (rent, services).

| Field | Notes | Required |
|---|---|---|
| **Vendor** | `SUP-1000` | **Yes** |
| **Company code** | `1000` (vendor must be extended to it) | **Yes** |
| **Currency** | `KWD` | **Yes** |
| **Reference** | The number printed on the vendor's invoice (max 16) | **Yes** |
| **Invoice date**, **Posting date** | | **Yes** |
| **Payment terms** | Blank takes the vendor default | Optional |
| **Gross amount (tax included)** | Must equal lines + tax | **Yes** |
| Lines: **G/L account**, **Net amount (tax excluded)**, **Tax code**, **Cost centre**, **Profit centre**, **Text** | At least one line; amount above zero | Account and net: **Yes** |

Example: gross `115.000`, one line `510200`, net `100.000`, tax code `V1` at 15%.

> [!NOTE]
> **What Happens in the Background?** Document type `KR`: **Dr** expense `100.000` and **Dr** input tax `15.000` / **Cr** vendor reconciliation account (Trade payables) `115.000`, carrying the vendor as partner. This is the **open item** to be paid. An invoice with the same vendor reference is refused as a duplicate ("Load the standing invoice").
> **Cancel:** enter the invoice number (**Load invoice**), set a **Cancellation posting date**; a mirror document is posted. A cancellation cannot itself be cancelled.

| Refusal | Fix |
|---|---|
| "Enter at least one expense line" | Add a line |
| "The vendor reference stands required" | Type the invoice number |
| "Correct the gross amount or the line amounts so the document balances" | Gross must equal net + tax |
| "Use a standing tax code / cost centre / profit centre" | Pick a valid master record or blank |
| Vendor not extended to the company | Maintain the supplier company accounting data |

### 2.2 Vendor credit memos and down payments

- **Enter vendor credit memo** (`/finance/vendor-credit-memo`): same fields as the invoice, posted type `KG`; **Dr** vendor / **Cr** expense and tax. It becomes a credit item that nets against the next payment.
- **Vendor down payment request** (`/finance/vendor-down-payment-request`): a *noted* item asking for an advance; **no liability, no bank movement**.
- **Post vendor down payment** (`/finance/vendor-down-payment`): the actual advance (type `KA`), posted against a **special G/L indicator**: **Dr** the indicator's alternative reconciliation account / **Cr** bank. The advance stands open *outside* the vendor's ordinary payables until cleared. An unconfigured indicator is refused by name, and the order named must be that vendor's own order in the same company.
- **Clear vendor down payment** (`/finance/vendor-down-payment-clearing`): applies the advance to the invoice.

### 2.3 Pay the vendor: outgoing payment

**Post outgoing payment** (`/finance/outgoing-payment`, one vendor at a time).

1. Enter **Company code**, **Vendor**; click **Load open items**.
2. Enter **Document date**, **Posting date**, **Clearing date**, **Bank G/L account** (`101000`), **Payment amount**, **Currency**, **Reference** (`BANK-REF-001`) and optionally a **Value date**.
3. In the **Open items** table tick **Select** for each invoice. Per item you may change **Applied** and **Discount**, and choose an **Outcome**: settle in full, leave a **Residual** open item, or **Partial**. Credit items count against the payment, so the selection nets.
4. Enter an **On-account amount** if part of the payment is not assigned to an invoice.
5. Post. The allocation **must equal the payment**; an unassigned remainder within tolerance becomes a payment difference, beyond it the posting is refused by name.

> [!NOTE]
> **What Happens in the Background?** Type `KZ`: **Dr** vendor reconciliation account (per allocation) / **Cr** bank. Every settled invoice is **cleared** in place under the payment document and the clearing date. Cash discount is judged against the invoice's payment-terms tiers and your tolerance group.

### 2.4 Pay many vendors: payment run

**Payment run** (`/finance/payment-run`).

1. Enter **Run date** and **Identification** (e.g. `APR01`); click **Load run**, or create a new one.
2. **Parameters**: **Posting date**, **Documents entered up to**, **Next payment date**, **Company codes**, **Payment methods**, **Supplier range** (from/to). Click **Save parameters**.
3. Click **Create proposal**. The **Proposal** table lists **Supplier**, **Invoice**, **Due**, **Amount**, **Method**, **Exception**. Exceptions are named, never dropped. "The proposal is empty" means no open items matched.
4. **Release**: if a release strategy applies, a **different** user must release the proposal (you cannot release a proposal you created). Generating the proposal again restarts the release.
5. Enter **House bank** (`NBK01`) and **Account ID** (`ACC01`) and click **Execute payments**. The run executes in the background; nothing posts until it finishes, then all of it or none.

> [!NOTE]
> **What Happens in the Background?** One balanced journal per supplier and bank: **Dr** vendor / **Cr** bank, clearing the paid items. The result table shows **Journal** and **Bank** per supplier. An executed run is history and cannot be run again.

### 2.5 Clearing and balances

**Clear vendor open items** (`/finance/vendor-clearing`) matches invoices against credits manually. **Vendor balances** (`/finance/vendor-balances`) and **Vendor ageing** (`/finance/vendor-ageing`) are in [Reports](reports-and-troubleshooting.md).

---

## 3. Accounts receivable

### 3.1 Enter a customer invoice

**Enter customer invoice** (`/finance/customer-invoice`). Customer invoices from sales come from [SD billing](../04-sd-sales-distribution/daily-transactions.md#5-bill-the-delivery); use this screen for direct charges (rent, fees).

Fields mirror the vendor invoice: **Customer** (`CUS-1000`), **Company code**, **Currency**, **Reference**, **Document date**, **Posting date**, **Payment terms**, **Gross amount (tax included)** and lines (**G/L account** revenue e.g. `800000`, **Net amount (tax excluded)**, **Tax code**, **Profit centre**, **Text**).

> [!NOTE]
> **What Happens in the Background?** Type `DR`: **Dr** customer reconciliation account (Trade receivables) at gross / **Cr** each revenue line and **Cr** output tax. The customer's open item appears for collection and dunning. Cancel by loading the invoice and entering a **Cancellation posting date** (mirror reversal).

### 3.2 Post an incoming payment

**Post incoming payment** (`/finance/incoming-payment`).

1. **Company code** `1000`, **Customer** `CUS-1000`, **Load open items**.
2. **Document date**, **Posting date**, **Clearing date**, **Bank / cash G/L account** `101000`, **Incoming amount**, **Currency**, **Reference**.
3. Select the invoices to settle; set **Applied**, **Discount**, **Outcome** (**Residual** / **Partial**) as needed. Put any unassigned money in **On-account amount**.
4. Post. The allocation must equal the receipt.

> [!NOTE]
> **What Happens in the Background?** Type `DZ`: **Dr** bank / **Cr** customer reconciliation account per allocation. Settled invoices are cleared under the payment document; the customer balance and ageing fall.

### 3.3 Down payments, clearing and reset

- **Post customer down payment request / Post customer down payment / Clear customer down payment** (`/finance/customer-down-payment-request`, `…-down-payment`, `…-down-payment-clearing`): the customer twin of the vendor sequence. The request is only noted; the down payment is a real receipt (**Dr** bank / **Cr** the special G/L indicator's alternative customer reconciliation account, type `DZ`), standing open outside ordinary receivables; clearing applies it to the final invoice.
- **Clear customer open items** (`/finance/customer-clearing`): choose **Customer account** and **Company code**, **Load open items**, tick items whose **Signed** total is zero, set **Clearing date**, tick **I confirm this clearing**.

### 3.4 Dunning

**Dunning programme** (`/finance/dunning`).

1. **Run parameters**: **Run date**, **Identification** (max 6, `DUN001`), **Dunning date**, **Documents posted up to**, **Company codes**, **Customer from / to**. Tick **I confirm this dunning run** and **Execute run**.
2. Review proposed accounts (**Level**, **Overdue**, **Status**). An account without a dunning procedure is **excluded with its reason**. Use **Exclude account** for any you do not want.
3. Tick **I confirm finalization** and **Finalize run**. Or **Cancel run**.

> [!NOTE]
> **What Happens in the Background?** Finalization writes one **notice per account**: a record, **never a posting**. Dunning levels advance only at finalization.

### 3.5 Credit management

- **Customer credit management** (`/finance/credit`, alias FD32): type the customer, **Load credit data**; maintain the **credit limit**, manual **hold** and reason per credit control area. Every change is kept in the **Change history** (**When**, **Field**, **Previous**, **New**, **Changed by**, **Reason**).
- **Credit exposure monitor** (`/finance/credit-monitor`): exposure against limit.
- **Release credit-blocked documents** (`/finance/credit-release`): choose **Blocked only** or **Include released**, **Display documents**. For each (**Sales document**, **Customer**, **Order value**, **Exposure / Limit**, **Utilization**, **Block reason**): **Recheck**, then **Release** with a **Reason (required)** (required to override a still-failing check), **Reblock**, or **Reject request**.

> [!NOTE]
> **What Happens in the Background?** Exposure is computed from open receivables across the companies of the credit control area. A check blocks on: no credit record, manual hold, expired or zero limit, or exceeded limit, and warns at the area's threshold. Release changes the block only; the sales clerk then repeats the delivery or goods issue.

---

## 4. Asset accounting

1. **Create asset master** (`/finance/assets/new`): **Company code**, **Asset class**, **Number of similar assets**, **Asset main number** (generated unless external numbers are configured), **Description 1/2**, **Inventory number**, **Serial number**, **Quantity**, **Unit of measure**, **Capitalization date**, **Cost centre**, **Profit centre**, **Plant**, **Location**, and per **Depreciation area**: **Depreciation key**, **Useful life (years / periods)**, **Depreciation start**. Changes: `/finance/assets/change` (and `/finance/assets`).
2. **Acquire asset against offsetting account** (`/finance/assets/acquire`): **Company code**, **Asset main number** (`AS-0000001`), **Sub-number**, **Document date**, **Posting date**, **Asset value date**, **Document type** (`AA`), **Currency**, **Acquisition amount** (`25000`), **Offsetting G/L account**, **Asset transaction type**, **Reference**, **Text**. Use **Simulate** to see the **Simulation preview** (Account / Debit / Credit) before posting. **Reverse an acquisition** is on the same page.
3. **Depreciation run** (`/finance/assets/depreciate`): **Company code**, **Fiscal year**, **Posting period**, **Run type** (**1 Planned**, **2 Repeat**, **3 Restart**, **4 Unplanned**), **Document type** (`AF`), **Posting date**; tick **Test run (simulate only)** first. The **Execution log** shows per asset **Calculated**, **Previously posted**, **Adjustment**, **Status**.
4. **Retire asset by scrapping** (`/finance/assets/retire`): choose the asset, **Retirement scope** (**Complete retirement**, **Partial — percentage**, **Partial — amount**), dates, **Reference**; **Simulate**, then post. **Reverse a retirement** is on the same page.
5. **Asset history sheet** (`/finance/assets/history`).

> [!NOTE]
> **What Happens in the Background?**
> - **Acquisition:** **Dr** the asset class reconciliation account / **Cr** the offsetting account. The asset's value is the sum of **active** acquisitions less retirements.
> - **Depreciation:** **Dr** depreciation expense / **Cr** accumulated depreciation, per asset and area, from key, useful life and start date. A repeated run posts only what is not already posted.
> - **Retirement:** **Cr** the asset account with the retired acquisition value, **Dr** accumulated depreciation for its share and **Dr** the retirement loss with the remaining book value.
> - A **simulation** posts nothing. Reversals are asset-aware: they restore the asset's values.

---

## 5. Period-end close

Do these roughly in this order each month. Most have a **Test run** that changes nothing.

| Step | Screen | What it does |
|---|---|---|
| 1 | **Accrual/deferral documents** (`/finance/accruals`) | Post an accrual with lines (**G/L Account**, **Amount**, **Cost Centre**, **Profit Centre**, **Assignment**, **Line Text**), a **Reversal Date** and **Reversal Reason**. When the date is due, process it from **Reversals due (F.81)**: the mirror document is posted and the accrual marked reversed (a retry never reverses twice) |
| 2 | **Foreign currency valuation** (`/finance/fx/valuation`) | A **test run** records only a protocol; a live run posts **one balanced adjustment document** and can optionally reverse it on a date you name |
| 3 | **GR/IR clearing account analysis** (`/finance/grir-reclass`) | Analysis never posts. Creating the accrual is a separate live step: it posts the open value per item against the GR/IR clearing account, once per item and fiscal year |
| 4 | **Advance return for tax** (`/finance/tax/report`) | **Tax Code**, **Account Key**, **Rate**, **Tax Base**, **Input Tax**, **Output Tax**, **Documents**. Leave **Test Run** ticked unless you are updating: an update run stamps lines so they are not reported twice |
| 5 | **G/L to subledger tie-out** (`/finance/subledger-tie-out`) | Compares each reconciliation account with its subledger total |
| 6 | **Period-end close cockpit** (`/finance/close-cockpit`) | A task list per company, year and period: **Release task list**, **Execute** tasks in dependency order, **Attach** evidence, **Sign off**, **Finalize task list** |
| 7 | **G/L balance carryforward** (`/finance/carryforward`) | **Test run** then **Update run**: opens balance-sheet accounts in the new year and moves the P&L result to retained earnings |
| 8 | **Consolidation** (`/config/consolidation`, `/finance/consolidation-monitor`, `/finance/consolidated-statements`) | Group-level roll-up for administrators and controllers |

> [!NOTE]
> **What Happens in the Background?** Accruals, valuation, carryforward and the cockpit's posting tasks create real documents through the same posting engine and obey open-period checks. Report tasks are never blocked by posting-period rules. **Completing a task list never closes or locks the period** — closing a posting period is a separate controlled act in [posting periods](master-data.md#7-document-types-number-ranges-and-posting-periods). The carryforward posts only the not-yet-transferred difference, so a late adjustment is picked up on a repeat run.

---

## 6. Controlling

1. **Cost centre planning** (`/controlling/cost-center-planning`): choose **Controlling area**, **Fiscal year**, **Plan version**, **Cost centre**; fill the **Plan grid** by **Cost element** and period; enter a **Reason**; **Save plan**. Plan activity prices at `/config/activity-rates`.
2. **Cost allocation cycles** (`/controlling/allocation-cycles`): define a **Cycle** (**Name**, **Category**: **Assessment** or **Distribution**, **Valid from / to**, **Receiver rule**: **Fixed percentages**, **Fixed portions**, **Fixed amounts**, **Cost elements from**, senders and receivers). **Execute cycle**: **Fiscal year**, **Period**, **Reason (required to run)**, then **Preview** and **Run**. A run can be cancelled with **Cancel run**.
3. **Internal order** (`/controlling/internal-orders`): **Order type**, **Description**, **Controlling area**, **Company code**, **Start date**, **End date**, **Cost center**, **Profit center**, **Person responsible**, **Responsible user**, optional **Reference order**. Costs posted to the order collect on it. Display at `/controlling/internal-order-display`, line items at `/controlling/internal-order-line-items`.
4. **Settlement rule** (`/controlling/settlement-rules`) names where an order's cost goes. **Actual settlement** (`/controlling/order-settlement`): **Internal order**, **Fiscal year**, **Settlement period**. **Collective actual settlement**: many orders at once.
5. **Original budget** (`/controlling/original-budget`) and **Plan revaluation** (`/controlling/plan-revaluation`).

> [!NOTE]
> **What Happens in the Background?** Planning and budget post nothing to the ledger. An allocation cycle and an order settlement move **actual** cost from sender to receiver (relieving one object and charging another); the same G/L accounts stay balanced. Production order cost settlement is covered in [PP](../03-pp-production-planning/daily-transactions.md).

---

**← Previous** [FICO master data](master-data.md) · **Next →** [FICO reports and troubleshooting](reports-and-troubleshooting.md)

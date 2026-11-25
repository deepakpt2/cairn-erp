# Controlling area `IN00` — the grep, and why I stopped

**Status: STOPPED before making the change, as the owner instructed.** The condition was met: there
*is* code that treats an area as a default, and it would pick the wrong one.

---

## 1. The grep the owner asked for

### `A000` in application code

Three hits in `src/`, and **none of them is application logic**:

| File | Line | What it is |
|---|---|---|
| `src/platform/tenancy/standard-structure.ts` | 69 | `STANDARD_STRUCTURE.controllingArea` — the fixture builder's key |
| `src/platform/tenancy/demo-organisation.ts` | 74 | The demo dataset's key |
| `src/modules/people/schema.ts` | 23 | A comment mentioning `PA0001` (an SAP infotype). Not a reference to the area. |

Outside `src/`: `walkthrough-seed.ts`, `notes/`, and many tests — all fixtures, all writing their
own `A000`. **No module reads `A000` as a constant.**

That was the first half of the check, and it passed: nothing hard-codes `A000` in posting,
reporting or lookup logic.

### The second half — and where it failed

The owner's stop condition was wider than "is `A000` hard-coded". It was *"if anything treats A000
as the tenant default (lookups, reports, CO postings)"*. That is the case, and not by name — by
**position**.

`listControllingAreas` returns every area for the tenant, ordered by code:

```ts
// src/modules/foundation/controlling-area-maintenance.ts:104
tx.select().from(controllingArea)
  .where(eq(controllingArea.client, tenant))
  .orderBy(asc(controllingArea.controllingArea)),   // ← alphabetical
```

then maps them in that order. Five screens take `areas[0]` as their default:

| Screen | Line | Code |
|---|---|---|
| Cost centre planning | `cost-center-planning/page.tsx:66` | `last(params.controllingArea) \|\| areas[0]?.controllingArea \|\| ''` |
| Allocation cycles | `allocation-cycles/page.tsx:70` | `last(params.area) \|\| areas[0]?.controllingArea \|\| ''` |
| Internal orders | `internal-orders/OrderForm.tsx:24` | `document?.controllingArea \|\| choices.areas[0]?.controllingArea \|\| ''` |
| Order settlement (collective) | `order-settlement-collective/CollectiveForm.tsx:15` | `areas[0]?.controllingArea \|\| ''` |
| Plan revaluation | `plan-revaluation/RevaluationForm.tsx:17` | `areas[0]?.controllingArea \|\| ''` |

These are not filtered. `listPlanningAreas` in particular reads **every** area with no company-code
condition:

```ts
// src/modules/foundation/cost-center-planning.ts:474
select controlling_area, name, currency from controlling_area where client = ${client} order by controlling_area
```

### Proved, not argued

I installed `IN01`, created `IN00` on `A4`, and read the list back in the order the screens read it:

```
areas in the order the screens read them:
  [0] A000 "Standard controlling area" fy=A4 companies=1
  [1] IN00 "Cairn Demo Industries"      fy=A4 companies=0

areas[0] = A000  <-- what 5 CO screens would default to
```

`A000` sorts before `IN00`, and it is the one with no company code after the move. So the five
screens would open **preselected on the empty area**, and a tester doing Phase 0.12 (cost centres),
Phase 4.4 (allocation) or 4.5 (settlement) would see an empty list and reasonably conclude the
installer had failed.

**That is the failure the stop condition exists to prevent, and it is real.**

## 2. What does *not* break

For completeness, because it narrows the fix:

| Path | Behaviour with `A000` unassigned | Verdict |
|---|---|---|
| **Login / session** | `authority.ts` reads `controllingArea` from the *position assignment* row, not from an area lookup. | Safe |
| **CO postings** | Cost centres, work centres, internal orders and settlement all resolve the area **from the company code**, not the reverse: `select ... from controlling_area_company where company_code = ...`. | Safe |
| **Work centre costing** | `work-center.ts:397` looks up the link by company code and fails only if the *company* has no area — which `IN01` does. | Safe |
| **Cost centre definition** | `listAreaCompanyCodes('A000')` returns `[]`, which the screen renders as an empty company list. No throw. | Safe, just empty |

So the product tolerates an area with no company code. The damage is confined to **five default
selections**, which is a UI-level hazard rather than a data-integrity one.

## 3. Options, for the owner to choose

I have not implemented any of these.

### Option A — a code that sorts before `A000` (recommended, and now tested)

The screens take `areas[0]` **alphabetically**. A code that sorts before `A000` makes the company's
own area the default, with **no application change at all**.

I tested the collation on the scratch cluster rather than assuming it:

```
database cairn_sort: datcollate = en_US.UTF-8

select k from (values ('A000'),('IN00'),('1000'),('1IN0')) v(k) order by k;
  1000
  1IN0
  A000
  IN00
```

and then through the product's own `listControllingAreas` with both areas present:

```
[0] 1000 "Cairn Demo Industries"      fy=A4 companies=0
[1] A000 "Standard controlling area"  fy=A4 companies=1

areas[0] would be: 1000
```

So naming the area **`1000`** (or `1IN0`) puts the live area first and the empty `A000` second,
and the five screens default correctly.

**The catch, stated plainly:** this relies on the database collation, which is `en_US.UTF-8` here
and **must be re-tested on the test host** before anyone relies on it. `lc_collate` is a
cluster-creation setting; a host on `C` collation sorts differently (there, `'1'` < `'A'` still
holds, but I would not build on an untested assumption twice).

- Alternative under A: keep `IN00` and accept that the five screens default to `A000` until the
  tester picks `IN00` once. Each screen keeps the selection afterwards, so it is a one-time
  annoyance rather than a recurring one.

### Option B — `IN00` and **do not leave `A000` unassigned**

Keep `IN01` on `A000` as the standard structure left it, and create `IN00` only if a second company
ever needs one. This is what the code does today, and it means the installer keeps its four-step
fiscal-year move.

This contradicts the instruction ("move IN01 to it"), so I am listing it rather than choosing it.

### Option C — accept the hazard and document it

Keep `IN00`, leave `A000` empty, and add a line to `00-HOW-TO-START.md`: *"on these five screens,
select controlling area IN00 — the default is A000, which is unused."*

Cheapest, honest, and it puts the burden on the tester not to misread an empty screen. I do not
like it for a UAT whose purpose is to find problems in the product rather than in the setup.

### Option D — fix the screens (application change)

Filter `listControllingAreas` / `listPlanningAreas` to areas with a company code assigned, or carry
the company code's area into the default. This is arguably right — an area with no company code
cannot be planned against — but it is **application code**, and it needs the same approval every
other application change has needed.

## 4. What I need from you

Which of A–D. My recommendation is **A if the collation test passes, D if you are willing to touch
application code, and C only as a last resort.** B does not meet your instruction.

The grep result on its own — *"no application code hard-codes `A000`"* — would have let me proceed.
The second half of your condition is what caught it, and I am glad you wrote it that way.

# CAIRN — Project Log & Technical Specification (continued)

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-18 (v2.170) · **Part 5 of 5 — this is the live part**
**Continues:** [CAIRN.md](CAIRN.md) (§0–§26.35) · [CAIRN-2.md](CAIRN-2.md) (§26.36–§30 through v1.69) · [CAIRN-3.md](CAIRN-3.md) (§0.3, §1.4 R-24–R-72, §2.1 D-093–D-139, §26.167–§26.259, §30 v1.70–v2.61) · [CAIRN-4.md](CAIRN-4.md) (§1.4 R-73–R-98, §26.260–§26.364, §30 v2.62–2.169)
**Owner:** Deepak (product owner) · Built with Arena.ai Agent Mode

---

## §0.3 Document-set size and rotation rule `AGREED · v1.70`

The rule recorded in `CAIRN-3.md` §0.3 (R-24 / D-093) is unchanged and binding: no part may exceed
400,000 bytes; a live part rotates as soon as it passes 360,000 bytes; the next part continues section
and version numbering without a gap; both the outgoing and the incoming part carry a continuation
notice; a rotated part is frozen to pointer edits and corrections that cannot be deferred; size is
measured on disk in the same turn any canonical file is edited.

**Set status at v2.170 (2026-10-18):**

| Part | Sections | Size at rotation check | State |
|---|---|---|---|
| `CAIRN.md` | §0–§26.35 | 395,959 bytes (99.0 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-2.md` | §26.36–§30 (through v1.69) | 398,255 bytes (99.6 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-3.md` | §0.3, §1.4 R-24–R-72, §2.1 D-093–D-139, §26.167–§26.259, §30 v1.70–v2.61 | 354,009 bytes at rotation | **FROZEN** — pointer edits only |
| `CAIRN-4.md` | §1.4 R-73–R-98, §26.260–§26.364, §30 v2.62–2.169 | 407,238 bytes at rotation | **FROZEN** — pointer edits only |
| `CAIRN-5.md` | §1.4 R-99+, §26.365+, §30 from v2.170 | new — this part | **LIVE** |

---

## §1.4 Requirements — later clarifications, continued

| ID | Requirement | Source / detail |
|---|---|---|
| R-99 | **Material number range groups (SCR-051 / MMNR): named internal+external interval groups over the standing engine, type assignment by key pair, and MM01 drawing and validating numbers** | The owner's MMNR package, adapted to what already stands — its own constraint governs: where the ERP already holds the configuration, extend it rather than duplicate it. **No new interval or assignment tables:** material intervals remain `number_range` rows for object `MATERIALNR`, company `*`, the two-character range number as sub-object (the NRRANGENR equivalent), fiscal year 0 — material numbering is not year-dependent; material types keep their SCR-048 `internal_number_range` / `external_number_range` columns (the NUMKI/NUMKE equivalents) with storage untouched. **The group table:** a tenant table `material_number_range_group` whose primary key is the key pair itself — `(client, internal_range_key, external_range_key)` — at TNRGT parity, carrying one description of at most 20 characters (the TXT width; one tenant language per B-223, so no language rows) and the four audit columns behind tenant RLS. Group identity **is** the pair: both keys are immutable once the group stands (a correction is delete-and-recreate while unassigned), while the description is editable at any time without touching allocation. **Judged maintenance:** the internal key must name a standing ACTIVE internal `MATERIALNR` interval and the external key a standing ACTIVE external one, failures named with their remedy; a duplicate pair is refused; deletion is refused while any material type carries the pair, the count named. Interval deletion remains refused-by-design (SCR-050: blocking is the disable), so a group's intervals can never be deleted from under it; a later-blocked interval shows its status in the matrix and the standing judges govern type saves and creation. **The MMNR screen** `/config/material-number-ranges` under a new activity `CFG.INV.MATERIALRANGE.DEFINE` (term *Define material number ranges*, MMNR a search alias only): a group–interval matrix — each group with both keys, both intervals' bounds, current numbers, statuses and assignment kinds — a non-consuming next-number preview per interval, the types assigned to each group listed from their standing key pairs, and ungrouped `MATERIALNR` intervals listed beneath so no interval hides. The first successful group write completes the activity, as standing screens do. **OMS2 (material types):** a type whose key pair matches a group shows the group's text beside its keys, and the type form gains a group picker that fills both key fields; the keys remain directly editable and judged exactly as SCR-048 judges them. Group membership is always derived from the pair, never stored on the type. **The MM01 tail (materials BASIC create):** leaving the material number blank draws the next number from the type's internal range through `allocateNumber` (`MATERIALNR`, `*`, the internal key, year 0) inside the creation transaction — the number is the drawn value as plain digits, and the allocation row stands as its audit; supplying a number judges it against the type's ACTIVE external interval: all digits, within bounds, leading zeros normalised for the comparison — a non-numeric supplied number is refused with its remedy, the standing engine's intervals being numeric. Maintaining an existing material never re-judges its number; the number is identity. A type missing its internal key cannot draw and fails with the material-type maintenance named; a **supplied** number is judged only where the type carries an external range — a type with no external range keeps MM01's standing free entry, the judge binding where configuration speaks (stage-3 evidence: the standing material master creates freely against rangeless delivered types, and binding there would rework every standing consumer for no configured gain). Reassigning a type between groups changes future creation only, never a standing material number, and issued numbers are never recycled. |
| R-100 | **Material master at MM01 parity (SCR-052): the 40-character description, a maintained industry-sector master, and the standing master confirmed against the package** | The owner's MM01 package audited against the standing material master, with four forks answered: the description caps at **SAP parity (40)**, the industry sector gains a **built master**, the deletion flag **defers to the next round**, and view handling **keeps the standing per-view saves**. Much of the package already stands and is confirmed, not rebuilt: the 40-character material number with SCR-051's internal draw and external judge, the immutable material type, group and unit judging, net-never-over-gross with its unit context, valuation class judged against the type's permitted classes, price control S/V with prices and price unit, derived valuation currency, price-change-with-stock refused, the base unit frozen once organisational views stand, per-view completeness statuses, and one audited change document per view. **The description** narrows from 200 to 40 in column, service and form (MAKTX width); it stays a single tenant-language text on the material row — no language table, per B-223. **The industry sector** becomes a tenant master `industry_sector`: a one-character key, a name, an active flag, the four audit columns behind tenant RLS, maintained on its own config screen (activity `CFG.INV.INDUSTRYSECTOR.DEFINE`, OMS3 a search alias only) in the standing master shape — key never renamed, deletion refused while materials carry the sector with the count named, deactivation standing beside it. The standard sectors are delivered per tenant (`A` plant engineering and construction, `C` chemical industry, `M` mechanical engineering, `P` pharmaceuticals, `R` retail); standing materials carrying the free-text `MANUFACTURING` convert to `M` in the migration, and any other value that is not a standing sector key converts to `M` as the manufacturing default, this row being the record. MM01's basic view requires a standing active sector and judges it on every save; the form picks from the master. **Deferred and recorded:** the deletion flag (LVORM) at general and plant scope is the next round's round (SCR-053); per-type view permissions and field selection, the initial view-selection step, storage-location and sales views, and language-dependent descriptions stay unbuilt — the standing per-view transactional saves are the confirmed pattern. First successful sector write completes the new activity, as standing screens do. |
| R-101 | **Material deletion flags (SCR-053 / MM06): client- and plant-level flags on the standing material master, reversible, warned — never a blanket lock** | The owner's corrected MM06 package, with SAP keywords confined to search aliases as always. **Scope:** a boolean flag on the material (client level) and on each plant record (plant level), added to the standing tables — no duplicate masters; valuation follows its plant's flag, Cairn valuing per plant. A plant flag never sets the client flag and the client flag never writes plant rows; the client flag simply covers every plant for display and judging, exactly the package's hierarchy rule. **The act:** setting or cancelling either flag is its own act on the material screen — explicit confirmation, mandatory reason (the standing Cairn rule, stricter than the package's optional field), one change document per act naming the scope, the flag security-relevant — judged under the standing material-maintenance authority. **Effect, at the package's parity:** the flag is a marker, **not** a posting lock: flagging is never refused for stock or open documents, and no standing process stops on it. The flag dialog warns in numbers — stock standing at the scope is named before confirming — and flagged materials show their flag on the material screens. One Cairn business rule stands beside the marker: a client-flagged material refuses **new plant extensions** (clear the flag first), new business use of a to-be-deleted material being the one act the flag forbids outright; plant-level flags forbid nothing in master maintenance. Cancellation is always possible before any deletion process exists. **Deferred, recorded here so the end-of-round report can name them:** storage-location-level flags (Cairn holds no material/storage-location records to flag), scheduled flagging with a future effective date (no scheduling or activation process exists), archiving and physical deletion under MM_MATNR/MM70/MM71 (a separate process by the package's own lifecycle), and per-process enforcement in goods movements and documents (no movement posting exists yet to check the flag; when one lands it must judge it — this row is the obligation). |

---

## §26 · Phase 1 screen inventory — continued

---

### 26.365 B-349 — SCR-051 stage 1: the inert material number range screen

The MMNR round opens with the screen's shape and nothing behind it: `/config/material-number-ranges` renders the group–interval matrix (each group with its internal and external interval keys, bounds, current numbers, a non-consuming next-number preview, and its assigned material types) over an ungrouped-intervals table, fed empty until the service lands. Two i18n keys (`materialRange.title`, `materialRange.subtitle`) carry the wording. The activity code `CFG.INV.MATERIALRANGE.DEFINE` is named here ahead of its seeding in stage 4. Nothing reads or writes; stage 2 brings the group table.

---

### 26.366 B-350 — SCR-051 stage 2: the group table stands

Migration `0062` creates `material_number_range_group` — client (cascading from the tenant), the internal and external range keys as the pair primary key with their two-character format checks, the 20-character description, and the four audit columns — and `9042` puts it behind the standing tenant-isolation RLS pattern (forced, one policy on `cairn.client`, DML for `cairn_app`). The Drizzle table stands beside `materialGroup` in `src/modules/inventory/schema.ts`. Verified on `cairn_b210`: the table stands with row security enabled and forced and its one policy in place; **106 migrations now stand**. No service reads or writes it yet — that is stage 3.

---

### 26.367 B-351 — SCR-051 stage 3: the group service, both screens and the MM01 tail live

The round's whole backend lands as one stage, as staged: `material-number-range-groups.ts` maintains the groups — CREATE judging both intervals standing ACTIVE with the right assignment kind against the `MATERIALNR` engine rows, the pair immutable after creation (identity, with the delete-and-recreate remedy stated on the screen), the description freely editable, deletion refused while material types carry the pair with the count named, every write one change document under `material_number_range_group` with a mandatory reason and the first successful write completing `CFG.INV.MATERIALRANGE.DEFINE`. The MMNR screen goes live over it (matrix, ungrouped intervals, create/change/delete), the material-types screen shows the standing group's text beside a type's keys and gains the group picker that fills both key fields — membership always derived from the pair, never stored — and `listMaterialTypes` reads the derived text.

**The MM01 tail.** BASIC create with a blank number draws through `allocateNumber` (`MATERIALNR`, `*`, the type's internal key, year 0) inside the creation transaction, the drawn value standing as the material number with its allocation row as audit. A supplied number is judged against the type's ACTIVE external interval — all digits, within bounds. One refinement the stage's own evidence forced, recorded against R-99 above: the judge binds **only where the type carries an external range**. The first cut refused supplied numbers against rangeless types, and the standing material master — whose delivered types carry no ranges and whose consumers create freely — failed across its suite; the judge now speaks where configuration speaks and MM01's free entry stands untouched where it does not. A blank number against a type with no internal range still fails, naming the material-type maintenance: drawing was impossible before this round, so nothing standing is refused.

**Gates.** Typecheck and `lint:ip` clean; production build compiled (material-number-ranges 2.36 kB); the four material suites pass (14 + 29). The full suite and the browser target are stage 5's evidence, as staged.

---

### 26.368 B-352 — SCR-051 stage 4: the activity seeded and the route built

The new activity `CFG.INV.MATERIALRANGE.DEFINE` stands in all three seed registers: the capability, the configuration activity (materials-management area, after material types and number ranges, onboarding stage, route `/config/material-number-ranges`), and the term *Define material number ranges* with MMNR as a search alias only and the full parity description. The route joins `BUILT_ROUTES` so the workbench offers it. `npm run seed` reads back **90 capabilities / 62 activities / 59 terms / 55 aliases** — one more of each than SCR-050 closed with, the term's route verified in the registry.

---

### 26.369 B-353 — SCR-051 / MMNR closed and accepted: material number range groups and MM01 number assignment

**What shipped across the five stages.** On the SCR-050 engine, material numbering gained its group layer at the owner's parity: a tenant table `material_number_range_group` keyed by the internal+external range-key pair itself (TNRGT shape, 20-character text, forced tenant RLS), maintained on the new `/config/material-number-ranges` screen — creation judged against standing ACTIVE intervals of the right assignment kind, the pair immutable as identity, the description freely editable, deletion refused while material types carry the pair with the count named. The screen reads as the group–interval matrix the contract specified, with bounds, current numbers, a non-consuming next-number preview, derived type assignment, and ungrouped intervals listed so nothing hides. The material-types screen shows the standing group's text beside a type's keys and offers the group picker that fills both key fields — membership always derived from the pair, SCR-048's storage untouched. And MM01 numbers itself: a blank material number draws the next internal number through the standing engine inside the creation transaction (allocation row as audit), while a supplied number is judged against the type's external interval **where one is configured** — the stage-3 refinement, recorded in R-99, that keeps MM01's standing free entry for rangeless types. No new interval or assignment tables exist; the package's own constraint — extend what stands rather than duplicate it — governed throughout. CAIRN-4 rotated into this part at the round's opening (407,238 bytes, frozen).

**Acceptance evidence.** Service tests **4/4** (`tests/material-number-range-groups.test.ts`: creation judged — missing interval, wrong assignment kind, identical keys, duplicate pair; the matrix with derived assignment and ungrouped intervals; deletion refused under the carrying type then free after reassignment, its CREATE/CHANGE/DELETE trail standing; MM01 drawing 2000 then 2001, accepting 6500 within the external interval, refusing 5500 outside it and `EXT-1` as non-numeric, keeping free entry for the rangeless RAW while refusing to draw for it). Browser target `material-number-ranges` (T946) **7/7 journeys** against the production build: ungrouped intervals read, the group defined through the screen, OMS2 assigning RAW by the picker with the group text standing beside its keys, deletion refused in the dialog, MM01's blank number drawing 1000 with the counter standing at it, and the database remembering all of it. Neighbouring targets `material-types` (T949) and `number-range-objects` (T947) passed undisturbed. The one mid-round failure — the first strict judge refusing supplied numbers against rangeless types — was caught by the standing material suite and corrected within stage 3 before anything shipped, exactly the refusal the suite exists to give.

**Gates.** `npm run typecheck` and `lint:ip` clean; production build compiled (material-number-ranges 2.36 kB); suite **1233 tests across 147 files**; **106 migrations** standing; seed **90/62/59/55** read back.

**Cost.** Measured: 04:40 in to 05:04 — **24 minutes** across the contract flow (including the CAIRN-5 rotation) and five stages, every stage inside its 39-minute box, despite one environment wipe mid-round (dependencies, database and browser restored from the standing script).

**What stands after this.** Material numbering is complete end to end: intervals (SNRO), groups (MMNR), type assignment (OMS2), and creation drawing or judging numbers (MM01). The next round opens with the owner's word or package.

---

### 26.370 B-354 — SCR-052 stage 1: the inert industry-sector screen

The round's new master opens as shape only: `/config/industry-sectors` renders the sector grid (key, name, material count, status) fed empty, under the activity code `CFG.INV.INDUSTRYSECTOR.DEFINE` the seeding stage will register, with its two i18n keys. The description narrowing, the sector table and the MM01 judging are the following stages, as staged.

---

### 26.371 B-355 — SCR-052 stage 2: the sector table and the narrowed material columns

Migration `0063` creates `industry_sector` (one-character key with its format check, 40-character name, active flag, audit columns), delivers the five standard sectors to every standing tenant, converts standing materials — `MANUFACTURING` and anything not a delivered key becomes `M` — and narrows both material columns: `industry_sector` to `varchar(1)`, `description` to the reference `varchar(40)`. The narrowing was verified lossless before it ran: no standing description exceeds 40 characters. `9043` puts the table behind the standing forced tenant RLS. The Drizzle table stands in `src/modules/inventory/schema.ts` beside the other inventory masters. **108 migrations now stand.** One false start, corrected in-stage: the sector name first stood at 30 characters and `Plant engineering and construction` (34) refused it — the name stands at 40, the house reference width.

---

### 26.372 B-356 — SCR-052 stage 3: the sector service live, MM01 judging, and the 40-character description enforced

The sector master gains its service in the standing shape (`industry-sector-definition.ts`: judged create and rename, deactivate/reactivate, delete refused while materials carry the sector with the count named, one change document per write under `industry_sector`, the first successful write completing `CFG.INV.INDUSTRYSECTOR.DEFINE`), the screen goes live over it, and onboarding delivers the five standard sectors from `applyMaterialDefaults`. The material master closes its two contract gaps: the basic view now **requires a standing active industry sector on create and judges any sector named**, the form picking from the master, and the description is capped at 40 in service and form (the column narrowed in stage 2). Standing fixtures carrying the old free-text `MANUFACTURING` were converted to `M` — the development fixture, the material suites — as the migration converted standing data. The other views were untouched; per-view saves stand as the owner ruled.

**Gates.** Typecheck and `lint:ip` clean; production build compiled (industry-sectors 2.3 kB); the four material suites pass (41 tests). The full suite and the browser target are stage 5's evidence, as staged.

---

### 26.373 B-357 — SCR-052 stage 4: the sector activity seeded and the route built

`CFG.INV.INDUSTRYSECTOR.DEFINE` stands in all three seed registers: the capability, the configuration activity (materials-management area, onboarding stage, route `/config/industry-sectors`), and the term *Define industry sectors* with OMS3 as a search alias only and the full parity description. The route joins `BUILT_ROUTES`. `npm run seed` reads back **91 capabilities / 63 activities / 60 terms / 56 aliases**.

---

### 26.374 B-358 — SCR-052 / MM01 closed and accepted: the material master at parity, with its sector master

**What shipped across the five stages.** The owner's MM01 package was audited against the standing material master rather than rebuilt: the numbering (SCR-051), type immutability, group and unit judging, weight consistency, valuation-class judging against the type's permitted classes, price control with price unit and derived currency, price-change-with-stock refused, the frozen base unit, per-view completeness statuses and per-view transactional saves all already stood and are confirmed. The round built the two ruled gaps. **The description** stands at the reference 40 characters in column, service and form (verified lossless against standing data). **The industry sector** became a maintained tenant master — `industry_sector` behind forced RLS, the five standard sectors delivered to every tenant at onboarding and by migration, standing `MANUFACTURING` values converted to `M` in data and fixtures alike — maintained on `/config/industry-sectors` in the standing master shape, and MM01 now requires a standing active sector on create and judges any sector named, the form picking from the master. LVORM, per-type view permissions and the view-selection step were ruled out of this round and stand recorded in R-100 (LVORM is the next round's).

**Acceptance evidence.** Service tests **3/3** (`tests/industry-sector-definition.test.ts`: the five delivered sectors read back, the master maintained through create/rename/deactivate/delete with its trail, MM01 refusing a blank sector, an unknown sector and an inactive one, the 41st description character refused, and the carrying sector refusing deletion with its count named). Browser target `industry-sectors` (T945) **7/7 journeys** against the production build: the delivered sectors standing, a sector defined and renamed through the screen, MM01 creating under the picked sector, the carrying sector refusing deletion, and the database remembering. Neighbouring targets `material-number-ranges` (T946) and `material-types` (T949) passed undisturbed. One standing fixture — the action-security material form, which predates the sector requirement — gained its sector field in-stage; the suite's refusal there was the new judge working, not a regression.

**Gates.** `npm run typecheck` and `lint:ip` clean; production build compiled; suite **1237 tests across 148 files**; **108 migrations** standing; seed **91/63/60/56** read back.

**Cost.** Measured: 05:21 in to 05:42 — **21 minutes** across the audit, the owner's four rulings, the contract and five stages, every stage inside its 39-minute box, despite two environment wipes restored from the standing script.

**What stands after this.** The material master is at the package's parity with one recorded deferral: the deletion flag (LVORM) at general and plant scope — SCR-053, the next round by the owner's ruling. Per-type view permissions, the view-selection step, storage-location and sales views, and language-dependent descriptions remain recorded-unbuilt in R-100.

---

### 26.375 B-359 — SCR-053 stage 1: the deletion-flag panel stands inert

The MM06 round opens on the material screen: a deletion-flag panel under the material summary showing the flag status at the client level and at each plant the material is extended to, with the stock standing at each scope and the contract's plain-English note — a marker, not a lock, deleting nothing. It renders standing data only (nothing flagged, the columns do not exist yet); the acts arrive with the service in stage 3. Six i18n keys carry the wording.

---

### 26.376 B-360 — SCR-053 stage 2: the flag columns stand

Migration `0064` adds `marked_for_deletion` (boolean, default false) to `material` and `material_plant` — the two scopes Cairn holds — with the Drizzle columns beside them. Both tables already stand behind tenant RLS, so no policy migration follows. **109 migrations now stand.** Nothing reads or writes the flags yet; the acts are stage 3.

---

## §30 · Change log (continued)

| Ver | Date | Change | By |
|---|---|---|---|
| 2.170 | 2026-10-18 | **CAIRN-5 opens; SCR-051 / MMNR contracted (R-99).** `CAIRN-4.md` passed the 360,000-byte rotation trigger (407,238 bytes) and is frozen to pointer edits; this part continues §1.4 from R-99, §26 from 26.365 and this log from 2.170 (§0.3 / D-093). The owner's MMNR package is recorded as R-99: no new interval or assignment tables (the standing `number_range` and SCR-048 type keys already hold them, per the package's own constraint), a group table keyed by its internal+external range-key pair with a 20-character text, the MMNR group–interval matrix screen, group display and picking on the material-types screen, and MM01 drawing internal numbers and judging supplied numbers against the external interval. | Agent |
| 2.171 | 2026-10-18 | **SCR-051 stage 1 published (B-349, §26.365).** The inert MMNR screen `/config/material-number-ranges`: group–interval matrix and ungrouped-intervals table rendered empty, i18n keys added. No reads, no writes. | Agent |
| 2.172 | 2026-10-18 | **SCR-051 stage 2 published (B-350, §26.366).** Migrations `0062` + `9042` create `material_number_range_group` (pair primary key, 20-character text, audit columns, forced tenant RLS) and its Drizzle table; verified standing on `cairn_b210` — 106 migrations. | Agent |
| 2.173 | 2026-10-18 | **SCR-051 stage 3 published (B-351, §26.367).** The group service, the live MMNR screen, group display and picking on the material-types screen, and the MM01 tail (blank draws internal, supplied judged against the external interval where one is configured — the stage-3 refinement recorded against R-99). Typecheck, `lint:ip`, build and the material suites green. | Agent |
| 2.174 | 2026-10-18 | **SCR-051 stage 4 published (B-352, §26.368).** `CFG.INV.MATERIALRANGE.DEFINE` seeded as capability, configuration activity and term (MMNR search alias only, full parity description); the route joins `BUILT_ROUTES`. Seed reads back 90/62/59/55. | Agent |
| 2.175 | 2026-10-18 | **SCR-051 / MMNR CLOSED and accepted (B-353, §26.369).** Stage 5 ships 4 service tests and the T946 browser target `material-number-ranges` (7/7 journeys against the production build — group defined through the screen, RAW assigned by the OMS2 picker, deletion refused, MM01 drawing 1000, the database remembering). Neighbouring `material-types` and `number-range-objects` targets, typecheck, `lint:ip` and the production build clean; suite 1233 across 147 files, 106 migrations, seed 90/62/59/55. Cost measured at 24 minutes overall. | Agent |
| 2.176 | 2026-10-18 | **SCR-052 / MM01 contracted (R-100).** The owner's MM01 package audited against the standing material master: most of it already stands (numbering, judging, valuation, per-view statuses) and is confirmed; the round builds the two ruled gaps — the description narrowing to 40 and a maintained industry-sector master with MM01 judging (standing `MANUFACTURING` converting to `M`) — and defers LVORM to SCR-053, per-type view permissions, the view-selection step and further views recorded as unbuilt. | Agent |
| 2.177 | 2026-10-18 | **SCR-052 stage 1 published (B-354, §26.370).** The inert industry-sector screen `/config/industry-sectors` (OMS3 search alias in its heading code), grid rendered empty, i18n keys added. No reads, no writes. | Agent |
| 2.178 | 2026-10-18 | **SCR-052 stage 2 published (B-355, §26.371).** Migrations `0063` + `9043` create the industry-sector master (delivered sectors per tenant, `MANUFACTURING` converted to `M`, forced tenant RLS) and narrow the material description to 40 and sector to 1 character, verified lossless; Drizzle tables updated — 108 migrations. | Agent |
| 2.179 | 2026-10-18 | **SCR-052 stage 3 published (B-356, §26.372).** The industry-sector service and live screen, sectors delivered at onboarding, MM01 requiring and judging the sector with the description capped at 40, standing fixtures converted to `M`. Typecheck, `lint:ip`, build and the material suites green. | Agent |
| 2.180 | 2026-10-18 | **SCR-052 stage 4 published (B-357, §26.373).** `CFG.INV.INDUSTRYSECTOR.DEFINE` seeded as capability, configuration activity and term (OMS3 search alias only); the route joins `BUILT_ROUTES`. Seed reads back 91/63/60/56. | Agent |
| 2.181 | 2026-10-18 | **SCR-052 / MM01 CLOSED and accepted (B-358, §26.374).** Stage 5 ships 3 service tests and the T945 browser target `industry-sectors` (7/7 journeys against the production build — delivered sectors standing, define/rename through the screen, MM01 creating under the picked sector, the carrying sector refusing deletion, the database remembering); one standing security fixture gained its sector. Neighbouring `material-number-ranges` and `material-types` targets, typecheck, `lint:ip` and the production build clean; suite 1237 across 148 files, 108 migrations, seed 91/63/60/56. Cost measured at 21 minutes overall. | Agent |
| 2.182 | 2026-10-18 | **SCR-053 / MM06 contracted (R-101).** The owner's corrected MM06 package: client- and plant-level deletion flags on the standing material tables as confirmed, reasoned, reversible acts — a marker with stock warnings, never a blanket lock, refusing only new plant extensions under a client flag. Storage-location flags, scheduled flagging, archiving/physical deletion, and goods-movement enforcement are recorded as deferred in R-101 for the end-of-round report. | Agent |
| 2.183 | 2026-10-18 | **SCR-053 stage 1 published (B-359, §26.375).** The inert deletion-flag panel on the material screen: client and plant scopes with their standing stock, rendered unflagged until the service lands. No writes. | Agent |
| 2.184 | 2026-10-18 | **SCR-053 stage 2 published (B-360, §26.376).** Migration `0064` adds the deletion-flag columns to the material and plant tables with their Drizzle columns — 109 migrations. | Agent |

---

*End of this part for now. This part is the live canonical log: it is updated in the same turn as any
change to code, schema, decision or scope (§0.1). When it passes 360,000 bytes, the next part
`CAIRN-6.md` begins and this file states that the set continues there (§0.3 / D-093).*

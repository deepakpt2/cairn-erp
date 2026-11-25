# The controlling area: what `A000` is, and whether IN01 should have its own

**Answer to the question asked, in one paragraph.** `A000` is *not* shared and *not* a system-wide
default. It is **tenant-scoped**: it lives in `IN01`'s own tenant and is attached to exactly one
company code, `IN01`. But it *is* a generic placeholder — created by the standard structure with
the name "Standard controlling area" and scope `SINGLE` — and the installer has to move it from
the calendar-year variant onto `A4` to make the company code usable. That move is what I would
rather avoid. **Proposal: give `IN01` its own controlling area, `IN00`, in the India fixtures, and
leave `A000` untouched.** Not changed yet — awaiting approval.

---

## 1. What `A000` actually is

Verified by installing into a scratch database and reading the rows:

```
controlling_area | name                      | scope  | fy variant | company codes
A000             | Standard controlling area | SINGLE | A4         | IN01
```

| Property | Value | Evidence |
|---|---|---|
| Tenant-scoped? | **Yes** | `controlling_area` primary key is `(client, controlling_area)` — `foundation/schema.ts:740`. Each tenant has its own `A000`. |
| Shared across tenants? | **No** | Row-level security is `client = current_setting('cairn.client')`. One tenant cannot see another's. |
| A system default? | **Yes, in the sense that matters** | Created by `standard-structure.ts` with a fixed code and the generic name `Standard controlling area`. Not configurable, not named after the company. |
| How many company codes? | **One** — `IN01` | `company_code_scope = SINGLE`, and exactly one row in `controlling_area_company`. |
| Another company code on it? | **No** | Only `IN01` is attached. There is no second company code in this tenant. |
| Who created it? | `standard-structure.ts` via `applyStandardStructure` | Not the installer directly; the installer calls the standard structure, which inserts `A000` and links the company code to it. |

So: **not shared**, but **generic and hard-coded**, and `SINGLE`-scoped.

### The cost of leaving it

The fiscal-year change is the problem. `A000` arrives on `K4` (calendar year). The company code
must be on `A4` (April–March). The two must agree, and each refuses to change while the other
disagrees — from both directions:

- `upsertCompanyCode` → `assertCompanyCodeFinancialSettingsCompatible` checks the areas linked to
  it;
- `saveControllingArea` → `assertScopeCompatible` checks every company code assigned to it.

There is no ordering that changes one while they are linked. The installer therefore does this,
and it is the only way to keep the result valid:

1. unlink `IN01` from `A000` (through OX19's own `unassignCompanyCodeFromControllingArea`),
2. move `A000` to `A4` (through `saveControllingArea`),
3. change the company code to `A4`,
4. relink (through `assignCompanyCodeToControllingArea`).

It works, and it is the operator's own documented route. But it means Phase 0 performs **four
structural edits and writes change documents for each**, on an object that is a placeholder the
company never chose. A tester reading the change log for `A000` sees "Standard controlling area"
being relinked and re-yearended, which is noise in an audit trail.

## 2. The proposal: `IN00` in the India pack

| | Today (`A000`) | Proposed (`IN00`) |
|---|---|---|
| Code | `A000` — generic, from the standard structure | `IN00` — the company's own |
| Name | "Standard controlling area" | "Cairn Demo Industries" |
| Created by | `standard-structure.ts` | the India fixtures, via `saveControllingArea` |
| Fiscal year | `K4` at creation, moved to `A4` by the installer | `A4` at creation — no move |
| Steps in Phase 0 | unlink, move area, move company, relink | create `IN00`, point the company at it |
| Change documents | four, on a placeholder | one, on an object the company owns |
| `A000` afterwards | mutated | **untouched**, as the standard structure left it |

### Is it feasible? Verified, not assumed

I created the fresh tenant `IN02` and called the real service:

```
CREATE IN00: OK
areas: A000/K4/1 companies, IN00/A4/0 companies
```

A second, company-named controlling area on `A4` is created cleanly by `saveControllingArea`. The
code format accepts four alphanumerics (`^[A-Z0-9]{4}$`), so `IN00` is valid. `A000` stays on `K4`
with its one company — and in the proposed arrangement, `IN01` would move to `IN00`, leaving
`A000` with none, which the product allows (a controlling area with no company code is a valid,
if unused, object).

### What would have to change

Small, and all in the installer and fixtures — **no application code**:

| File | Change |
|---|---|
| `fixtures/core/organisation.json` | `structure.controllingArea`: `A000` → `IN00` |
| `fixtures/country/IN/country-pack.json` | Add the area's name and scope to the country pack (an Indian company names its own area; the *practice* of one area per company is country-neutral, so the key can live in `core` and the name in the company folder) |
| `src/platform/tenancy/in01-phase0.ts` | Create `IN00` through `saveControllingArea`, then `upsertCompanyCode` pointing at it; **delete** `unlinkAreaAssignment`, `moveControllingAreaToVariant` and `restoreAreaAssignment` |
| Cost centres, profit centres | They currently take `controllingArea: structure.controllingArea`; that value becomes `IN00` with no other change |

Net: the installer gets **shorter**, and Phase 0 stops mutating a platform default.

### One question for you before I build it

The standard structure will still create `A000` and link `IN01` to it, because that is what
`applyStandardStructure` does and the installer calls it. So the proposed flow is:

1. let the standard structure create `A000` and link `IN01` to it (unavoidable — it is how the
   structure is built),
2. create `IN00`,
3. **move `IN01` from `A000` to `IN00`** (one unlink + one link, or `assignCompanyCodeToControllingArea`
   refuses because `IN01` is already owned elsewhere — `alreadyAssignedElsewhere`),
4. `A000` is left on `K4` with no company code.

That is **two** structural writes instead of four, and `A000` keeps its original fiscal year. It
is simpler and leaves the default alone in the way that matters. But it cannot avoid the unlink,
because a company code can belong to only one controlling area.

**Do you want that** — `IN00` created, `IN01` moved to it, `A000` left on `K4` and unlinked? Or
would you rather I leave the current four-step move in place and simply document why?

## 3. What I have changed, and what I have not

- **Not changed:** the controlling area. `A000` is exactly as it was, and the installer still
  performs the four-step move. The proposal above is not built.
- **Changed for other reasons, and reported separately:** the company code was installing as
  `1000` (the neutral core's value) instead of `IN01` (the company fixture's). That is a defect I
  introduced, it is fixed, and the company code now installs as `IN01`. It is worth knowing about
  here because it is the same class of mistake — a value in the wrong layer — and because the
  `A000` proposal touches the same file.

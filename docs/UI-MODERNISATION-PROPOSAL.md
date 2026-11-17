# Cairn Mobile UI Proposal

Status: proposal, for approval. Scope: **make the existing app usable on phones and tablets, best effort.** The desktop UI is not changed. No change to business rules, service functions, `actions.ts`, routes, permissions, the database, or what each screen shows.

Revision note: earlier drafts covered a desktop visual refresh, a component library, PWA and more. Dropped. Only mobile is needed, and every screen should keep showing everything it shows today.

## 1. Principles

1. **Desktop is untouched.** Every mobile rule is scoped to small screens (below the `md` breakpoint, 768px) in CSS media queries or `max-md:` utilities. Above that width nothing renders differently.
2. **Everything stays visible.** No hidden columns, accordions, tabs or card conversions. Same fields, same order, same columns.
3. **Best effort, in layers.** A global CSS layer fixes most pages at once. Then we fix what is still broken, worst pages first. No promise that all 308 pages are perfect, and the heaviest configuration screens may remain "usable but clumsy".
4. **No new dependencies.** Plain CSS and Tailwind already in the repo.

## 2. What is wrong today (from code review)

| Area | Finding |
|---|---|
| Viewport | `width=device-width, initial-scale=1` is set, so the page does render at phone width. No `theme-color`, no safe-area handling. |
| Type and inputs | Body is 13.5px, inputs smaller than 16px. iOS Safari zooms the page when such an input is focused. |
| Touch targets | Buttons, links and inputs are sized for a mouse; many are well under 44px tall. |
| Tables | 429 `<table>`s styled as `.grid-table`. A small-screen override exists but there is no consistent horizontal-scroll container, so wide tables push the whole page sideways. |
| Forms and grids | Many layouts use `sm:`/`lg:` multi-column grids (about 2,400 `sm:` uses against 34 `md:`), so breakpoints are inconsistent and some two-column forms never collapse cleanly. |
| Shell | Sidebar is already a drawer below `md` (focus trap, Escape, scroll lock). Command bar, session bar and status bar are desktop-shaped and wrap awkwardly. Action buttons sit at the top or bottom of long pages. |

Phase 0 below measures this instead of guessing.

## 3. Approach

### Layer A: global mobile CSS (`globals.css`, one media block, affects every page)
- **Inputs:** 16px font and 44px minimum height for `input`, `select`, `textarea`, `.btn*`; `inputmode="decimal"` on numeric fields; native date and time pickers.
- **Touch targets:** 44px minimum on links in menus, table row actions and chips; more space between adjacent actions.
- **Base type:** body 14–15px on small screens only.
- **Tables:** every `.grid-table` scrolls horizontally inside its own box (`display: block; overflow-x: auto` on the table, which needs no page edits), keeping all columns. Header row sticky, first column sticky (using logical `inset-inline-start`, so RTL works) with a solid background. The page itself never scrolls sideways.
- **Form grids:** any multi-column field grid collapses to one column below `md`, in DOM order. Labels above fields.
- **Panels and headers:** panel headers wrap instead of overflowing; long numbers, codes and names wrap or truncate with the full value still in the DOM.
- **Safe areas and meta:** `viewport-fit=cover`, `env(safe-area-inset-*)` padding, `theme-color`, `touch-action: manipulation` to remove tap delay, `overscroll-behavior` so the drawer does not scroll the page behind it.

### Layer B: shell (`src/ui/shell/*`)
- Command bar: logo, input and links stack cleanly in two rows; the input is full width and 16px.
- Session bar and status bar: wrap, with the keyboard-hint text hidden on touch (hints only, no functionality).
- Sidebar drawer: keep, enlarge touch targets, make the Menu button easy to reach.
- **Sticky action row:** on small screens, the existing Save / Post / Release / Cancel button group sticks to the bottom of the viewport with safe-area padding. Same buttons, same order, no new actions. Done through a shared class, applied page by page where those groups exist.
- Notification bell, session menu, personal menu: popups sized to the viewport.

### Layer C: page fixes
Phase 0 produces a list of pages that still break after A and B (overflowing fixed-width elements, side-by-side blocks not using the shared grid, clipped buttons, tiny controls). Those get fixed individually by archetype: list, document, form, report, config.

## 4. Delivery plan

| Phase | Scope | Effort |
|---|---|---|
| 0. Audit | Playwright at 390px (and 768px), headless, one browser at a time. For every page: screenshot, `scrollWidth > clientWidth` overflow check, count of controls under 44px. Output: ranked list of broken pages and a before-set of screenshots. Uses the demo tenant | 3–4 days |
| 1. Global CSS | Layer A, no page edits. Re-run the audit | 3–4 days |
| 2. Shell | Layer B | 3–4 days |
| 3. Page fixes | Layer C, worst-offending and most-used pages first (home, approvals/release, search and lookups, sales and purchasing documents, goods movements, stock counts, production confirmation, time and leave, reports). Configuration and admin screens last | 2–3 wks |
| 4. Verify | Re-run audit; sample pages on a real phone or emulated devices (iPhone and Android Chrome); check desktop screenshots are unchanged | 2–3 days |

Total about 4–5 weeks for one developer. Phases 1 and 2 (about 1.5 weeks) will already fix most pages.

## 5. Engineering rules

- All new rules sit inside `@media (max-width: 767px)` or `max-md:` classes, so the desktop render is unchanged. A before/after screenshot diff at 1280px on a page sample proves it.
- Changes are in `globals.css`, `src/ui/*` and layout classes in pages. **Service functions and `actions.ts` are not modified.**
- Printing, PDF, CSV and exports are unaffected.
- Existing tests continue to pass; tests asserting class names or markup are fixed with the page that changes.
- Audit and screenshot runs follow the workbench rules: native server on :3100, one Chromium at a time, low-memory flags, stopped afterwards.
- No dependency changes, so no app container restart is needed.
- If a file moves, update `docs/codemap/shared.md` and run `node scripts/codemap-index.mjs`.
- Extend demo data only if a screen cannot be exercised on mobile without it (for example, enough rows to scroll a table).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Very wide tables are awkward to read on a phone | Sticky key column and header, scroll inside the box; nothing hidden |
| Some pages hard-code widths or use inline layout | Found by the overflow audit; fixed per page |
| Sticky action row covers content | Bottom padding on page content; check on archetypes |
| iOS and Android differences | Test both engines (WebKit and Chromium) in the audit |
| Desktop regressions | Media-query scoping plus 1280px screenshot diff |
| Admin and configuration screens stay clumsy | Accepted in "best effort"; listed after Phase 3 |

## 7. Decisions needed

1. Should all 308 pages be targeted, or only the day-to-day ones first and configuration and admin later (recommended)?
2. Should Phase 0 start now on the demo tenant? It runs a headless browser and needs the native server on :3100.
3. Is the sticky bottom action row acceptable, or should buttons stay where they are on the page?

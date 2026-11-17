# Cairn UI Consistency and Responsive Proposal

Status: proposal, for approval. Scope: **one consistent design across the whole app, on desktop and on mobile, with mobile getting the most work.** No change to business rules, service functions in `src/modules/*`, `actions.ts`, routes, permissions, the database, or what each screen shows.

Revision note: earlier drafts were a library rebuild, then a desktop-only refresh, then mobile-only. This is the final scope: a single design system applied everywhere, responsive from phone to wide desktop, with a **conservative, standard enterprise look** (no trend-driven styling) built on **Radix UI primitives and Lucide icons**.

## 1. Principles

1. **Same pattern everywhere.** One table, one form layout, one card/panel, one set of text styles, one set of buttons. A user who learns one screen knows them all.
2. **Everything visible and organised.** Content is grouped into clearly titled cards in a predictable order. No accordions, hidden tabs, "show more" or hidden columns. Nothing is folded away.
3. **Easy to see.** Clear hierarchy (page title, card title, label, value), readable type, good contrast, status shown consistently.
4. **Easy to navigate.** Same header, menu, breadcrumb and action positions on every page, on every screen size.
5. **Responsive by design.** Built mobile-first: phone, tablet and desktop use the same markup and adapt through shared layout components, not per-page tweaks.
6. **Same business, same screens.** Same fields, columns, routes and permissions.
7. **Standard enterprise look.** Neutral, familiar and restrained: flat surfaces, thin borders, no gradients, glassy effects, large radii, heavy shadows, animation or novelty. Evolution of today's look, not a redesign.

## 2. Where we are today (measured from the code)

The foundation is more uniform than it looks, which makes a central fix practical.

| Area | Finding |
|---|---|
| Tables | 429 tables, **all** use `.grid-table`, but with ad-hoc extras: different text sizes, margins (`mt-2`, `mt-3`), a few hard-coded min widths (`min-w-[56.25rem]`). |
| Buttons | About 1,400 uses of the `.btn` family: `btn-default` (930), `btn-primary` (472), a few `btn-danger`, `btn-secondary`, `btn-success`. Around 1,000 raw `<button>` elements, some outside this family. |
| Inputs | About 3,600 `<input>` elements, about 2,200 using shared field classes; the rest styled ad hoc. |
| Page width | Mixed container widths: `max-w-3xl` (348), `max-w-6xl` (187), `5xl`, `2xl`, `4xl`, `sm`. No rule for which page gets which. |
| Layout grids | Many raw grids (`grid-cols-2`: 277, `-4`: 145, `-3`: 136). Some may not collapse on a phone. Breakpoint use is uneven (about 2,400 `sm:`, 400 `lg:`, 34 `md:`). |
| Cards | `.panel`, `.panel-header`, `.section-head` exist but are applied inconsistently. |
| Style | Warm paper, teal accent, 2px radii, 10.5–18px type (body 13.5px), light only. Functional but dense and plain. |
| Mobile | Viewport tag is set and the sidebar is a drawer below `md`. Otherwise desktop layouts squeezed down: inputs under 16px (iOS zoom), small touch targets, tables push the page sideways. |
| Shell | Command bar, session bar, sidebar, status bar are desktop-shaped. |

## 3. The design system (one source, used everywhere)

All of it lives in `tailwind.config.ts`, `globals.css` and a small `src/ui/kit/` of shared components.

**Libraries (decided):**
- **Radix UI primitives** (unstyled; we add the Tailwind classes) for the interactive parts that must behave correctly: dialog, dropdown menu, popover, select, tooltip, tabs-as-navigation where one already exists, checkbox/switch. Each is a separate small package, installed only when used. Replaces the hand-built focus trap, Escape and click-outside code in `SidebarMenu`, `SessionMenu`, `PersonalMenu` and `ReleasePanel`. Works with server components; only the interactive parts are client components.
- **Lucide** (`lucide-react`) for icons, imported by name (tree-shaken) in a standard size (16px, 20px on touch) and `currentColor`. Used for: menu and module markers, status chips, search, notifications, sort arrows, row actions, buttons with a clear standard symbol (add, edit, delete, save, print, export). Text labels stay on buttons and navigation; icons support the text and never replace it.
- Helpers: `class-variance-authority`, `clsx`, `tailwind-merge` for button and chip variants.
- Components are owned in the repo (`src/ui/kit/`), not a themed library, so the look stays Cairn's.

**Tokens (CSS variables):** colours, radii, spacing scale, shadow, type scale. **Conservative changes only:**
- Palette: keep the current warm neutral and teal. Only tidy it: slightly lighter borders, consistent status colours, 4.5:1 contrast checked.
- Font: keep the system font stack (Segoe UI, Roboto, system-ui) as users expect on their OS; tabular numbers stay.
- Type: body 14px (from 13.5px), tables 13px on desktop; 15px body and 16px inputs on mobile.
- Shape: radius 3–4px (from 2px), thin 1px borders, no shadows except on menus and dialogs.
- No dark theme, gradients or animation beyond hover and focus states.

**The shared building blocks** (each defined once, then used by every page):

| Block | Defines | Replaces |
|---|---|---|
| **Page** | Title bar (title, breadcrumb, status chip, primary actions), content area, standard widths: *narrow* (forms), *standard* (documents), *wide* (lists, reports) | Mixed `max-w-*` per page |
| **Card** | Container with title, optional count and actions, consistent padding and border. Everything on a page sits in cards in a fixed order | `.panel`, `.section-head` used inconsistently |
| **Table** | One look: sticky header, right-aligned tabular numbers, totals row, row hover, selected row, empty state, consistent row actions. Same on desktop and mobile | The `grid-table` variants and ad-hoc margins |
| **Form** | One layout: label above field, hint and error under it; responsive grid of 1 / 2 / 3 columns by width; read-only fields look different from editable ones; required marker; same field widths for same data types (date, amount, code, text) | Raw `grid-cols-*` and ad-hoc fields |
| **Buttons** | Primary, default, danger. One height, one text style, one position for each group; icon optional | `btn-secondary`, `btn-success` and raw `<button>`s folded into the three |
| **Chips/status** | One palette and wording scale for draft, open, released, posted, blocked, error, each with a Lucide icon plus text | Per-page chip colours |
| **Menu, Dialog, Popover, Select** | Radix-based, same look and keyboard behaviour everywhere | Hand-built menus and drawers |
| **Key-value block** | Label/value pairs for document headers | Repeated hand-written markup |
| **Messages** | Success, warning, error, info banner. Renders the existing `{ ok, message, remedy }` result | Inline message markup |
| **Typography** | Page title, card title, label, value, hint, caption: six styles, no others | Mixed sizes |

## 4. Responsive behaviour (one rule set)

| | Phone (<768) | Tablet (768–1023) | Desktop (≥1024) |
|---|---|---|---|
| Navigation | Top bar + menu button opening the full-height menu; command/search bar at the top | Same as desktop, narrower sidebar | Sidebar with modules and categories |
| Page | One column, cards stacked in the same order | One or two columns | Two or three columns, as the layout asks |
| Form grid | 1 column | 2 columns | 2–3 columns |
| Tables | Stay tables with **all columns**. Scroll sideways inside the card, sticky header and first column. Page never scrolls sideways | Same | Fit to width; scroll only if very wide |
| Action buttons | Page-level actions stay in the title bar; the main Save/Post/Release row also sticks to the bottom | In the title bar | In the title bar |
| Targets | 44px minimum controls, 16px inputs | 40px | Compact (today's density) |
| Cards | Full width, 12px gutters | Grid | Grid |

Density: desktop remains compact, because ERP users read many rows; phones get touch spacing through the same components, with no second layout to maintain.

**Cards on phones:** the card is the unit for grouping fields and sections. Tables are not converted into cards; list rows keep every column so no data is hidden.

## 5. Navigation and organisation

- **Same page skeleton on every screen:** page title and breadcrumb, status chip, primary actions top right, then cards in a standard order: key data and header, details, items/lines, related information, history.
- **Sidebar and menu:** same data and order as now (`nav-tree.ts`), clearer active state, larger touch targets, a visible current-location breadcrumb.
- **Command bar:** stays exactly as it works today (no-JS form, keyboard friendly), restyled and full width on mobile.
- **Related screens and notifications:** consistent position (page header area) on all pages.
- **Home:** the existing launchpad and attention list, laid out with the same cards.

## 6. Delivery plan

Foundation first; every later page change is a swap onto shared components. Old classes keep working until their last page moves.

| Phase | Scope | Effort |
|---|---|---|
| 0. Audit and design | Playwright screenshots of all 308 pages at 390, 768 and 1280px; overflow and tap-target checks; classify pages into archetypes (list, document, form, report, config). Agree tokens, type and the building blocks on 4–5 sample pages | 1 wk |
| 1. Tokens and base | Install the libraries; CSS-variable tokens; new `.btn`, `.chip`, field, table and card classes in `globals.css`. Every page changes look at once with no page edits. Mobile base: 16px inputs, 44px targets, tables scroll in their card, safe areas | 1.5 wks |
| 2. Shell | Command bar, session bar, sidebar/menu, breadcrumb, status bar, notifications on all sizes | 1.5 wks |
| 3. Page and layout components | `Page`, `Card`, `Form`, `KeyValue`, `Messages`, Radix-based menus and dialogs; apply to 4–5 pilot modules (suggest sales and purchasing) | 2–3 wks |
| 4. Roll-out | Remaining modules, mostly mechanical. Convert variant tables and raw buttons and inputs to the shared blocks; normalise page widths and grids; fix per-page issues from the audit. Day-to-day screens first, configuration and admin last | 6–8 wks |
| 5. Verify and clean up | Re-run the audit; accessibility pass (contrast, focus, targets); desktop and mobile regression screenshots; delete unused classes; lint rule against new ad-hoc styles | 1–2 wks |

Total about 13–17 weeks for one developer, about 8–10 with two. The visible consistent look arrives after Phase 1 (about 2.5 weeks); mobile usability on most pages arrives after Phases 1 and 2 (about 4 weeks).

## 7. Engineering rules

- UI work only: `tailwind.config.ts`, `globals.css`, `src/ui/*` and page layout markup. **Service functions and `actions.ts` are not modified**, other than passing existing messages to the shared message block.
- New kit in `src/ui/kit/`; document it in `docs/codemap/shared.md` and run `node scripts/codemap-index.mjs` when files change.
- A dev-only page, `/dev/kit`, shows every block (desktop and mobile widths) as the one reference for developers.
- A lint check (with `lint:ip`) flags new one-off table, button and field styling after cleanup.
- Existing tests must keep passing; tests that assert on markup are updated with their page.
- Print, PDF and exports keep their own styling, checked for no regressions.
- Browser runs follow the workbench rules: native server on :3100, one Chromium at a time, stopped afterwards.
- Dependencies added in Phase 1 in one batch (Radix packages, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`); that needs one `docker compose restart app`. Client bundle growth is expected to stay under about 40 KB gzip.
- Seed data is extended only where a mobile or consistency check needs more rows or states to be seen.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Roll-out is large (308 pages) | Central tokens and classes give a global change first; page conversion is mechanical and by module |
| Consistency drifts again | Shared components, `/dev/kit`, lint rule |
| Wide tables remain awkward on a phone | Scroll inside the card, sticky key column and header; nothing hidden |
| Users resist a changed look | Standard, restrained styling; same layout, fields and positions; optional Classic/Refreshed token switch (3–4 days) if wanted |
| Rewriting hand-built menus onto Radix introduces behaviour regressions | Migrate one menu at a time, keep the existing tests, check keyboard and focus on each |
| Type size changes push content around | Tune on the densest screens in Phase 0 |
| Tests assert on markup | Triage in Phase 0; fix with each page |
| Scope creep into features | Look and feel only; ideas go to `docs/OPEN-GAPS.md` |

## 9. Decisions (approved 2026-11-17, all as recommended)

1. Radix UI and Lucide, with owned components in `src/ui/kit/`.
2. Conservative look: current palette, system fonts, 3-4px radii, no dark theme.
3. Pilot modules: sales and purchasing.
4. No Classic/Refreshed switch: the `development` branch keeps the current look, work happens on branch `ui-change`.
5. Roll out day-to-day modules first, configuration and admin last.
6. Phase 0 (audit) starts now on the demo tenant. Each step is committed and pushed to `ui-change`.

# Cairn UI Modernisation Proposal

Status: proposal, for approval. Scope: presentation layer only. No change to business rules, service functions in `src/modules/*`, the database, RLS, posting, permissions or the screen catalogue. Mobile is a first-class target.

Basis: code review of the shell, tokens and `globals.css`. No screen-by-screen visual audit has been done yet; Phase 0 does it.

## 1. Where we are today

| Area | Finding |
|---|---|
| Stack | Next 15 (App Router, React 19), Tailwind 3.4, **no component library**. Server components with thin `actions.ts` wrappers. |
| Size | 308 pages, 614 `.tsx` files, 283 client components, 429 `<table>` elements. |
| Styling | Tokens in `tailwind.config.ts`; ~25 hand-written component classes in `globals.css` (373 lines): `.grid-table`, `.btn-*`, `.chip-*`, `.field-*`, `.panel`, `.section-head`, `.status-bar`. |
| Look | Warm paper background, one deep teal accent, 2px radii, flat, dense. Type is 10.5–18px (body 13.5px). Light theme only (`color-scheme: light`). |
| Shell | Sticky command bar (a plain form, works without JS), session bar, module sidebar, status bar, scroll-to-top. Sidebar is already a focus-trapped drawer below `md`. |
| Responsive | Present but uneven: ~2,400 `sm:` uses, 400 `lg:`, only 34 `md:`. Breakpoints are inconsistent. Tables are `.grid-table` with a small-screen override, not a card or stacked pattern. |
| Gaps | No dark mode, no `theme-color` / PWA manifest, no icon system (a single `SearchIcon`), no toasts or skeletons beyond a route progress bar and spinner, no shared data-table, dialog, sheet, or tabs primitives. |
| Strengths to keep | Server-first rendering, no-JS command bar, tabular numerals, accessibility work (contrast-fixed `ink-faint`, visible focus ring, focus-trapped drawer), RTL-ready logical properties, keyboard-centred workflow. |

Core problem: the UI is consistent in tone but built from raw classes repeated on every screen, so it cannot improve in one place, and it is desktop-density-first. A user on a phone gets the desktop layout compressed.

## 2. Goals and non-goals

Goals
1. A modern, calmer look: clearer hierarchy, better spacing, real icons, subtle depth, light and dark themes.
2. Usable on phones and tablets for the tasks people actually do away from a desk (approve, look up, goods receipt, stock count, time and leave entry, notifications).
3. One component library, so a visual change is made once.
4. Keep power-user speed on desktop: dense mode, keyboard, command bar.
5. Same screens, same routes, same permissions, same data.

Non-goals: new features, new routes, changed workflows, backend changes, a rewrite to a SPA, replacing Next.js or Tailwind.

## 3. Design direction

**Keep the Cairn identity, modernise the execution.** The warm neutral and teal accent are distinctive; keep them, refine them.

- **Tokens as CSS variables** (`--surface`, `--ink`, `--accent`, …) mapped into Tailwind. This gives dark mode and per-tenant theming for free and removes hard-coded hex.
- **Dark theme** from `prefers-color-scheme`, with a user override stored in the personal menu. Palette re-checked for 4.5:1 contrast.
- **Radius** 6px for controls, 10px for panels and sheets (up from 2px). Soft 1–2 level elevation for overlays only; content stays flat.
- **Type**: Inter (self-hosted via `next/font`, tabular figures on) replacing the system stack. Body 14px on desktop, **16px inputs on mobile** (prevents iOS zoom-on-focus). Clear scale: page title, section, body, caption.
- **Density modes**: Comfortable (default on touch and small screens), Compact (the current look, default on desktop for power users). Implemented as one `data-density` attribute scaling spacing and row height, not two code paths.
- **Icons**: Lucide, tree-shaken, used in nav, buttons, status chips, empty states.
- **Status language**: chips get an icon plus text (never colour alone), consistent across documents (draft, released, posted, blocked).
- **Motion**: 120–200ms, respects `prefers-reduced-motion`; skeleton loaders replace blank waits; toasts for action results.

## 4. Component foundation

Adopt **Radix primitives with shadcn-style owned components** (copied into `src/ui/kit/`, styled with Tailwind). No heavy runtime dependency and no lock-in; they stay accessible (focus, ARIA, keyboard) and work with server components. Add `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`.

| Component | Replaces | Notes |
|---|---|---|
| Button, IconButton, SubmitButton | `.btn-*` | Keeps pending state from existing `SubmitButton`. |
| Field, Input, Select, Textarea, Checkbox, Switch, DatePicker | `.field-*`, `ConstrainedField` | Label, hint, error slot; 44px touch height on mobile. |
| DataTable | 429 `<table>` + `.grid-table` | See section 6. |
| Card / Panel / Section | `.panel`, `.section-head` | Collapsible on mobile. |
| Dialog, Sheet (bottom on mobile, side on desktop), Popover, Tooltip, Menu | ad-hoc menus | Replaces session menu, personal menu, release panel container. |
| Tabs, Breadcrumb, Pagination | `MenuPath`, link rows | |
| Chip / Badge, Alert, Toast, Skeleton, EmptyState | `.chip-*`, inline messages | Maps to the `{ ok, message, remedy }` action state. |
| KeyValue / DescriptionList | repeated label-value markup | Document headers. |

`actions.ts` and the `{ ok, message, remedy }` contract are untouched; a `<FormMessage>` component renders them, and optionally surfaces them as toasts.

## 5. App shell redesign

Desktop (≥1024px)
- Left rail with module icons, expandable to the full module/category tree (today's `SidebarMenu`, same data from `nav-tree.ts`, collapsible, pinned state remembered).
- Slim top bar: breadcrumb (`MenuPath`), **command palette** (⌘/Ctrl-K, same `executeCommand` + `nav-search`, keeps the no-JS form fallback), notifications, tenant/session, theme and density toggle.
- Content area with max width options: full-width for grids, constrained for forms.
- Status bar content moves to the top bar and toasts; the keyboard hint stays in the palette.

Tablet (640–1023px): icon-only rail, top bar unchanged, two-column forms.

Mobile (<640px)
- **Bottom tab bar** (Home, Search, Tasks/Inbox, Menu) for the four highest-frequency destinations. "Menu" opens the full navigation as a full-height sheet with search first.
- Compact top bar: title, back, notification bell. Command bar becomes a search sheet.
- Sticky bottom **action bar** on document screens (Save, Post, Release) so primary actions sit under the thumb, honouring `safe-area-inset-bottom`.
- No horizontal page scroll anywhere.

Home / launchpad: tiles become a role-aware dashboard: "Needs your attention" (existing `platform/attention`), recent screens, favourites (existing personal menu), then module tiles. All data already exists.

## 6. Data tables and lists (the biggest lever)

One `DataTable` component, applied incrementally to all 429 tables:
- **Desktop**: sticky header, sticky first column, tabular numerals right-aligned, row hover and selection, zebra optional, column visibility, inline filters, keyboard row navigation, CSV/PDF export button slot (existing `ReportExport`).
- **Mobile**: each row renders as a **card** (title field, status chip, 2–3 key values, tap to open) using per-table column metadata `priority: 'primary' | 'secondary' | 'detail'`. Tables that are genuinely wide (financial statements, matrices) keep horizontal scroll inside a bordered container with a sticky first column, never page-level scroll.
- Server-side sort/filter/paging stay as they are (URL search params); the component only presents them. Filters collapse into a "Filters" sheet on mobile.
- Totals rows (`tfoot`) become a sticky summary on mobile.

## 7. Forms and document screens

- Single-column on mobile; 2–3 column grid on desktop, driven by a `FormGrid` component.
- Document header (number, status, partner, dates) in a sticky summary strip; items in the DataTable (cards on mobile with an edit sheet per item).
- Inline validation under fields using the existing typed-error mapping; error summary at top that links to fields.
- `ConstrainedField` (value-help search) becomes a combobox on desktop and a full-screen picker sheet on mobile.
- Change-lock banner (`ChangeLock`), release panel and attention panel restyled as Alert/Card variants; behaviour unchanged.
- Touch: 44px minimum targets, numeric keypads (`inputmode="decimal"`), date inputs with native pickers on mobile, camera/barcode input field for goods movement and counts (progressive enhancement, later phase).

## 8. Mobile and PWA

- `theme-color`, web manifest, icons, installable PWA, standalone display. App-shell caching only; **no offline writes in this proposal** (it would change business semantics and conflict handling). Offline read of recently viewed screens is an optional later phase.
- Priority mobile journeys, designed and tested end to end: sign in, home/attention, approvals and release, notifications, search/lookup (materials, partners, documents), goods receipt and stock count, production confirmation, time and leave, and read-only reports.
- Heavy configuration screens (`/config`, constrained values, tenants) stay usable but are desktop-optimised; they get a "best on a larger screen" notice only if they genuinely cannot reflow.
- Standard breakpoints (`sm 640`, `md 768`, `lg 1024`, `xl 1280`), with `md` as the shell switch point. The current mix of `sm:`-heavy classes is normalised as pages migrate.

## 9. Accessibility and internationalisation

Target WCAG 2.2 AA: contrast in both themes, focus-visible, 24px minimum target (44px on touch), reduced motion, screen-reader names on icon buttons, landmark structure. RTL stays supported (logical properties only; the kit is built the same way). Strings remain in `platform/i18n`; no hard-coded text in the kit.

## 10. Delivery plan

Strangler approach: new kit and shell alongside the old styles, screens migrated module by module. The app stays shippable after every step.

| Phase | Scope | Outcome |
|---|---|---|
| 0. Audit and design (1–2 wks) | Screenshot all 308 pages at 3 widths with Playwright; classify page archetypes (list, document, form, report, dashboard, config); Figma or HTML prototypes of shell, list, document, mobile home; sign off tokens | Agreed design and archetype list |
| 1. Foundations (1–2 wks) | CSS-variable tokens, dark theme, font, density, Radix/cva/Lucide, `src/ui/kit` primitives; `.btn/.chip/.field` re-implemented on tokens so **every screen changes look at once** with no page edits | Visible modernisation globally, low risk |
| 2. Shell (2 wks) | New nav rail, top bar, command palette, mobile bottom bar and sheet menu, toasts, PWA manifest | Navigable on phone; new chrome everywhere |
| 3. DataTable and archetypes (3 wks) | DataTable with card mode; `ListPage`, `DocumentPage`, `FormPage`, `ReportPage` layouts; migrate the home dashboard and 2 pilot modules (sales, purchasing) | Patterns proven on real screens |
| 4. Module rollout (6–8 wks) | Remaining modules: inventory, production, quality, finance, people, foundation, controlling, audit, platform. Many pages are codemod-able (`<table class="grid-table">` to DataTable) | All archetype screens migrated |
| 5. Mobile journeys and polish (2 wks) | Barcode/camera input, bottom action bars, offline-read cache, performance and a11y pass | Mobile journeys signed off |
| 6. Retire legacy (1 wk) | Delete unused classes from `globals.css`, enforce with lint | Single system |

Indicative total: 15–20 weeks for one developer, 8–10 with two. Phase 1 alone delivers the visible refresh in about two weeks.

## 11. Engineering rules

- UI changes live in `src/ui/kit/*` and page layouts; **service functions and `actions.ts` are not modified** except to pass through existing messages. Matches the business-logic placement rule.
- Extend `docs/codemap/shared.md` with the kit; run `node scripts/codemap-index.mjs` in each change.
- Extend demo/seed data only where a new view needs it (e.g. enough rows to show paging and card mode); no functional data changes.
- Add a Storybook-lite route (`/dev/kit`, dev only) showing every component in light/dark, both densities and RTL.
- Visual regression: Playwright screenshots at 390, 768 and 1280px for archetype pilots, run one browser at a time per the memory constraints of the workbench.
- Existing 580 test files must keep passing; contract tests that assert on markup or strings are updated with the page that changes.
- Bundle budget: kit adds no more than ~40 KB gzip client JS; keep server components the default and keep the no-JS command bar working.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Tests that assert on class names or text break | Triage in Phase 0; update alongside each page |
| 429 tables differ widely | Archetype classification; per-table column priority metadata; wide tables keep scroll |
| Power users dislike lower density | Compact mode default on desktop; density toggle |
| Dependency changes need app container restart | Batch installs into Phase 1; ask user to `docker compose restart app` |
| Workbench memory limits for builds and browsers | Serial runs, `build:check`, one Chromium at a time |
| Scope creep into functionality | Hard rule: presentation only; any behavioural idea goes to `docs/OPEN-GAPS.md` |

## 13. Decisions needed

1. Approve keeping the Cairn teal/warm identity (refined) versus a fresh brand palette.
2. Approve Radix + shadcn-style owned kit and Lucide icons.
3. Dark mode in scope for the first release? (Recommended: yes, it is cheap with variables.)
4. Mobile: PWA with online-only (recommended) versus offline writes (large, changes semantics).
5. Pilot modules for Phase 3 (suggest sales and purchasing).
6. Default density for desktop (suggest Compact) and for touch devices (Comfortable).

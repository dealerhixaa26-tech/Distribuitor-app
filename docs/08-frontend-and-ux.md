# 08 — Frontend Architecture & UX

> Phase 0 deliverable. Status: **Awaiting approval**

---

## 1. Design intent

The target is the feel of Linear, Stripe Dashboard, or Vercel — **not** a Bootstrap admin template.
Concretely that means: dense but breathable information, restrained colour, real typographic
hierarchy, instant perceived response, and keyboard-first operation. An ERP is used for six hours a
day by the same people; it must reward familiarity rather than impress on first sight.

Three rules that follow from that:

1. **Data density over whitespace theatre.** A sales manager scanning 200 orders needs rows, not
   cards with 32 px padding.
2. **Motion communicates state, never decorates.** Transitions confirm that something happened.
   Nothing bounces. `prefers-reduced-motion` is fully honoured.
3. **Every destructive action is reversible or confirmed**, and confirmation dialogs state exactly
   what will happen, including counts.

---

## 2. Design tokens

Semantic tokens as CSS custom properties, consumed through Tailwind. Components never reference a
raw colour, which is what makes dark mode a token swap rather than a component audit.

```css
:root {
  --background: 0 0% 100%;      --foreground: 224 71% 4%;
  --card: 0 0% 100%;            --muted: 220 14% 96%;
  --muted-foreground: 220 9% 46%;
  --primary: 211 100% 35%;      /* Hixaa industrial blue */
  --primary-foreground: 0 0% 100%;
  --success: 142 71% 35%;  --warning: 38 92% 45%;
  --destructive: 0 72% 45%;     --info: 199 89% 42%;
  --border: 220 13% 91%;        --ring: 211 100% 35%;
  --radius: 0.5rem;
}
.dark {
  --background: 224 71% 4%;     --foreground: 210 20% 98%;
  --card: 224 60% 7%;           --muted: 215 28% 14%;
  --muted-foreground: 218 11% 65%;
  --primary: 211 100% 60%;      --border: 215 28% 17%;
}
```

The primary is a deep industrial blue, consistent with Hixaa's automation/engineering positioning
and its existing brand presence. **The exact brand values are seeded into `SYSTEM_SETTING`, not
hardcoded** — so branding can be adjusted from the Admin Panel without a deploy, per your
requirement that nothing about the company is baked into code.

**Typography:** Inter (UI) with `tabular-nums` enabled on every numeric column — misaligned digits
in a currency column are the fastest way to make a finance product feel amateur. JetBrains Mono for
SKUs, invoice numbers, and codes.

**Scale:** 4 px base. Type ramp 12/14/16/20/24/30/36.

---

## 3. Layout

```
┌────────────────────────────────────────────────────────────┐
│ Topbar: logo · ⌘K search · notifications · theme · profile │
├──────────┬─────────────────────────────────────────────────┤
│ Sidebar  │ Breadcrumb                                       │
│ (collap- │ ┌─────────────────────────────────────────────┐ │
│  sible,  │ │ PageHeader: title, description, actions      │ │
│  perm-   │ ├─────────────────────────────────────────────┤ │
│  aware)  │ │ Content: filters → DataTable / detail tabs   │ │
│          │ └─────────────────────────────────────────────┘ │
└──────────┴─────────────────────────────────────────────────┘
```

Responsive: sidebar collapses to icons at `lg`, becomes a sheet at `md`, and tables become stacked
cards at `sm`. Tablet is a first-class target — a warehouse supervisor doing dispatch on an iPad is
a real user, not a hypothetical one.

---

## 4. The component that matters most: `<DataTable>`

Almost every screen in this application is a filtered list of records. Building that twelve times
by hand is how admin panels become inconsistent and unmaintainable. One component, configured:

```tsx
<DataTable
  resource="orders"
  columns={orderColumns}
  filters={[
    { field: 'status',       type: 'multi-select', options: ORDER_STATUSES },
    { field: 'distributorId',type: 'async-select', endpoint: '/distributors' },
    { field: 'orderDate',    type: 'date-range' },
  ]}
  bulkActions={[approveMany, exportSelected]}
  rowActions={(row) => [view(row), edit(row), cancel(row)]}
  savedViews
  emptyState={<EmptyState … />}
/>
```

Built in once: server-driven pagination (cursor), sorting, faceted filtering, column show/hide and
reorder with persistence, row selection with bulk actions, saved views per user, CSV export,
optimistic updates, skeleton loading, error retry, keyboard navigation (`j`/`k`, `x` to select,
`Enter` to open), and full ARIA grid semantics.

Every row action is permission-gated via `usePermission()`, so a Support Agent sees the same table
without the actions they cannot perform.

---

## 5. State management

| State | Owner |
|---|---|
| Server data | **TanStack Query** — the single source of truth. Query keys are structured (`['orders', filters]`); mutations invalidate precisely, never `invalidateQueries()` with no key |
| URL state | `nuqs` — filters, sort, pagination, and active tab live in the URL, so views are shareable and the back button behaves |
| Form state | React Hook Form + Zod resolver, schemas imported from `@hixaa/contracts` |
| Ephemeral UI | `useState` / `useReducer` |
| Global UI | A small Zustand store: sidebar collapse, theme, command palette |

There is no Redux and no global cache of business entities. Server state kept in a client store is
stale state, and stale state in an ERP shows a user an order status that changed ten minutes ago.

---

## 6. Forms

- Zod schema shared with the backend — identical rules, one definition.
- Inline validation on blur, submit-time server errors mapped back to fields via the Problem Details
  `errors[].field` path.
- **Unsaved-changes guard** on navigation. Losing twenty minutes of order entry is unacceptable.
- Autosave drafts for long forms (orders, quotations) to `localStorage`, keyed by entity.
- Multi-step forms (distributor onboarding, order creation) show explicit progress and permit
  backward navigation without data loss.

---

## 7. Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette — global search, navigation, quick actions |
| `g` then `d` / `o` / `p` / `i` | Go to Distributors / Orders / Products / Inventory |
| `c` | Create new in the current context |
| `/` | Focus the table filter |
| `j` / `k` | Move row selection |
| `Enter` | Open the selected row |
| `Esc` | Close dialog / clear selection |
| `?` | Shortcut reference |

The command palette is the primary navigation for power users and searches across distributors,
products, orders, and invoices in one indexed query.

---

## 8. Accessibility — WCAG 2.2 AA

| Requirement | Implementation |
|---|---|
| Contrast | All token pairs verified ≥ 4.5:1 (≥ 3:1 for large text) in both themes |
| Keyboard | Every interaction reachable; visible focus rings; logical tab order; focus trapped in dialogs and restored on close |
| Screen readers | Radix primitives (correct ARIA by construction); `aria-live` for toasts and async results; tables use real `<table>` semantics with `<caption>` and scoped headers |
| Forms | `<label>` always associated; errors linked with `aria-describedby` and `aria-invalid`; required state announced |
| Motion | `prefers-reduced-motion` disables all non-essential animation |
| Zoom | Usable at 200% without horizontal scrolling |
| Targets | Minimum 24×24 px (WCAG 2.2 §2.5.8) |
| Colour | Never the sole carrier of meaning — status uses an icon plus text plus colour |

Verified with `axe-core` in CI (Playwright integration) plus a manual keyboard and screen-reader
pass per module. Automated tooling catches roughly a third of real issues; the manual pass is not
optional.

---

## 9. Performance

| Technique | Detail |
|---|---|
| RSC by default | Client components only where interactivity requires them |
| Code splitting | Route-level automatic; heavy components (charts, PDF preview, rich text) dynamically imported |
| Virtualisation | `@tanstack/react-virtual` for lists over 100 rows |
| Prefetch | Table rows prefetch their detail query on hover |
| Optimistic UI | Status changes and toggles apply immediately, roll back on error |
| Images | `next/image`, AVIF/WebP, explicit dimensions to eliminate layout shift |
| Skeletons | Matched to final layout — no content jump on load |

**Budgets, enforced in CI via Lighthouse:** LCP < 2.0 s, CLS < 0.05, INP < 200 ms, initial JS
< 200 KB gzipped per route.

---

## 10. Dashboard

KPI cards (revenue MTD, orders today, outstanding, low-stock count) each with a period-over-period
delta; sales trend line; revenue by territory (map or bar); top products and top distributors;
inventory health; recent activity feed.

Every panel reads a **materialised view** through a 5-minute Redis cache, and each is independently
suspended so a slow panel never blocks the page. Every card links through to the filtered list that
produced it — a number the user cannot drill into is a number they will not trust.

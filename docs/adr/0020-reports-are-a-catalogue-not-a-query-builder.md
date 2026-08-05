# ADR-0020 — Reports are a fixed catalogue with saved parameters, not a query builder

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Roadmap module 9.4 says **"Reports: builder, saved reports, PDF/Excel/CSV export via background
jobs."**

"Builder" is the dangerous word. It usually means one of three things, and they are not remotely
equivalent in risk:

1. **Arbitrary SQL.** A textarea, a `$queryRawUnsafe`, and a promise that only trusted users reach
   it. This is a remote code execution surface wearing a reporting hat: `pg_read_file`, a
   `LATERAL` join onto `"user".password_hash`, a `pg_sleep` denial of service. It also drives
   straight through ADR-0003 — the whole point of scoping at the repository layer is that
   forgetting to filter is impossible, and raw SQL forgets by default.
2. **A structured query DSL** — pick entity, pick columns, pick filters, pick joins. Safer, and far
   more work than it looks: every entity needs column metadata, every filter needs type-aware
   validation, and every generated query needs the scope predicate injected correctly for a shape
   nobody anticipated.
3. **A catalogue of report types defined in code**, each with declared parameters, which users
   *save configured instances of*.

Hixaa's actual reporting need is known and small: sales by period, distributor performance, product
performance, stock valuation, receivables aging, GST summary. These are not open-ended questions —
they are the same six questions asked with different dates and filters.

## Decision

**A report is a TYPE from a code-defined catalogue, plus saved parameter values.**

```ts
REPORT_CATALOGUE = {
  SALES_SUMMARY:        { params: [period, territoryId?, distributorId?], … },
  DISTRIBUTOR_PERFORMANCE: { … },
  PRODUCT_PERFORMANCE:  { … },
  STOCK_VALUATION:      { … },   // excludes DISTRIBUTOR warehouses — ADR-0014 §4
  RECEIVABLES_AGING:    { … },
  GST_SUMMARY:          { … },
}
```

`ReportDefinition` stores `type` + validated `parameters` + a name. `ReportRun` records an
execution. **No user input ever becomes SQL.**

### 1. Parameters are Zod-validated per type, not a free-form JSON blob

Each catalogue entry declares its parameter schema in `@hixaa/contracts`, so a saved definition is
validated as strictly as any other DTO — at save time *and* again at run time. A definition saved
last month against a parameter that has since changed shape fails loudly on the next run rather
than producing a quietly wrong report.

### 2. Every report query goes through `prisma.db`, so scoping still applies

This is the reason option 1 was never viable. `PrismaService.db` carries the scope extension
(ADR-0003); a territory-scoped user running SALES_SUMMARY sees their subtree because the extension
puts it there, not because the report author remembered. A report that reached for
`$queryRawUnsafe` would bypass the single control that makes the future Distributor Portal a
frontend project.

Where an aggregate genuinely needs raw SQL for performance, it takes the caller's resolved scope as
a **parameterised** `IN` list — never interpolated, and never optional.

### 3. Execution is synchronous under a row cap, queued above it

A report that returns 500 rows should not require a job, a poll, and an email. Under
`REPORT_SYNC_ROW_LIMIT` it runs inline and streams back. Above it, the request returns a
`ReportRun` in `QUEUED` and the existing `REPORTS` BullMQ queue does the work.

The cap exists because the failure mode of always-async is worse than it sounds: every trivial
report becomes a two-step interaction, and users stop using reports.

### 4. Export formats reuse what exists

CSV is written directly. XLSX uses a streaming writer. PDF goes through
`DocumentRendererService` (ADR-0013) — the same renderer as the quotation and the tax invoice, so a
report PDF looks like the company that sent it rather than like a different product.

### 5. "Builder" survives as a UI over the catalogue

The user still picks a report, sets its filters, names it, saves it, and schedules it. What they
cannot do is invent a query shape. That is the entire difference, and it costs them nothing they
would actually have used.

## Consequences

**Good.** There is no SQL injection surface, because there is no user-supplied SQL. Scoping holds
for every report by construction. Each report is ordinary reviewable TypeScript with ordinary tests.
Adding a report is a catalogue entry and a function.

**Costs.** A genuinely novel question needs a code change and a deploy, where a query builder would
have let an analyst answer it themselves. For a six-report domain owned by one operator that is the
right trade; for a data-warehouse product it would not be. If ad-hoc analysis becomes a real
recurring need, the correct answer is a read replica with proper credentials and a BI tool pointed
at it — not a query builder inside the ERP.

**Revisit if** the catalogue passes roughly 20 entries, which would suggest the questions are more
open-ended than this ADR assumes.

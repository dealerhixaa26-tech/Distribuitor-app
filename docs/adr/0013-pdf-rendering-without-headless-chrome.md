# ADR-0013 — Documents render with pdfmake, not headless Chrome

- **Status:** Accepted
- **Date:** 2026-08-04

## Context

Hixaa's sales motion is RFQ-first: the quotation is the primary customer-facing artefact. Asked
whether a sendable PDF was needed in Phase 7 or could wait for Phase 8, the owner chose to build a
shared renderer now — on the reasoning that doing it twice is worse than doing it once.

Three documents will use it:

| Document | Phase | Notes |
|---|---|---|
| Quotation | 7 | Customer-facing, sent by email |
| Tax invoice | 8 | **Legal document.** Must carry GSTIN, HSN/SAC per line, the CGST/SGST/IGST split, and amount in words |
| Reports | 9 | Statements, ageing |

The deployment constraint is the deciding factor: **a single Hostinger VPS** running everything
through Docker Compose (`docs/10-deployment.md`), sized around 8 GB / 4 vCPU. The API, worker,
Postgres, and Redis all share it.

## Decision

**`pdfmake`** — a pure-JavaScript, declarative PDF generator.

1. **A document is a JSON definition**, not HTML. Tables, column widths, totals, and page breaks
   are expressed structurally, which suits an invoice far better than trying to make CSS produce a
   deterministic table across a page boundary.

2. **A shared `DocumentRenderer`** owns page setup, fonts, the company header, and the styles.
   Per-document builders supply only their own content. Phase 8's invoice inherits the layout
   primitives rather than reinventing them.

3. **Company identity comes from settings, never from code.** Legal name, GSTIN, address, and
   brand colour are read from the `company.*` and `branding.*` settings that
   `portfolio.seed.ts` already populates. Nothing about Hixaa is hardcoded in a template — the same
   rule the rest of the system follows.

4. **Rendering happens off the request path** where the document is emailed, via the outbox
   (ADR-0005). A synchronous `GET .../pdf` exists for "download now", because a person clicking a
   button should not wait on a queue.

5. **The ₹ glyph must be verified, not assumed.** pdfmake bundles a Roboto subset, and an older
   subset may lack U+20B9. This is checked by rendering a real document and inspecting it, not by
   trusting the font's reputation — an invoice showing `?` where the currency symbol belongs is a
   defect a customer sees before we do. If the bundled subset is short, a font with the glyph is
   embedded explicitly.

## Consequences

**Positive**

- **No Chromium.** No ~300 MB image layer, no `libnss3`/`libatk`/`libgbm` system packages in the
  Dockerfile, and no 100–200 MB of RAM per concurrent render on a box that is also running
  Postgres. On this VPS that is the difference between a feature and an incident.
- Deterministic output. The same definition produces byte-identical PDFs, which makes the renderer
  testable — a snapshot of the document definition can be asserted without rasterising anything.
- Fast: milliseconds per document rather than seconds spent starting a browser.
- Pure JS, so it runs identically in the API process, the worker, and a test.

**Negative**

- **No HTML/CSS.** Layout is written in pdfmake's own vocabulary, and a designer cannot hand over a
  template. Accepted: these are dense financial documents where a designer's involvement is
  marginal, and the structural model is a better fit than CSS for tables that must break across
  pages predictably.
- **Fonts must be embedded deliberately**, hence point 5 above.
- Complex layouts are more laborious than writing HTML. Mitigated by the shared renderer absorbing
  the awkward parts once.

**Rejected: Puppeteer / Playwright (headless Chrome).** The best fidelity by a distance, and the
usual default. It also roughly doubles the container image, needs a dozen system libraries, and
holds hundreds of megabytes of RAM per render on a single shared VPS. `docs/00` §6 requires
graceful degradation on one box; adding a browser to the invoice path works directly against that.
Revisit only if the deployment grows a machine that can afford it.

**Rejected: `@react-pdf/renderer`.** Pleasant developer experience and a React component model.
Heavier, less mature for complex tables, and it puts a React reconciler in the worker process for
no benefit the declarative model does not already provide.

**Rejected: HTML emails only, no PDF.** What the owner was offered and declined. A quotation is the
artefact a customer keeps and forwards; an email body is not that, and Phase 8's tax invoice needs
a PDF regardless.

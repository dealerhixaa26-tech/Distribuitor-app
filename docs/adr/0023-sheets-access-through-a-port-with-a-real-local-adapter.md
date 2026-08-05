# ADR-0023 — Sheets access goes through a port, and the local adapter is real

- **Status:** Accepted
- **Date:** 2026-08-05
- **Context:** E7 — no Google Cloud service account exists

## Context

Module 10.1 is the Google Sheets backup. Question **E7** — does Hixaa have a Google Cloud service
account for the Sheets API — is unanswered, and the owner chose to proceed against a stub with a
setup guide to follow, as E1 (statutory numbers) and E2 (invoice format) were handled in Phase 8.

The naive reading is that 10.1 is blocked. It is not. Almost none of the work is Google-specific:
checkpointing, keyset pagination, masking rules, restore diffing, quota pacing and job orchestration
are all properties of *backing up a database to a tabular target*, and none of them need a
credential to be written or verified.

The environment already anticipates this. `SHEETS_ENABLED`, `SHEETS_SERVICE_ACCOUNT_EMAIL`,
`SHEETS_PRIVATE_KEY`, two spreadsheet ids, cron, batch size and a 250 req/min limiter exist in
`env.schema.ts` with a cross-field rule that refuses to boot when `SHEETS_ENABLED=true` without
credentials. The configuration seam is built and already fails closed.

## Decision

All Sheets access goes through a narrow port:

```ts
export interface SheetsPort {
  ensureSheet(spreadsheetId: string, title: string): Promise<void>;
  replaceRows(spreadsheetId: string, title: string, rows: string[][]): Promise<void>;
  swapSheet(spreadsheetId: string, from: string, to: string): Promise<void>;
  readRows(spreadsheetId: string, title: string): Promise<string[][]>;
}
```

with two implementations, selected by `SHEETS_ENABLED`:

- **`GoogleSheetsAdapter`** — written against the Sheets v4 API. Shipped but **unexecuted** until
  credentials exist, and labelled as such in the completion record rather than implied to be working.
- **`LocalFileSheetsAdapter`** — writes the same tabular payloads through the existing
  `StorageService` to `storage/sheets-backup/<spreadsheet>/<sheet>.csv`.

**The local adapter is a real backup target, not a test double.** It stays in the codebase
permanently as the development driver, exactly as `LocalStorageDriver` does for object storage. It
produces files a person can open and diff. It is not `NoopSheetsAdapter`, and it does not live under
a test directory.

## Why a real adapter rather than a mock

A mock proves the code calls what you told it to call. A real local adapter proves the pipeline
*works*: that 1,000-row chunks are assembled correctly, that a checkpoint resumes where it stopped,
that masking actually removes the fields it claims to, that a restore diff reports the rows that
genuinely differ. Those are the parts that will be wrong, and they are verifiable today against a
real database with real rows.

It also means the honest limitation in `docs/07` §2 — Sheets is a convenience backup for human
inspection, `pg_dump` is the disaster-recovery mechanism (ADR-0024) — has a working expression from
day one, on a machine with no Google account at all.

There is a precedent to avoid rather than follow. The ClamAV and S3 drivers ship as interfaces that
**throw at boot** if selected. That is right for them: a virus scanner that silently does not scan
is a security hole, and there is no meaningful local equivalent. A backup does have a meaningful
local equivalent — a file on disk — so the same posture would forgo real verification for no gain.

## What is genuinely deferred

Isolated to `GoogleSheetsAdapter`:

- the service-account JWT authentication flow;
- real `429`/`503` response shapes — the token-bucket limiter is tuned against documentation, not
  observation;
- `values.batchUpdate` request payloads and error codes;
- temp-sheet-then-swap, whose semantics the local adapter emulates but cannot prove;
- the 10M-cell shard thresholds, untested against a real spreadsheet.

Everything else — `SyncJob`, the six extractors, chunking, checkpointing, the endpoints,
permissions, restore dry-run and diff, ops alerting, cron wiring — ships verified.

## Consequences

- Switching to live Sheets is an env change plus one class already written. No call site moves.
- The completion record must state plainly which parts are executed and which are only compiled.
  A shipped-but-unexecuted adapter described as "done" is the kind of claim this project has been
  bitten by (`docs/HANDOFF.md` §4.17 — a library's README can be wrong; probe the package).
- `docs/07` §2's `SyncJob.checkpointCursor` refers to a model that **does not exist** among the 79 in
  `schema.prisma`. It is new work in this phase, not reuse, despite HANDOFF listing it otherwise.

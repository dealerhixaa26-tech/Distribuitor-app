# ADR-0024 — A backup is proven by restoring it, not by an exit code

- **Status:** Accepted
- **Date:** 2026-08-05

## Context

Module 10.3 is nightly `pg_dump`, encrypted, copied off-box. The roadmap's wording is
`documented and **rehearsed** restore` — the emphasis is in the original.

It would be easy to satisfy the letter of that: run `pg_dump`, check `$?`, email a green
`backup-report`, write a runbook section describing how a restore would go. Every artefact the
roadmap names would exist, and the first real restore would be the first time anyone learned whether
any of it worked.

A zero exit code from `pg_dump` proves the command ran to completion. It does not prove the output
is restorable. Between a successful dump and a successful recovery sit: encryption that must be
reversible with a key someone still has, a transfer that must not truncate, a format the local
`pg_restore` version must accept, extensions and roles that must exist on the target, and — the one
that actually bites — whether anybody has ever tried.

This project has a specific reason to distrust unexercised machinery. Phase 9 found a worker that
had not booted for three phases. Phase 10 found that `pnpm dev` never started it, that every
background job read an empty database while reporting success, and that the nightly reconciliation
was structurally incapable of firing (ADR-0021). In each case the artefact existed, looked right,
and did nothing. A backup nobody has restored is the same artefact.

The stakes differ, though. A silent reconciliation costs you the ability to detect drift. A backup
that cannot be restored costs you the company's operating data, and you find out on the worst day
you will have.

## Decision

**A backup is not considered working until it has been restored.**

Three commitments follow.

**1. The restore is rehearsed in this phase, not described.** `scripts/backup.sh` and
`scripts/restore.sh` are both exercised: dump the development database, encrypt it, restore it into
a scratch database, and compare table row counts against the source. The counts go into the Phase 10
completion record as numbers. "Rehearsed" is the deliverable, and a document asserting it without
having done it is the failure mode this ADR exists to refuse.

**2. Restorability is monitored, not assumed.** A monthly `@Cron` performs an automated rehearsal —
restore the most recent encrypted dump into a scratch database, compare table counts, drop it — and
raises an ops alert on divergence or failure. A backup chain that silently stops being restorable is
the same class of defect as a reconciliation job that silently checks zero rows, and it gets the
same treatment: a check that fails loudly rather than a status that stays green.

**3. The decryption key does not live only on the box being backed up.** A backup encrypted with a
key that dies with the server protects against file corruption and nothing else. The recipient key
is recorded in the runbook as an operator responsibility, and the restore rehearsal exercises the
real decryption path rather than a plaintext shortcut.

## Consequences

- 10.3 takes longer than writing a cron job, and the extra time is spent on the only part that
  constitutes evidence.
- The completion record carries measured numbers — dump size, duration, restored row counts — rather
  than a claim. Consistent with ADR-0019, which dropped materialised views on measurement rather
  than on the Phase 0 document that specified them.
- Retention (daily 14, weekly 8, monthly 12) is bounded so the off-box target does not grow without
  limit; the monthly rehearsal reads from the retained set, so retention is exercised too.
- This reinforces the split in `docs/07` §2 and ADR-0023: **`pg_dump` is the disaster-recovery
  mechanism; Google Sheets is a convenience backup for human inspection.** Only one of the two is
  ever restored from, and only one of the two is subject to this ADR.

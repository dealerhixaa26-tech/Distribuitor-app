import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DISTRIBUTOR_TRANSITIONS, canTransitionDistributor } from '@hixaa/contracts';

/**
 * HANDOFF §4.21, generalised: an ACTION is not a status transition.
 *
 * The defect this exists to prevent was found by execution, not by reading.
 * `reactivate()` was guarded only with `assertTransition(current, 'ACTIVE')`.
 * The table says `PENDING_APPROVAL → ACTIVE` is legal — because that is what
 * approval does — so reactivation silently inherited that move. A distributor
 * awaiting approval could be made ACTIVE through `POST /:id/reactivate`,
 * skipping the verified-KYC check, the GSTIN check and the contact check,
 * never recording `onboardedAt`, and never emitting `distributor.approved`.
 * Measured against the running API: `approve` returned 409 and `reactivate`
 * returned ACTIVE on the same record, one second apart.
 *
 * The general shape: when two actions share a destination status, the table
 * cannot tell them apart, so neither may be guarded by the table alone. This
 * test finds every such pair and asserts each narrower action carries its own
 * precondition in the source.
 *
 * Deliberately a build-time check reading the service, like
 * `invoice-immutability.spec.ts` — it needs no database and runs in the same
 * `pnpm verify` as everything else.
 */

const SERVICE = readFileSync(path.join(__dirname, 'distributors.service.ts'), 'utf8');

/** Method name → the status it exists to act from, when narrower than the table. */
const ACTION_PRECONDITIONS: Record<string, string> = {
  reactivate: 'SUSPENDED',
};

/** Every action method that moves a distributor to ACTIVE. */
const ACTIONS_REACHING_ACTIVE = ['approve', 'reactivate'] as const;

function methodBody(name: string): string {
  const start = SERVICE.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`Method ${name}() not found in distributors.service.ts`);
  // Up to the next top-level `async ` method, which is enough to scope the body.
  const next = SERVICE.indexOf('\n  async ', start + 1);
  return SERVICE.slice(start, next === -1 ? SERVICE.length : next);
}

describe('distributor status actions', () => {
  it('has more than one action reaching ACTIVE, which is why the table alone is not a guard', () => {
    // If this ever stops being true the risk is gone — and so is the reason for
    // the rest of this file. It failing is a prompt to re-read, not to delete.
    expect(ACTIONS_REACHING_ACTIVE.length).toBeGreaterThan(1);

    const fromPending = DISTRIBUTOR_TRANSITIONS.PENDING_APPROVAL;
    expect(fromPending).toContain('ACTIVE');
    expect(canTransitionDistributor('PENDING_APPROVAL', 'ACTIVE')).toBe(true);
  });

  it('refuses reactivation from any status but SUSPENDED', () => {
    const body = methodBody('reactivate');

    // The precondition must be on the ACTION, not delegated to the table.
    expect(body).toMatch(/current !== 'SUSPENDED'/);
    expect(body).toMatch(/ConflictError/);
  });

  it('still guards approval on verified KYC, a GSTIN, and a contact', () => {
    const body = methodBody('approve');

    expect(body).toMatch(/missingKyc/);
    expect(body).toMatch(/gstin/);
    expect(body).toMatch(/contacts\.length === 0/);
  });

  it.each(Object.entries(ACTION_PRECONDITIONS))(
    '%s() names its own required status rather than relying on assertTransition',
    (method, requiredStatus) => {
      const body = methodBody(method);
      const guardsItself = body.includes(`'${requiredStatus}'`);
      const relaxedToTableOnly =
        body.includes('assertTransition') && !guardsItself;

      expect(relaxedToTableOnly).toBe(false);
      expect(guardsItself).toBe(true);
    },
  );
});

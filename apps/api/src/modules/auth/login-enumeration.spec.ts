import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `/login` must not become an account-enumeration oracle.
 *
 * ── The bug this exists to prevent, found in Phase 11.1 by execution ───────
 *
 * `docs/06-security.md` §3 promises that `/login` returns identical responses
 * and timing for existent and non-existent accounts. It did — for five
 * attempts. On the sixth, a real account flipped to `ACCOUNT_LOCKED` with an
 * unlock timestamp, while an address that does not exist stayed
 * `INVALID_CREDENTIALS` forever:
 *
 *   real account,     6 attempts → ACCOUNT_LOCKED
 *   absent account,   6 attempts → INVALID_CREDENTIALS
 *
 * Six requests per candidate email therefore enumerated every valid account.
 * The control held in the case everyone had tested and failed in the one
 * nobody had — the recurring shape of every serious defect in this project.
 *
 * The lockout itself is unchanged: the account still locks, the audit log still
 * records `reason: LOCKED`, and `SECURITY_ACCOUNT_LOCKED` still emails the real
 * owner the unlock time. Only the disclosure to an unauthenticated caller
 * changed.
 *
 * ── Why this reads the SOURCE ──────────────────────────────────────────────
 *
 * `AuthService.login` needs Prisma, the password hasher, the token service, the
 * audit service, the clock and the outbox to construct, so a behavioural unit
 * test costs more mocking than the assertion is worth. `invoice-immutability
 * .spec.ts` set the precedent (HANDOFF §4.18): read the artefact and fail the
 * build if a security property is quietly removed. Same technique here.
 */
describe('/login does not leak which accounts exist', () => {
  const source = readFileSync(
    join(__dirname, 'auth.service.ts'),
    'utf8',
  );

  /** The body of `login`, up to the next method at the same indentation. */
  function loginMethod(): string {
    const start = source.indexOf('async login(');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    // Methods in this file are indented two spaces; the next `\n  async ` or
    // `\n  private ` ends the one we are reading.
    const end = rest.slice(1).search(/\n {2}(async|private|\/\*\*)/);
    return end === -1 ? rest : rest.slice(0, end + 1);
  }

  it('never answers an unauthenticated caller with ACCOUNT_LOCKED', () => {
    // The oracle. A locked account must be indistinguishable from a wrong
    // password, or six requests enumerate the user table.
    expect(loginMethod()).not.toContain('ERROR_CODES.ACCOUNT_LOCKED');
  });

  it('never returns an unlock timestamp to an unauthenticated caller', () => {
    // The original message embedded `lockedUntil.toISOString()`, which leaked
    // both existence AND when the account would be usable again.
    expect(loginMethod()).not.toMatch(/lockedUntil\.toISOString\(\)/);
  });

  it('burns time on the locked path, so timing does not leak either', () => {
    // §3 promises identical TIMING. Returning early on a locked account skipped
    // the argon2 verify and answered measurably faster than an unlocked one.
    const body = loginMethod();
    const lockedBranch = body.slice(body.indexOf('user.lockedUntil'));
    expect(lockedBranch).toContain('burnTime()');
  });

  it('still LOCKS the account — the defence is intact, only the disclosure changed', () => {
    // Guards against "fixing" the leak by removing the lockout entirely.
    expect(source).toContain('SECURITY_ACCOUNT_LOCKED');
    expect(source).toMatch(/lockedUntil/);
  });

  it('records the real reason in the AUDIT log, where an attacker cannot read it', () => {
    // An operator must still be able to tell a lockout from a bad password.
    expect(loginMethod()).toContain("reason: 'LOCKED'");
  });
});

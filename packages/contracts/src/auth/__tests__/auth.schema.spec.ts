import { describe, expect, it } from 'vitest';
import {
  acceptInviteSchema,
  changePasswordSchema,
  loginSchema,
  passwordSchema,
  resetPasswordSchema,
} from '../auth.schema';
import { roleAssignmentSchema } from '../user.schema';

describe('password policy', () => {
  it('accepts a long passphrase', () => {
    // NIST 800-63B favours length over composition. A memorable passphrase is
    // stronger than "Passw0rd!" and this policy must not punish it.
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });

  it('rejects anything under 12 characters', () => {
    expect(passwordSchema.safeParse('Short1!x').success).toBe(false);
  });

  it('rejects known breached passwords even when long enough', () => {
    for (const weak of ['password123', 'PASSWORD123', 'changeme123', 'hixaa@123']) {
      expect(passwordSchema.safeParse(weak).success).toBe(false);
    }
  });

  it('rejects a single repeated character', () => {
    expect(passwordSchema.safeParse('aaaaaaaaaaaaaaaa').success).toBe(false);
  });

  it('rejects passwords built from too few distinct characters', () => {
    expect(passwordSchema.safeParse('abababababababab').success).toBe(false);
  });

  it('does NOT impose composition rules', () => {
    // No forced uppercase/digit/symbol — those push users toward predictable
    // patterns while blocking strong passphrases.
    expect(passwordSchema.safeParse('the quick brown fox jumps').success).toBe(true);
  });
});

describe('loginSchema', () => {
  it('normalises the email and defaults rememberMe', () => {
    const parsed = loginSchema.parse({ email: '  ADMIN@Hixaa.com ', password: 'whatever' });
    expect(parsed.email).toBe('admin@hixaa.com');
    expect(parsed.rememberMe).toBe(false);
  });

  it('does NOT apply the password policy on login', () => {
    // A password set under an older policy must still be able to sign in.
    // Validating it here would lock those users out of their own accounts.
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'old' }).success).toBe(true);
  });

  it('requires a 6-digit MFA code when one is supplied', () => {
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'x', mfaCode: '12345' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: 'x', mfaCode: '123456' }).success).toBe(true);
  });
});

describe('password confirmation', () => {
  const valid = 'a-perfectly-fine-passphrase';

  it('rejects a mismatch and points at the confirmation field', () => {
    const result = resetPasswordSchema.safeParse({
      token: 'x'.repeat(24),
      password: valid,
      confirmPassword: 'something-else-entirely',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['confirmPassword']);
    }
  });

  it('refuses to "change" a password to the same value', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: valid,
      password: valid,
      confirmPassword: valid,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed invitation acceptance', () => {
    expect(
      acceptInviteSchema.safeParse({
        token: 'x'.repeat(24),
        firstName: 'Sana',
        lastName: 'Patil',
        password: valid,
        confirmPassword: valid,
      }).success,
    ).toBe(true);
  });
});

describe('roleAssignmentSchema', () => {
  const roleId = '019fc992-0429-7d20-81e0-527357c9680c';
  const scopeId = '019fc992-0429-7d20-81e0-527357c9680d';

  it('accepts a GLOBAL assignment with no scope', () => {
    expect(
      roleAssignmentSchema.safeParse({ roleId, scopeType: 'GLOBAL', scopeId: null }).success,
    ).toBe(true);
  });

  it('accepts a scoped assignment with a scope id', () => {
    expect(
      roleAssignmentSchema.safeParse({ roleId, scopeType: 'TERRITORY', scopeId }).success,
    ).toBe(true);
  });

  it('rejects GLOBAL carrying a scope id', () => {
    // Mirrors the user_role_scope_id_matches_scope_type CHECK constraint, so
    // the caller gets a field error rather than a database exception.
    expect(
      roleAssignmentSchema.safeParse({ roleId, scopeType: 'GLOBAL', scopeId }).success,
    ).toBe(false);
  });

  it('rejects a scoped assignment with no scope id', () => {
    // This is the dangerous direction: it would silently widen a
    // territory-bounded role to everything. See ADR-0003.
    expect(
      roleAssignmentSchema.safeParse({ roleId, scopeType: 'TERRITORY', scopeId: null }).success,
    ).toBe(false);
  });
});

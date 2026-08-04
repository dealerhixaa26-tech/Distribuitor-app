import { z } from 'zod';
import { emailSchema, idSchema, dateTimeSchema } from '../primitives/common';
import { indianPhoneSchema } from '../primitives/india';
import { userStatusSchema } from '../enums';

/**
 * Authentication contracts. See docs/04-rbac-and-permissions.md §6.
 *
 * Used by the NestJS validation pipe, the OpenAPI generator, and the login
 * form's React Hook Form resolver — so a password rule cannot be enforced on
 * one side and not the other.
 */

// ── Password policy (NIST 800-63B) ──────────────────────────────────────────

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * A representative set of the passwords credential-stuffing lists try first.
 * The server checks a far larger list; this exists so the browser can reject
 * the obvious cases before a round trip.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123',
  'admin123', 'administrator', 'letmein123', 'welcome123', 'iloveyou',
  'abc123456', 'monkey123', 'dragon123', 'sunshine1', 'princess1',
  'changeme', 'changeme123', 'hixaa123', 'hixaa@123',
]);

/**
 * Deliberately NOT a composition rule (one upper, one digit, one symbol).
 *
 * NIST 800-63B advises against those: they push users to `Passw0rd!` — which is
 * both compliant and trivially guessable — while blocking genuinely strong
 * passphrases. Length plus a blocklist is the stronger constraint.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), {
    message: 'This password appears in known breach lists. Choose something else.',
  })
  .refine((value) => !/^(.)\1+$/.test(value), {
    message: 'Cannot be a single repeated character',
  })
  .refine((value) => new Set(value.toLowerCase()).size >= 5, {
    message: 'Uses too few distinct characters',
  });

/** Confirms a new password matches its confirmation field. */
export const withPasswordConfirmation = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .extend({ password: passwordSchema, confirmPassword: z.string() })
    .refine((data) => data.password === data.confirmPassword, {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    });

// ── Login ───────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: an existing password set under an older policy must
  // still be able to sign in. Validating it here would lock those users out.
  password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
  rememberMe: z.boolean().default(false),
  /** Six-digit TOTP, supplied on the second step when MFA is enrolled. */
  mfaCode: z
    .string()
    .regex(/^\d{6}$/, 'Enter the 6-digit code')
    .optional(),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  tokenType: z.literal('Bearer'),
  mustChangePassword: z.boolean(),
  user: z.object({
    id: idSchema,
    email: emailSchema,
    firstName: z.string(),
    lastName: z.string(),
    status: userStatusSchema,
  }),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Returned instead of a token when MFA is enrolled — step one of two. */
export const mfaRequiredSchema = z.object({
  mfaRequired: z.literal(true),
  /** Short-lived, single-purpose; only valid for completing this login. */
  challengeToken: z.string(),
});

// ── Password lifecycle ──────────────────────────────────────────────────────

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20, 'Invalid reset link'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.password, {
    message: 'The new password must differ from the current one',
    path: ['password'],
  });
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

export const verifyEmailSchema = z.object({ token: z.string().min(20) });

export const resendVerificationSchema = z.object({ email: emailSchema });

// ── Invitations ─────────────────────────────────────────────────────────────

export const acceptInviteSchema = z
  .object({
    token: z.string().min(20, 'Invalid invitation link'),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    phone: indianPhoneSchema.optional(),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type AcceptInviteDto = z.infer<typeof acceptInviteSchema>;

// ── MFA ─────────────────────────────────────────────────────────────────────

export const mfaEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  backupCodes: z.array(z.string()),
});

export const mfaVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const mfaDisableSchema = z.object({
  password: z.string().min(1, 'Confirm your password to disable MFA'),
});

// ── Session management ──────────────────────────────────────────────────────

export const sessionSchema = z.object({
  id: idSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  rememberMe: z.boolean(),
  lastUsedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  /** Lets the UI mark "this device" so a user does not revoke themselves by accident. */
  isCurrent: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSchema>;

// ── Current user ────────────────────────────────────────────────────────────

export const currentUserSchema = z.object({
  id: idSchema,
  email: emailSchema,
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: userStatusSchema,
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  mustChangePassword: z.boolean(),
  lastLoginAt: dateTimeSchema.nullable(),
  roles: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      scopeType: z.enum(['GLOBAL', 'TERRITORY', 'DISTRIBUTOR']),
      scopeId: idSchema.nullable(),
    }),
  ),
  access: z.object({
    userId: idSchema,
    permissions: z.array(z.string()),
    scopeType: z.enum(['GLOBAL', 'TERRITORY', 'DISTRIBUTOR']),
    territoryIds: z.array(idSchema),
    distributorIds: z.array(idSchema),
  }),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

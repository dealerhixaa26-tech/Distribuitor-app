import { z } from 'zod';
import { dateTimeSchema, emailSchema, idSchema } from '../primitives/common';
import { indianPhoneSchema } from '../primitives/india';
import { cursorPaginationSchema } from '../primitives/pagination';
import { userStatusSchema } from '../enums';

/** User, role, and team contracts for the admin surface. */

// ── Users ───────────────────────────────────────────────────────────────────

export const roleAssignmentSchema = z
  .object({
    roleId: idSchema,
    scopeType: z.enum(['GLOBAL', 'TERRITORY', 'DISTRIBUTOR']).default('GLOBAL'),
    scopeId: idSchema.nullable().default(null),
  })
  // Mirrors the `user_role_scope_id_matches_scope_type` CHECK constraint, so a
  // bad assignment is rejected with a field error rather than a database
  // exception. Both layers enforce it — see docs/06-security.md T3.
  .refine((data) => (data.scopeType === 'GLOBAL') === (data.scopeId === null), {
    message: 'A GLOBAL role must have no scope; a scoped role must have one',
    path: ['scopeId'],
  });
export type RoleAssignmentDto = z.infer<typeof roleAssignmentSchema>;

export const inviteUserSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: indianPhoneSchema.optional(),
  roles: z.array(roleAssignmentSchema).min(1, 'Assign at least one role'),
});
export type InviteUserDto = z.infer<typeof inviteUserSchema>;

export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: indianPhoneSchema.nullable().optional(),
  // Email changes are deliberately excluded: changing an identity requires
  // re-verification and is a separate, audited flow.
});
export type UpdateUserDto = z.infer<typeof updateUserSchema>;

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: indianPhoneSchema.nullable().optional(),
});

export const suspendUserSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

export const userSummarySchema = z.object({
  id: idSchema,
  email: emailSchema,
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: userStatusSchema,
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  lastLoginAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  roles: z.array(
    z.object({
      id: idSchema,
      roleId: idSchema,
      roleKey: z.string(),
      roleName: z.string(),
      scopeType: z.enum(['GLOBAL', 'TERRITORY', 'DISTRIBUTOR']),
      scopeId: idSchema.nullable(),
    }),
  ),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const listUsersQuerySchema = cursorPaginationSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(userStatusSchema).optional()),
  roleKey: z.string().optional(),
  sort: z.string().optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

// ── Roles ───────────────────────────────────────────────────────────────────

export const createRoleSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .min(3)
    .max(50)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use uppercase letters, digits, and underscores'),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  scopeType: z.enum(['GLOBAL', 'TERRITORY', 'DISTRIBUTOR']).default('GLOBAL'),
  level: z.number().int().min(0).max(99, 'Reserved above 99 for system roles').default(10),
  permissions: z.array(z.string()).min(1, 'Grant at least one permission'),
  maxDiscountPercent: z.number().min(0).max(100).nullable().optional(),
  maxOrderValue: z.string().nullable().optional(),
});
export type CreateRoleDto = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = createRoleSchema.partial().omit({ key: true });
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

export const roleSummarySchema = z.object({
  id: idSchema,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scopeType: z.enum(['GLOBAL', 'TERRITORY', 'DISTRIBUTOR']),
  level: z.number().int(),
  isSystem: z.boolean(),
  maxDiscountPercent: z.string().nullable(),
  maxOrderValue: z.string().nullable(),
  permissions: z.array(z.string()),
  userCount: z.number().int().nonnegative(),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

// ── Teams ───────────────────────────────────────────────────────────────────

export const createTeamSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  managerId: idSchema.nullable().optional(),
});
export type CreateTeamDto = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = createTeamSchema.partial();

export const addTeamMemberSchema = z.object({
  userId: idSchema,
  role: z.enum(['MEMBER', 'LEAD']).default('MEMBER'),
});

// ── Audit log ───────────────────────────────────────────────────────────────

export const listAuditLogsQuerySchema = cursorPaginationSchema.extend({
  entityType: z.string().trim().max(80).optional(),
  entityId: idSchema.optional(),
  actorUserId: idSchema.optional(),
  category: z.enum(['AUTH', 'DATA', 'SECURITY', 'INTEGRATION']).optional(),
  action: z.string().trim().max(120).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export const auditLogEntrySchema = z.object({
  id: idSchema,
  actorUserId: idSchema.nullable(),
  actorName: z.string().nullable(),
  actorType: z.enum(['USER', 'SYSTEM', 'API_KEY']),
  category: z.enum(['AUTH', 'DATA', 'SECURITY', 'INTEGRATION']),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ipAddress: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: dateTimeSchema,
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

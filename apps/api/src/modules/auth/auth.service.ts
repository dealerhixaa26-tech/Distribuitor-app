import { Injectable } from '@nestjs/common';
import {
  DOMAIN_EVENTS,
  ERROR_CODES,
  type AcceptInviteDto,
  type ChangePasswordDto,
  type LoginDto,
  type LoginResponse,
  type ResetPasswordDto,
} from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import {
  ConflictError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../common/errors/domain.error';
import { AppConfigService } from '../../config/app-config.service';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OutboxService } from '../../infrastructure/outbox/outbox.service';
import { AccessService } from './services/access.service';
import { PasswordService } from './services/password.service';
import { SessionService, type SessionContext } from './services/session.service';
import { TokenService } from './services/token.service';

/** How long a password-reset link stays valid. */
const RESET_TOKEN_TTL_MINUTES = 30;
/** How long an email-verification link stays valid. */
const VERIFY_TOKEN_TTL_MINUTES = 60 * 24;
/** How long an invitation stays open. */
const INVITE_TOKEN_TTL_MINUTES = 60 * 24 * 7;

export interface AuthResult {
  response: LoginResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, context: SessionContext): Promise<AuthResult> {
    const user = await this.prisma.db.user.findFirst({
      where: { email: dto.email, deletedAt: null },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        firstName: true,
        lastName: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        mustChangePassword: true,
        mfaEnabled: true,
      },
    });

    // No account: still burn the CPU a real verification would, so response
    // time cannot distinguish a valid email from an invalid one.
    if (!user || !user.passwordHash) {
      await this.passwords.burnTime();
      await this.audit.recordStandalone({
        category: 'AUTH',
        action: 'auth.login_failed',
        metadata: { email: dto.email, reason: 'NO_ACCOUNT', ip: context.ipAddress },
      });
      throw new UnauthenticatedError(
        'Incorrect email or password',
        ERROR_CODES.INVALID_CREDENTIALS,
      );
    }

    if (user.lockedUntil && user.lockedUntil > this.clock.now()) {
      throw new UnauthenticatedError(
        `Account is temporarily locked. Try again after ${user.lockedUntil.toISOString()}.`,
        ERROR_CODES.ACCOUNT_LOCKED,
      );
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);

    if (!valid) {
      await this.registerFailedAttempt(user.id, user.email, user.failedLoginAttempts, context);
      throw new UnauthenticatedError(
        'Incorrect email or password',
        ERROR_CODES.INVALID_CREDENTIALS,
      );
    }

    // Status is checked AFTER the password, so a wrong password on a suspended
    // account still reports "incorrect email or password" rather than
    // confirming the account exists.
    if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
      throw new UnauthenticatedError(
        'This account is not active. Contact your administrator.',
        ERROR_CODES.ACCOUNT_SUSPENDED,
      );
    }
    if (user.status === 'INVITED') {
      throw new UnauthenticatedError(
        'Please accept your invitation before signing in.',
        ERROR_CODES.EMAIL_NOT_VERIFIED,
      );
    }

    // MFA is scaffolded; the second factor lands with the TOTP module. Failing
    // closed here means enabling the flag cannot accidentally let a login
    // through without the challenge being implemented.
    if (user.mfaEnabled && this.config.features.mfa) {
      throw new UnauthenticatedError(
        'Multi-factor authentication is required but not yet available in this build.',
        ERROR_CODES.MFA_REQUIRED,
      );
    }

    return this.establishSession(user.id, dto.rememberMe, context, {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      currentHash: user.passwordHash,
      plaintext: dto.password,
    });
  }

  /**
   * Mints a session and an access token. Shared by login, invitation
   * acceptance, and password reset — all three end with the user signed in.
   */
  private async establishSession(
    userId: string,
    rememberMe: boolean,
    context: SessionContext,
    profile: {
      email: string;
      firstName: string;
      lastName: string;
      status: string;
      mustChangePassword: boolean;
      currentHash?: string;
      plaintext?: string;
    },
  ): Promise<AuthResult> {
    const access = await this.access.resolveFresh(userId);

    const issued = await this.prisma.transaction(async (tx) => {
      const session = await this.sessions.issue(tx, userId, rememberMe, context);

      await tx.user.update({
        where: { id: userId },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: this.clock.now(),
          lastLoginIp: context.ipAddress ?? null,
          // Transparently upgrade a hash that predates a parameter increase.
          ...(profile.currentHash &&
          profile.plaintext &&
          this.passwords.needsRehash(profile.currentHash)
            ? { passwordHash: await this.passwords.hash(profile.plaintext) }
            : {}),
        },
      });

      await this.audit.record(tx, {
        category: 'AUTH',
        action: 'auth.login',
        entityType: 'User',
        entityId: userId,
        metadata: { ip: context.ipAddress, userAgent: context.userAgent },
      });

      return session;
    });

    const accessToken = await this.tokens.signAccessToken({
      sub: userId,
      sessionId: issued.sessionId,
      permHash: AccessService.permissionHash(access),
      scopeType: access.scopeType,
    });

    return {
      response: {
        accessToken,
        expiresIn: this.tokens.accessTtlSeconds,
        tokenType: 'Bearer',
        mustChangePassword: profile.mustChangePassword,
        user: {
          id: userId,
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          status: profile.status as LoginResponse['user']['status'],
        },
      },
      refreshToken: issued.refreshToken,
      refreshExpiresAt: issued.expiresAt,
    };
  }

  private async registerFailedAttempt(
    userId: string,
    email: string,
    currentAttempts: number,
    context: SessionContext,
  ): Promise<void> {
    const attempts = currentAttempts + 1;
    const max = this.config.auth.maxLoginAttempts;
    const shouldLock = attempts >= max;
    const lockedUntil = shouldLock
      ? this.clock.plusMinutes(this.config.auth.lockoutMinutes)
      : null;

    await this.prisma.transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { failedLoginAttempts: attempts, ...(shouldLock ? { lockedUntil } : {}) },
      });

      await this.audit.record(tx, {
        category: shouldLock ? 'SECURITY' : 'AUTH',
        action: shouldLock ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'User',
        entityId: userId,
        metadata: { attempts, ip: context.ipAddress },
      });

      if (shouldLock) {
        await this.outbox.emit(
          tx,
          DOMAIN_EVENTS.SECURITY_ACCOUNT_LOCKED,
          { type: 'User', id: userId },
          { email, attempts, unlockAt: lockedUntil?.toISOString() },
        );
      }
    });

    if (shouldLock) {
      this.logger.warn({ userId, attempts, ip: context.ipAddress }, 'Account locked');
    }
  }

  // ── Refresh & logout ──────────────────────────────────────────────────────

  async refresh(refreshToken: string, context: SessionContext): Promise<AuthResult> {
    const { userId, session } = await this.sessions.rotate(refreshToken, context);

    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        mustChangePassword: true,
      },
    });
    if (!user) throw new UnauthenticatedError('Account no longer exists');

    const access = await this.access.resolve(userId);
    const accessToken = await this.tokens.signAccessToken({
      sub: userId,
      sessionId: session.sessionId,
      permHash: AccessService.permissionHash(access),
      scopeType: access.scopeType,
    });

    return {
      response: {
        accessToken,
        expiresIn: this.tokens.accessTtlSeconds,
        tokenType: 'Bearer',
        mustChangePassword: user.mustChangePassword,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          status: user.status,
        },
      },
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.expiresAt,
    };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'LOGOUT');
    await this.audit.recordStandalone({
      category: 'AUTH',
      action: 'auth.logout',
      entityType: 'User',
      entityId: userId,
    });
  }

  async logoutAll(userId: string): Promise<number> {
    const count = await this.sessions.revokeAllForUser(userId, 'LOGOUT_ALL');
    await this.audit.recordStandalone({
      category: 'AUTH',
      action: 'auth.logout_all',
      entityType: 'User',
      entityId: userId,
      metadata: { sessionsRevoked: count },
    });
    return count;
  }

  // ── Password reset ────────────────────────────────────────────────────────

  /**
   * Always resolves successfully, whether or not the address exists.
   *
   * Reporting "no such account" would turn this endpoint into an email
   * enumeration oracle — the caller learns nothing either way.
   */
  async requestPasswordReset(email: string, context: SessionContext): Promise<void> {
    const user = await this.prisma.db.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, email: true, firstName: true, status: true },
    });

    if (!user || user.status === 'DISABLED') {
      this.logger.info({ email }, 'Password reset requested for unknown or disabled account');
      return;
    }

    const { token, hash } = this.tokens.generateOneTimeToken();

    await this.prisma.transaction(async (tx) => {
      // Any older outstanding link stops working — a reset request should
      // leave exactly one usable token.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: this.clock.now() },
      });

      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hash,
          expiresAt: this.clock.plusMinutes(RESET_TOKEN_TTL_MINUTES),
          ipAddress: context.ipAddress ?? null,
        },
      });

      await this.audit.record(tx, {
        category: 'AUTH',
        action: 'auth.password_reset_requested',
        entityType: 'User',
        entityId: user.id,
        metadata: { ip: context.ipAddress },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.USER_PASSWORD_RESET_REQUESTED,
        { type: 'User', id: user.id },
        {
          email: user.email,
          name: user.firstName,
          token,
          expiresInMinutes: String(RESET_TOKEN_TTL_MINUTES),
        },
      );
    });
  }

  async resetPassword(dto: ResetPasswordDto, context: SessionContext): Promise<void> {
    const hash = TokenService.hashToken(dto.token);

    const record = await this.prisma.db.passwordResetToken.findUnique({
      where: { tokenHash: hash },
      select: {
        id: true,
        userId: true,
        usedAt: true,
        expiresAt: true,
        user: { select: { email: true, firstName: true, deletedAt: true } },
      },
    });

    if (!record || record.usedAt || record.expiresAt <= this.clock.now() || record.user.deletedAt) {
      throw new ValidationError('This reset link is invalid or has expired.', [
        { field: 'token', code: ERROR_CODES.TOKEN_INVALID, message: 'Invalid or expired link' },
      ]);
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.transaction(async (tx) => {
      await tx.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: this.clock.now() },
      });

      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: this.clock.now(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      // Every existing session dies. If the reset was triggered because an
      // account was compromised, leaving the attacker's session alive would
      // defeat the entire exercise.
      await tx.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: this.clock.now(), revokedReason: 'PASSWORD_RESET' },
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'auth.password_reset',
        entityType: 'User',
        entityId: record.userId,
        metadata: { ip: context.ipAddress },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.USER_PASSWORD_CHANGED,
        { type: 'User', id: record.userId },
        {
          email: record.user.email,
          name: record.user.firstName,
          changedAt: this.clock.nowIso(),
          ipAddress: context.ipAddress ?? '',
        },
      );
    });
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    dto: ChangePasswordDto,
    context: SessionContext,
  ): Promise<void> {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, firstName: true, passwordHash: true },
    });
    if (!user?.passwordHash) throw new NotFoundError('User', userId);

    const valid = await this.passwords.verify(user.passwordHash, dto.currentPassword);
    if (!valid) {
      throw new ValidationError('Your current password is incorrect.', [
        {
          field: 'currentPassword',
          code: ERROR_CODES.INVALID_CREDENTIALS,
          message: 'Incorrect password',
        },
      ]);
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: this.clock.now(),
        },
      });

      // Other devices are signed out; the current one stays, so changing a
      // password does not eject the person who just changed it.
      await tx.session.updateMany({
        where: { userId, revokedAt: null, id: { not: currentSessionId } },
        data: { revokedAt: this.clock.now(), revokedReason: 'PASSWORD_CHANGED' },
      });

      await this.audit.record(tx, {
        category: 'SECURITY',
        action: 'auth.password_changed',
        entityType: 'User',
        entityId: userId,
        metadata: { ip: context.ipAddress },
      });

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.USER_PASSWORD_CHANGED,
        { type: 'User', id: userId },
        {
          email: user.email,
          name: user.firstName,
          changedAt: this.clock.nowIso(),
          ipAddress: context.ipAddress ?? '',
        },
      );
    });
  }

  // ── Email verification & invitations ──────────────────────────────────────

  async verifyEmail(token: string): Promise<void> {
    const hash = TokenService.hashToken(token);

    const record = await this.prisma.db.emailVerificationToken.findUnique({
      where: { tokenHash: hash },
      select: { id: true, userId: true, email: true, usedAt: true, expiresAt: true },
    });

    if (!record || record.usedAt || record.expiresAt <= this.clock.now()) {
      throw new ValidationError('This verification link is invalid or has expired.', [
        { field: 'token', code: ERROR_CODES.TOKEN_INVALID, message: 'Invalid or expired link' },
      ]);
    }

    await this.prisma.transaction(async (tx) => {
      await tx.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: this.clock.now() },
      });
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: this.clock.now() },
      });
      await this.audit.record(tx, {
        category: 'AUTH',
        action: 'auth.email_verified',
        entityType: 'User',
        entityId: record.userId,
      });
    });
  }

  async acceptInvite(dto: AcceptInviteDto, context: SessionContext): Promise<AuthResult> {
    const hash = TokenService.hashToken(dto.token);

    const record = await this.prisma.db.emailVerificationToken.findUnique({
      where: { tokenHash: hash },
      select: {
        id: true,
        userId: true,
        usedAt: true,
        expiresAt: true,
        user: { select: { id: true, email: true, status: true, deletedAt: true } },
      },
    });

    if (!record || record.usedAt || record.expiresAt <= this.clock.now() || record.user.deletedAt) {
      throw new ValidationError('This invitation is invalid or has expired.', [
        { field: 'token', code: ERROR_CODES.TOKEN_INVALID, message: 'Invalid or expired link' },
      ]);
    }

    if (record.user.status !== 'INVITED') {
      throw new ConflictError('This invitation has already been accepted.');
    }

    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.transaction(async (tx) => {
      await tx.emailVerificationToken.update({
        where: { id: record.id },
        data: { usedAt: this.clock.now() },
      });

      await tx.user.update({
        where: { id: record.userId },
        data: {
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
          passwordHash,
          status: 'ACTIVE',
          emailVerifiedAt: this.clock.now(),
          passwordChangedAt: this.clock.now(),
          mustChangePassword: false,
        },
      });

      await this.audit.record(tx, {
        category: 'AUTH',
        action: 'auth.invitation_accepted',
        entityType: 'User',
        entityId: record.userId,
        metadata: { ip: context.ipAddress },
      });
    });

    return this.establishSession(record.userId, false, context, {
      email: record.user.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      status: 'ACTIVE',
      mustChangePassword: false,
    });
  }

  /** Issues an invitation token. Called by the users module. */
  async createInvitationToken(tx: Parameters<AuditService['record']>[0], userId: string, email: string) {
    const { token, hash } = this.tokens.generateOneTimeToken();
    await tx.emailVerificationToken.create({
      data: {
        userId,
        email,
        tokenHash: hash,
        expiresAt: this.clock.plusMinutes(INVITE_TOKEN_TTL_MINUTES),
      },
    });
    return token;
  }

  /** Issues an email-verification token. */
  async createVerificationToken(
    tx: Parameters<AuditService['record']>[0],
    userId: string,
    email: string,
  ) {
    const { token, hash } = this.tokens.generateOneTimeToken();
    await tx.emailVerificationToken.create({
      data: {
        userId,
        email,
        tokenHash: hash,
        expiresAt: this.clock.plusMinutes(VERIFY_TOKEN_TTL_MINUTES),
      },
    });
    return token;
  }

  // ── Current user ──────────────────────────────────────────────────────────

  async currentUser(userId: string) {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        status: true,
        emailVerifiedAt: true,
        mfaEnabled: true,
        mustChangePassword: true,
        lastLoginAt: true,
        roles: {
          select: {
            scopeType: true,
            scopeId: true,
            role: { select: { key: true, name: true } },
          },
        },
      },
    });
    if (!user) throw new NotFoundError('User', userId);

    const access = await this.access.resolve(userId);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      avatarUrl: user.avatarUrl,
      status: user.status,
      emailVerified: Boolean(user.emailVerifiedAt),
      mfaEnabled: user.mfaEnabled,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      roles: user.roles.map((assignment) => ({
        key: assignment.role.key,
        name: assignment.role.name,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
      })),
      access,
    };
  }
}

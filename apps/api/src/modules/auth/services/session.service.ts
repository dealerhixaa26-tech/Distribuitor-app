import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DOMAIN_EVENTS } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../../common/utils/clock.service';
import { UnauthenticatedError } from '../../../common/errors/domain.error';
import { ERROR_CODES } from '@hixaa/contracts';
import { PrismaService, type PrismaTransaction } from '../../../infrastructure/database/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { TokenService } from './token.service';

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

/**
 * Refresh-token sessions with rotation and reuse detection.
 *
 * ── Why rotation ──────────────────────────────────────────────────────────
 * A refresh token lives for days. If one is stolen, the attacker has a durable
 * foothold. Rotation means every use issues a new token and retires the old
 * one, so a stolen token is only useful until the legitimate user next
 * refreshes.
 *
 * ── Why reuse detection ───────────────────────────────────────────────────
 * Rotation alone does not tell you theft happened. But an ALREADY-ROTATED token
 * being presented is unambiguous: the legitimate client moved on to its
 * successor, so whoever sent the old one has a copy they should not have.
 *
 * Every rotation shares a `familyId`. On replay we revoke the entire family —
 * not just the replayed token — because we cannot tell whether the attacker or
 * the victim holds the current one. Signing everyone out is the safe answer,
 * and a security alert goes to the ops channel.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly outbox: OutboxService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SessionService.name);
  }

  /** Starts a new session lineage. Called on successful login. */
  async issue(
    tx: PrismaTransaction,
    userId: string,
    rememberMe: boolean,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const { token, hash } = this.tokens.generateRefreshToken();
    const expiresAt = this.clock.plusSeconds(this.tokens.refreshTtlSeconds(rememberMe));

    const session = await tx.session.create({
      data: {
        userId,
        refreshTokenHash: hash,
        // A fresh lineage: this login is not a rotation of anything.
        familyId: randomUUID(),
        rememberMe,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
        expiresAt,
        lastUsedAt: this.clock.now(),
      },
      select: { id: true },
    });

    return { sessionId: session.id, refreshToken: token, expiresAt };
  }

  /**
   * Exchanges a refresh token for a new one.
   *
   * ── Why the revoke-then-throw paths are NOT one transaction ──────────────
   * The obvious implementation does the reuse check, the family revocation,
   * the security alert, and the throw all inside one transaction. That is
   * wrong, and silently so: throwing rolls the transaction back, which undoes
   * the revocation and discards the outbox alert. The endpoint would correctly
   * report "reuse detected" while leaving the stolen token fully usable.
   *
   * So every path that revokes and then rejects COMMITS the revocation first,
   * in its own transaction, and throws afterwards.
   */
  async rotate(
    presentedToken: string,
    context: SessionContext,
  ): Promise<{ userId: string; session: IssuedSession }> {
    const presentedHash = TokenService.hashToken(presentedToken);

    const existing = await this.prisma.db.session.findUnique({
      where: { refreshTokenHash: presentedHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        rememberMe: true,
        expiresAt: true,
        revokedAt: true,
        replacedById: true,
        user: { select: { status: true, deletedAt: true } },
      },
    });

    // An unknown token is either garbage or one we already purged. Either way
    // there is no lineage to revoke.
    if (!existing) {
      throw new UnauthenticatedError('Invalid session', ERROR_CODES.TOKEN_INVALID);
    }

    // ── Reuse detection ───────────────────────────────────────────────────
    // `replacedById` set means this token was already rotated: the rightful
    // client moved on to its successor, so whoever presented this one has a
    // copy they should not have.
    //
    // The whole family is revoked, not just this token, because we cannot tell
    // whether the attacker or the victim holds the current one. Signing
    // everybody out is the safe answer.
    if (existing.replacedById || existing.revokedAt) {
      await this.handleReuse(existing.id, existing.userId, existing.familyId, context);
      throw new UnauthenticatedError(
        'This session has been terminated for security reasons. Please sign in again.',
        ERROR_CODES.TOKEN_REUSE_DETECTED,
      );
    }

    if (existing.expiresAt <= this.clock.now()) {
      throw new UnauthenticatedError('Session expired', ERROR_CODES.TOKEN_EXPIRED);
    }

    // The session may outlive the account's ability to use it.
    if (existing.user.deletedAt || existing.user.status !== 'ACTIVE') {
      await this.prisma.transaction((tx) =>
        this.revokeFamily(tx, existing.familyId, 'USER_NOT_ACTIVE'),
      );
      throw new UnauthenticatedError('Account is not active', ERROR_CODES.ACCOUNT_SUSPENDED);
    }

    // ── Rotate ────────────────────────────────────────────────────────────
    const { token, hash } = this.tokens.generateRefreshToken();
    // The lineage keeps its ORIGINAL expiry: refreshing must not let a session
    // live forever.
    const expiresAt = existing.expiresAt;

    const rotated = await this.prisma.transaction(async (tx) => {
      // Claim the old session first, conditional on it still being unrotated.
      // Two concurrent refreshes with the same token both pass the checks
      // above; this update is the point where exactly one of them wins, and
      // the loser sees count 0 rather than creating a second live session.
      const claimed = await tx.session.updateMany({
        where: { id: existing.id, replacedById: null, revokedAt: null },
        data: { revokedAt: this.clock.now(), revokedReason: 'ROTATED' },
      });

      if (claimed.count !== 1) return null;

      const replacement = await tx.session.create({
        data: {
          userId: existing.userId,
          refreshTokenHash: hash,
          familyId: existing.familyId,
          rememberMe: existing.rememberMe,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent?.slice(0, 500) ?? null,
          expiresAt,
          lastUsedAt: this.clock.now(),
        },
        select: { id: true },
      });

      await tx.session.update({
        where: { id: existing.id },
        data: { replacedById: replacement.id },
      });

      return replacement.id;
    });

    // Lost the race. Treated as reuse: from here we cannot distinguish a
    // double-submitted legitimate refresh from a genuine replay, and the safe
    // reading of an ambiguous signal is the hostile one.
    if (!rotated) {
      await this.handleReuse(existing.id, existing.userId, existing.familyId, context);
      throw new UnauthenticatedError(
        'This session has been terminated for security reasons. Please sign in again.',
        ERROR_CODES.TOKEN_REUSE_DETECTED,
      );
    }

    return {
      userId: existing.userId,
      session: { sessionId: rotated, refreshToken: token, expiresAt },
    };
  }

  /**
   * Revokes a compromised lineage and raises the alert — in a transaction that
   * COMMITS, so the caller can safely throw afterwards.
   */
  private async handleReuse(
    sessionId: string,
    userId: string,
    familyId: string,
    context: SessionContext,
  ): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      await this.revokeFamily(tx, familyId, 'TOKEN_REUSE_DETECTED');

      await this.outbox.emit(
        tx,
        DOMAIN_EVENTS.SECURITY_TOKEN_REUSE_DETECTED,
        { type: 'Session', id: sessionId },
        {
          userId,
          familyId,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
        },
      );
    });

    this.logger.error(
      { userId, familyId, ip: context.ipAddress },
      'Refresh token reuse detected — entire session family revoked',
    );
  }

  /** Revokes one session — a normal sign-out. */
  async revoke(sessionId: string, reason = 'LOGOUT'): Promise<void> {
    await this.prisma.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  /** Revokes every live session for a user — "sign out everywhere". */
  async revokeAllForUser(userId: string, reason = 'LOGOUT_ALL'): Promise<number> {
    const result = await this.prisma.db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return result.count;
  }

  /** Revokes a whole rotation lineage. */
  private async revokeFamily(
    tx: PrismaTransaction,
    familyId: string,
    reason: string,
  ): Promise<void> {
    await tx.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  /**
   * Confirms a session is still live. Called by the auth guard so that a
   * revoked session stops working immediately rather than at token expiry.
   */
  async assertActive(sessionId: string): Promise<void> {
    const session = await this.prisma.db.session.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= this.clock.now()) {
      throw new UnauthenticatedError('Session is no longer valid', ERROR_CODES.TOKEN_INVALID);
    }
  }

  /** Live sessions for the account settings screen. */
  async listForUser(userId: string, currentSessionId?: string) {
    const sessions = await this.prisma.db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: this.clock.now() } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        rememberMe: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    return sessions.map((session) => ({
      ...session,
      isCurrent: session.id === currentSessionId,
    }));
  }

  /** Records activity, used to show "last active" without a write per request. */
  async touch(sessionId: string): Promise<void> {
    await this.prisma.db.session
      .updateMany({ where: { id: sessionId }, data: { lastUsedAt: this.clock.now() } })
      .catch(() => undefined);
  }
}

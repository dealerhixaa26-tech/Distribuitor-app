import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * Token minting and hashing.
 *
 * Two deliberately different designs:
 *
 *   • ACCESS tokens are JWTs — self-contained and verifiable without a database
 *     round trip, which is what keeps per-request auth cheap. Short-lived (15
 *     minutes) precisely because they cannot be revoked.
 *
 *   • REFRESH tokens are OPAQUE random values, not JWTs. They are long-lived
 *     and must be revocable, and a JWT cannot be revoked without the database
 *     lookup that made it attractive in the first place. Only the SHA-256 of
 *     the value is stored, so a database leak does not hand over live sessions.
 *
 * See docs/04-rbac-and-permissions.md §6.
 */

export interface AccessTokenClaims {
  sub: string;
  sessionId: string;
  /**
   * Hash of the caller's effective permission set, not the set itself.
   *
   * Keeps the token small, and — more importantly — lets a guard detect that
   * permissions changed since the token was minted and force a refresh. A
   * revoked permission then takes effect within 15 minutes rather than
   * persisting until expiry.
   */
  permHash: string;
  scopeType: 'GLOBAL' | 'TERRITORY' | 'DISTRIBUTOR';
}

/** Single-use tokens delivered by email. */
export type OneTimeTokenPurpose = 'PASSWORD_RESET' | 'EMAIL_VERIFICATION' | 'INVITATION';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  // ── Access tokens ─────────────────────────────────────────────────────────

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      secret: this.config.auth.jwtSecret,
      // Seconds rather than the `15m` string: jsonwebtoken types the string
      // form as a template literal (`StringValue`), which a config-sourced
      // `string` cannot satisfy. Parsing it ourselves keeps the config plain.
      expiresIn: this.accessTtlSeconds,
      issuer: this.config.auth.issuer,
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token, {
      secret: this.config.auth.jwtSecret,
      issuer: this.config.auth.issuer,
    });
  }

  /** Access-token lifetime in seconds, for the `expiresIn` response field. */
  get accessTtlSeconds(): number {
    return parseDuration(this.config.auth.accessTtl);
  }

  refreshTtlSeconds(rememberMe: boolean): number {
    return parseDuration(
      rememberMe ? this.config.auth.refreshTtlRememberMe : this.config.auth.refreshTtl,
    );
  }

  // ── Refresh tokens ────────────────────────────────────────────────────────

  /**
   * 256 bits of entropy, base64url encoded. Returned once to the caller; only
   * the hash is ever persisted.
   */
  generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: TokenService.hashToken(token) };
  }

  // ── One-time tokens (reset, verification, invitation) ─────────────────────

  generateOneTimeToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: TokenService.hashToken(token) };
  }

  /**
   * SHA-256, deliberately NOT argon2.
   *
   * These are 256-bit random values, not user-chosen passwords: there is no
   * dictionary to attack, so a slow KDF buys nothing and would add ~50 ms to
   * every token lookup. Argon2's cost exists to defend low-entropy secrets.
   */
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Stable fingerprint of a permission set, order-independent so that merely
   * reordering a role's grants does not invalidate every live token.
   */
  static hashPermissions(permissions: readonly string[]): string {
    return createHash('sha256').update([...permissions].sort().join('|')).digest('hex').slice(0, 16);
  }
}

/** Parses `15m`, `7d`, `24h` into seconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);

  const amount = Number(match[1]);
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
  const multiplier = multipliers[match[2] as string];
  if (multiplier === undefined) throw new Error(`Invalid duration unit: ${value}`);

  return amount * multiplier;
}

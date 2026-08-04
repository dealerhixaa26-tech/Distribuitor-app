import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * Password hashing and verification.
 *
 * Argon2id is the current recommendation (OWASP, RFC 9106): it resists both GPU
 * cracking and side-channel attacks, which argon2i and argon2d each only
 * half-solve. Parameters come from config so they can be raised as hardware
 * improves without a code change.
 */
@Injectable()
export class PasswordService implements OnModuleInit {
  /**
   * A real argon2id hash, generated once at boot with the configured
   * parameters. Used only by `burnTime()`.
   */
  private decoyHash!: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PasswordService.name);
  }

  async onModuleInit(): Promise<void> {
    // Hashing a random value means the decoy's plaintext is unknown even to
    // this process, and the hash carries exactly the configured cost — so
    // burnTime() does the same work a genuine verification does.
    this.decoyHash = await this.hash(randomBytes(32).toString('hex'));
  }

  private get options(): argon2.Options {
    const { memoryCost, timeCost, parallelism } = this.config.auth.argon2;
    return { type: argon2.argon2id, memoryCost, timeCost, parallelism };
  }

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options);
  }

  /**
   * Verifies a password. Returns false rather than throwing on a malformed
   * hash — a corrupted row must fail the login, not crash the endpoint.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch (error) {
      this.logger.error({ err: error }, 'Password verification failed (malformed hash?)');
      return false;
    }
  }

  /**
   * Burns the same CPU a real verification would, when there is no hash to
   * check against.
   *
   * Called when the submitted email has no account. Without it a missing
   * account answers in about a millisecond and a real one in ~50 ms, and that
   * gap alone lets an attacker enumerate valid addresses — no distinguishing
   * error message required. See docs/06-security.md §3.
   */
  async burnTime(): Promise<void> {
    // Always fails; the point is the work, not the result.
    await argon2.verify(this.decoyHash, 'never-matches').catch(() => false);
  }

  /**
   * True when a stored hash used weaker parameters than the current config, so
   * it should be transparently re-hashed on the next successful login.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return true;
    }
  }

  /** Constant-time comparison for tokens and codes. */
  static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    // Length is not secret here, and timingSafeEqual requires equal lengths.
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}

/**
 * A token bucket, for staying inside Google's write quota.
 *
 * Sheets allows roughly 300 write requests per minute per project. Exceeding it
 * returns 429, and a backup that trips the quota half way through leaves a
 * partially written sheet — which is the failure mode `docs/07` §2 is most
 * concerned about.
 *
 * ── Why this is its own class ──────────────────────────────────────────────
 *
 * It is the one piece of quota handling that can be PROVEN without a Google
 * account. The adapter that calls it cannot be executed until credentials exist
 * (E7, ADR-0023), but refill arithmetic, exhaustion and wait time are pure
 * functions of a clock, so they are tested directly instead of being inferred
 * later from a production 429.
 *
 * The bucket takes its clock as a parameter for exactly that reason.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    /** Sustained rate. Sheets' documented ceiling is ~300/min; default lower. */
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  /** Adds the tokens accrued since the last check, never above capacity. */
  private refill(): void {
    const nowMs = this.now();
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsedMs === 0) return;

    const accrued = (elapsedMs / 60_000) * this.refillPerMinute;
    this.tokens = Math.min(this.capacity, this.tokens + accrued);
    this.lastRefillMs = nowMs;
  }

  /** Tokens available right now, refill applied. Exposed for tests and logs. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** Takes one token if there is one. Does not wait. */
  tryTake(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /**
   * Milliseconds until `count` tokens are available. 0 when they already are.
   *
   * Separated from any actual sleeping so the pacing decision is testable
   * without making a test wait in real time.
   */
  waitMs(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    const deficit = count - this.tokens;
    return Math.ceil((deficit / this.refillPerMinute) * 60_000);
  }
}

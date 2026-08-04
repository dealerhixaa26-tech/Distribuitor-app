import { Injectable } from '@nestjs/common';

/**
 * Injectable clock.
 *
 * Direct `new Date()` calls are banned by an ESLint rule (see
 * packages/config/eslint/base.js) because time-dependent logic — token expiry,
 * invoice financial year, aging buckets, reservation timeouts — becomes
 * untestable when the clock is a global. Tests substitute a FixedClock and
 * assert on exact boundaries instead of sleeping.
 */
@Injectable()
export class ClockService {
  now(): Date {
    return new Date();
  }

  nowMs(): number {
    return Date.now();
  }

  /** ISO 8601 in UTC — the canonical wire format. */
  nowIso(): string {
    return this.now().toISOString();
  }

  plusSeconds(seconds: number, from: Date = this.now()): Date {
    return new Date(from.getTime() + seconds * 1000);
  }

  plusMinutes(minutes: number, from: Date = this.now()): Date {
    return this.plusSeconds(minutes * 60, from);
  }

  plusDays(days: number, from: Date = this.now()): Date {
    return this.plusSeconds(days * 86_400, from);
  }

  isPast(date: Date): boolean {
    return date.getTime() < this.nowMs();
  }
}

/** Deterministic clock for tests. */
export class FixedClock extends ClockService {
  constructor(private current: Date) {
    super();
  }

  override now(): Date {
    return new Date(this.current);
  }

  override nowMs(): number {
    return this.current.getTime();
  }

  /** Advances the clock so a test can cross an expiry boundary explicitly. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = new Date(date);
  }
}

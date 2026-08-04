import { backoffDelayMs, isExhausted, MAX_ATTEMPTS } from './outbox-dispatcher.service';

/**
 * The retry schedule is the difference between a transient SMTP failure
 * recovering on its own and a customer email that never arrives. It is a pure
 * function precisely so it can be asserted directly rather than inferred from
 * timestamps in an integration test.
 */
describe('outbox retry policy', () => {
  describe('backoffDelayMs', () => {
    it('follows the documented 1m, 2m, 4m, 8m, 16m schedule', () => {
      expect(backoffDelayMs(1)).toBe(60_000);
      expect(backoffDelayMs(2)).toBe(120_000);
      expect(backoffDelayMs(3)).toBe(240_000);
      expect(backoffDelayMs(4)).toBe(480_000);
      expect(backoffDelayMs(5)).toBe(960_000);
    });

    it('caps at one hour so a long-dead consumer still retries periodically', () => {
      expect(backoffDelayMs(20)).toBe(3_600_000);
      expect(backoffDelayMs(1000)).toBe(3_600_000);
    });

    it('never returns a negative or zero delay, even for absurd input', () => {
      // A zero delay would spin the dispatcher against a failing consumer as
      // fast as the poll loop allows.
      for (const attempts of [0, -1, -100]) {
        expect(backoffDelayMs(attempts)).toBeGreaterThan(0);
      }
    });

    it('is monotonically non-decreasing', () => {
      let previous = 0;
      for (let attempts = 1; attempts <= 30; attempts++) {
        const delay = backoffDelayMs(attempts);
        expect(delay).toBeGreaterThanOrEqual(previous);
        previous = delay;
      }
    });
  });

  describe('isExhausted', () => {
    it('allows exactly MAX_ATTEMPTS tries before parking the event as DEAD', () => {
      for (let attempts = 1; attempts < MAX_ATTEMPTS; attempts++) {
        expect(isExhausted(attempts)).toBe(false);
      }
      expect(isExhausted(MAX_ATTEMPTS)).toBe(true);
      expect(isExhausted(MAX_ATTEMPTS + 1)).toBe(true);
    });
  });
});

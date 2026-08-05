import { TokenBucket } from './token-bucket';

/**
 * The quota limiter is the one part of Sheets pacing that can be proven with no
 * Google account (ADR-0023), so it is proven properly rather than left to be
 * discovered from a production 429.
 */
describe('TokenBucket', () => {
  /** A clock the test moves by hand — no real waiting, no flakiness. */
  function fakeClock(startMs = 0) {
    let now = startMs;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('starts full and spends down to empty', () => {
    const bucket = new TokenBucket(3, 60, () => 0);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('refills at the configured rate', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(10, 60, clock.now); // 1 per second
    for (let i = 0; i < 10; i++) bucket.tryTake();
    expect(bucket.tryTake()).toBe(false);

    clock.advance(1_000);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);

    clock.advance(5_000);
    expect(Math.floor(bucket.available())).toBe(5);
  });

  it('never refills above capacity, however long it idles', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 600, clock.now);
    bucket.tryTake();
    clock.advance(60 * 60 * 1000); // an hour
    expect(bucket.available()).toBe(5);
  });

  it('reports how long until a token is free', () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 60, clock.now); // 1 per second
    expect(bucket.waitMs()).toBe(0);

    bucket.tryTake();
    bucket.tryTake();
    // Empty: one token is one second away.
    expect(bucket.waitMs()).toBe(1_000);
    // Three tokens are three seconds away.
    expect(bucket.waitMs(3)).toBe(3_000);
  });

  it('paces a burst larger than capacity instead of letting it through', () => {
    // The real shape of the risk: a 400,000-row export is thousands of writes,
    // and letting them all go at once is what trips the quota and leaves a
    // half-written sheet.
    const clock = fakeClock();
    const bucket = new TokenBucket(50, 300, clock.now); // Sheets' documented ceiling
    let granted = 0;
    for (let i = 0; i < 500; i++) if (bucket.tryTake()) granted++;

    expect(granted).toBe(50);
    clock.advance(60_000);
    expect(Math.floor(bucket.available())).toBe(50); // capped, not 300
  });
});

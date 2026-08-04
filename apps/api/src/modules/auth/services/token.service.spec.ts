import { TokenService, parseDuration } from './token.service';

describe('parseDuration', () => {
  it('converts every supported unit to seconds', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('24h')).toBe(86_400);
    expect(parseDuration('7d')).toBe(604_800);
    expect(parseDuration('30d')).toBe(2_592_000);
  });

  it('rejects malformed durations rather than silently defaulting', () => {
    // A typo that silently became "0 seconds" would expire every token
    // instantly; one that became Infinity would never expire them.
    for (const bad of ['15', 'm', '15x', '', '-5m', '1.5h', '15 m']) {
      expect(() => parseDuration(bad)).toThrow(/Invalid duration/);
    }
  });
});

describe('TokenService.hashToken', () => {
  it('is deterministic — the same token always yields the same hash', () => {
    // Lookup depends on this: we store the hash and search by it.
    expect(TokenService.hashToken('abc123')).toBe(TokenService.hashToken('abc123'));
  });

  it('produces a different hash for a different token', () => {
    expect(TokenService.hashToken('abc123')).not.toBe(TokenService.hashToken('abc124'));
  });

  it('returns a 64-character hex digest (SHA-256)', () => {
    expect(TokenService.hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never returns the token itself', () => {
    const token = 'a-refresh-token-value';
    expect(TokenService.hashToken(token)).not.toContain(token);
  });
});

describe('TokenService.hashPermissions', () => {
  it('is order-independent', () => {
    // Reordering a role's grants must not invalidate every live access token.
    const a = TokenService.hashPermissions(['order:read', 'user:read', 'invoice:issue']);
    const b = TokenService.hashPermissions(['invoice:issue', 'order:read', 'user:read']);
    expect(a).toBe(b);
  });

  it('changes when a permission is added', () => {
    const before = TokenService.hashPermissions(['order:read']);
    const after = TokenService.hashPermissions(['order:read', 'order:approve']);
    expect(before).not.toBe(after);
  });

  it('changes when a permission is REVOKED', () => {
    // The security-critical direction: this mismatch is what forces a refresh
    // so a revoked permission stops working within the access-token TTL
    // instead of persisting until expiry.
    const before = TokenService.hashPermissions(['order:read', 'order:approve']);
    const after = TokenService.hashPermissions(['order:read']);
    expect(before).not.toBe(after);
  });

  it('does not mutate the caller’s array', () => {
    const permissions = ['b', 'a'];
    TokenService.hashPermissions(permissions);
    expect(permissions).toEqual(['b', 'a']);
  });

  it('is short enough to keep the JWT small', () => {
    expect(TokenService.hashPermissions(['a', 'b'])).toHaveLength(16);
  });
});

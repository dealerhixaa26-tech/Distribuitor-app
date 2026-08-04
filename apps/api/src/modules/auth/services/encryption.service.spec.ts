import { EncryptionService } from './encryption.service';
import type { AppConfigService } from '../../../config/app-config.service';

/**
 * AES-256-GCM for data that must be readable again — MFA secrets and bank
 * account numbers. Passwords are hashed, never encrypted; different problems,
 * different tools.
 */
const configWith = (keys: Record<string, string>, active: string) =>
  ({ encryption: { keys, activeVersion: active } }) as unknown as AppConfigService;

const KEY_V1 = 'v1-key-'.padEnd(48, 'x');
const KEY_V2 = 'v2-key-'.padEnd(48, 'y');

describe('EncryptionService', () => {
  const service = new EncryptionService(configWith({ V1: KEY_V1 }, 'V1'));

  it('round-trips a value', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(service.decrypt(service.encrypt(secret))).toBe(secret);
  });

  it('round-trips unicode and long values intact', () => {
    for (const value of ['बैंक खाता ४२', '🔐 secret', 'x'.repeat(5000), '']) {
      expect(service.decrypt(service.encrypt(value))).toBe(value);
    }
  });

  it('produces different ciphertext each time for the same plaintext', () => {
    // A random IV per encryption. Without it, identical secrets would produce
    // identical ciphertext, leaking which users share a value.
    const a = service.encrypt('same-value');
    const b = service.encrypt('same-value');
    expect(a).not.toBe(b);
    expect(service.decrypt(a)).toBe(service.decrypt(b));
  });

  it('never stores the plaintext in the ciphertext', () => {
    expect(service.encrypt('SUPERSECRET')).not.toContain('SUPERSECRET');
  });

  it('tags the ciphertext with its key version', () => {
    expect(service.encrypt('x').startsWith('V1:')).toBe(true);
  });

  describe('tamper detection (why GCM, not CBC)', () => {
    it('rejects modified ciphertext instead of returning altered plaintext', () => {
      const [version, iv, tag, data] = service.encrypt('transfer-1000').split(':') as [
        string,
        string,
        string,
        string,
      ];
      // Flip a byte in the payload. CBC would decrypt to garbage silently;
      // GCM's auth tag makes it fail loudly.
      const corrupted = Buffer.from(data, 'base64');
      corrupted[0] = (corrupted[0]! ^ 0xff) & 0xff;

      expect(() =>
        service.decrypt([version, iv, tag, corrupted.toString('base64')].join(':')),
      ).toThrow();
    });

    it('rejects a swapped authentication tag', () => {
      const first = service.encrypt('value-a').split(':');
      const second = service.encrypt('value-b').split(':');
      const forged = [first[0], first[1], second[2], first[3]].join(':');
      expect(() => service.decrypt(forged)).toThrow();
    });

    it('rejects a malformed envelope', () => {
      for (const bad of ['', 'nonsense', 'V1:only:three']) {
        expect(() => service.decrypt(bad)).toThrow();
      }
    });
  });

  describe('key rotation', () => {
    it('still decrypts values written under an older key', () => {
      const old = new EncryptionService(configWith({ V1: KEY_V1 }, 'V1'));
      const ciphertext = old.encrypt('written-under-v1');

      // V2 is now active, but V1 remains configured for reading.
      const rotated = new EncryptionService(configWith({ V1: KEY_V1, V2: KEY_V2 }, 'V2'));
      expect(rotated.decrypt(ciphertext)).toBe('written-under-v1');
      expect(rotated.encrypt('new').startsWith('V2:')).toBe(true);
    });

    it('flags values that need re-encryption under the active key', () => {
      const old = new EncryptionService(configWith({ V1: KEY_V1 }, 'V1'));
      const ciphertext = old.encrypt('stale');

      const rotated = new EncryptionService(configWith({ V1: KEY_V1, V2: KEY_V2 }, 'V2'));
      expect(rotated.needsRotation(ciphertext)).toBe(true);
      expect(rotated.needsRotation(rotated.encrypt('fresh'))).toBe(false);
    });

    it('fails loudly when the key a value was written under is gone', () => {
      const old = new EncryptionService(configWith({ V1: KEY_V1 }, 'V1'));
      const ciphertext = old.encrypt('orphaned');

      // Dropping a key before re-encrypting everything makes data unreadable.
      // Better to throw than to return nothing and look like an empty field.
      const missing = new EncryptionService(configWith({ V2: KEY_V2 }, 'V2'));
      expect(() => missing.decrypt(ciphertext)).toThrow(/No encryption key/);
    });
  });
});

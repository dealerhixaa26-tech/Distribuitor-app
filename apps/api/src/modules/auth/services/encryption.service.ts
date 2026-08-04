import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';

/**
 * Symmetric encryption for data that must be readable again — MFA secrets and
 * bank account numbers. Passwords are hashed, never encrypted; these are
 * different problems with different tools.
 *
 * AES-256-GCM is authenticated encryption: tampering with the ciphertext makes
 * decryption fail rather than silently returning altered plaintext, which
 * AES-CBC would.
 *
 * Ciphertext is stored as `v1:iv:authTag:data`. The version prefix is what
 * makes key rotation possible without a flag day — old values keep decrypting
 * with the key they were written under while new writes use the active key.
 */
@Injectable()
export class EncryptionService {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_BYTES = 12; // 96 bits, the GCM standard
  private static readonly SEPARATOR = ':';

  constructor(private readonly config: AppConfigService) {}

  /**
   * Derives a 32-byte key from the configured secret.
   *
   * SHA-256 rather than a KDF because the input is already a high-entropy
   * generated key, not a passphrase — this normalises its length, it is not a
   * password-strengthening step.
   */
  private keyFor(version: string): Buffer {
    const secret = this.config.encryption.keys[version];
    if (!secret) throw new Error(`No encryption key configured for version "${version}"`);
    return createHash('sha256').update(secret).digest();
  }

  encrypt(plaintext: string): string {
    const version = this.config.encryption.activeVersion;
    const iv = randomBytes(EncryptionService.IV_BYTES);
    const cipher = createCipheriv(EncryptionService.ALGORITHM, this.keyFor(version), iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      version,
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join(EncryptionService.SEPARATOR);
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split(EncryptionService.SEPARATOR);
    if (parts.length !== 4) throw new Error('Malformed ciphertext');

    const [version, ivB64, authTagB64, dataB64] = parts as [string, string, string, string];

    const decipher = createDecipheriv(
      EncryptionService.ALGORITHM,
      this.keyFor(version),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

    // Throws if the ciphertext or tag was tampered with — that is the point of
    // choosing an authenticated mode.
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True when a value was encrypted under a key that is no longer active. */
  needsRotation(ciphertext: string): boolean {
    const version = ciphertext.split(EncryptionService.SEPARATOR)[0];
    return version !== this.config.encryption.activeVersion;
  }
}

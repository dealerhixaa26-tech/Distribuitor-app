import { validateEnv } from './env.schema';

/**
 * Configuration is validated at boot so a misconfigured deploy fails
 * immediately and loudly. These tests assert the cross-field rules that would
 * otherwise only reveal themselves at the worst possible moment.
 */

// A checksum-valid placeholder GSTIN for Maharashtra (state code 27).
const VALID_GSTIN = '27AAAAA0000A1Z2';

const baseEnv = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  REDIS_URL: 'redis://localhost:6379/0',
  JWT_SECRET: 'a'.repeat(40),
  CSRF_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY_V1: 'c'.repeat(40),
  COMPANY_GSTIN: VALID_GSTIN,
  COMPANY_PAN: 'AAAAA0000A',
  COMPANY_STATE_CODE: '27',
  COMPANY_ADDRESS: 'Nagpur, Maharashtra',
  COMPANY_EMAIL: 'info@hixaa.com',
  COMPANY_PHONE: '+91-9372429144',
};

describe('environment validation', () => {
  it('accepts a well-formed development configuration', () => {
    const env = validateEnv({ ...baseEnv });
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('lists every offending variable by name rather than throwing a stack trace', () => {
    // An operator restarting a container at midnight needs variable names.
    expect(() => validateEnv({ ...baseEnv, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('rejects a secret that is too short to be safe', () => {
    expect(() => validateEnv({ ...baseEnv, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects a GSTIN whose check digit is wrong', () => {
    // Reuses the same validator distributor GSTINs are held to.
    expect(() => validateEnv({ ...baseEnv, COMPANY_GSTIN: '27AAAAA0000A1Z9' })).toThrow(
      /COMPANY_GSTIN/,
    );
  });

  it('rejects a state code that disagrees with the GSTIN', () => {
    // This mismatch would produce a wrong CGST/SGST vs IGST split on every
    // invoice the company ever issues.
    expect(() => validateEnv({ ...baseEnv, COMPANY_STATE_CODE: '29' })).toThrow(
      /COMPANY_STATE_CODE/,
    );
  });

  describe('production guardrails', () => {
    const productionEnv = {
      ...baseEnv,
      NODE_ENV: 'production',
      APP_URL: 'https://dms.hixaa.com',
      API_URL: 'https://dms.hixaa.com/api',
      CORS_ORIGINS: 'https://dms.hixaa.com',
      FEATURE_SWAGGER: 'false',
      MAIL_BUSINESS_DRIVER: 'log',
    };

    it('accepts a well-formed production configuration', () => {
      expect(() => validateEnv({ ...productionEnv })).not.toThrow();
    });

    it('refuses to expose Swagger in production', () => {
      expect(() => validateEnv({ ...productionEnv, FEATURE_SWAGGER: 'true' })).toThrow(
        /FEATURE_SWAGGER/,
      );
    });

    it('refuses placeholder secrets in production', () => {
      expect(() =>
        validateEnv({ ...productionEnv, JWT_SECRET: `CHANGE_ME_${'x'.repeat(30)}` }),
      ).toThrow(/JWT_SECRET/);
    });

    it('refuses localhost as an allowed CORS origin in production', () => {
      expect(() =>
        validateEnv({ ...productionEnv, CORS_ORIGINS: 'https://dms.hixaa.com,http://localhost:3000' }),
      ).toThrow(/CORS_ORIGINS/);
    });

    it('refuses a plain-http app URL in production', () => {
      expect(() => validateEnv({ ...productionEnv, APP_URL: 'http://dms.hixaa.com' })).toThrow(
        /APP_URL/,
      );
    });

    it('requires business SMTP credentials when the smtp driver is selected', () => {
      expect(() =>
        validateEnv({ ...productionEnv, MAIL_BUSINESS_DRIVER: 'smtp', MAIL_BUSINESS_PASSWORD: '' }),
      ).toThrow(/MAIL_BUSINESS_PASSWORD/);
    });
  });

  describe('conditional requirements', () => {
    it('requires S3 settings only when the s3 driver is selected', () => {
      expect(() => validateEnv({ ...baseEnv, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
      expect(() => validateEnv({ ...baseEnv, STORAGE_DRIVER: 'local' })).not.toThrow();
    });

    it('requires Google credentials only when Sheets backup is enabled', () => {
      expect(() => validateEnv({ ...baseEnv, SHEETS_ENABLED: 'true' })).toThrow(
        /SHEETS_SERVICE_ACCOUNT_EMAIL/,
      );
      expect(() => validateEnv({ ...baseEnv, SHEETS_ENABLED: 'false' })).not.toThrow();
    });

    it('requires a ClamAV host only when the clamav scanner is selected', () => {
      expect(() => validateEnv({ ...baseEnv, VIRUS_SCAN_DRIVER: 'clamav' })).toThrow(/CLAMAV_HOST/);
    });
  });
});

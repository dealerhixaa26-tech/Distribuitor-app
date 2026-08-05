import { emailSchema, gstinSchema, panSchema } from '@hixaa/contracts';
import { z } from 'zod';

/**
 * Environment contract, validated at boot.
 *
 * A missing or malformed value crashes the process immediately with a readable
 * message naming the variable. It never surfaces as `undefined` inside a
 * request three days later. See docs/11-environment-variables.md.
 *
 * Validators are reused from @hixaa/contracts so the company's own GSTIN is
 * held to exactly the same standard as a distributor's.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .describe('boolean');

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

/** Duration strings accepted by @nestjs/jwt, e.g. `15m`, `7d`. */
const duration = z.string().regex(/^\d+[smhd]$/, 'Must look like 15m, 24h, or 7d');

/** Secrets short enough to brute force are a boot-time failure, not a warning. */
const secret = (min = 32) =>
  z.string().min(min, `Must be at least ${min} characters — generate with: openssl rand -base64 48`);

export const envSchema = z
  .object({
    // ── Core ────────────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('Hixaa DMS'),
    APP_URL: z.string().url(),
    API_URL: z.string().url(),
    API_PORT: port.default(4000),
    API_PREFIX: z.string().default('api/v1'),
    TZ: z.string().default('Asia/Kolkata'),
    // 'silent' exists for the test environment — a passing suite should not
    // print thousands of log lines.
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),

    // ── Database ────────────────────────────────────────────────────────────
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    DATABASE_READ_URL: z.string().url().optional(),
    DATABASE_POOL_SIZE: positiveInt.default(20),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInt.default(30_000),
    DATABASE_SLOW_QUERY_MS: positiveInt.default(200),

    // ── Redis & queues ──────────────────────────────────────────────────────
    REDIS_URL: z.string().url().startsWith('redis'),
    QUEUE_PREFIX: z.string().default('hixaa'),
    QUEUE_CONCURRENCY: positiveInt.default(5),
    /// Waiting-job count above which a queue backlog raises an ops alert. A
    /// setting rather than a constant because the right number depends on how
    /// much this deployment actually pushes through the queues.
    QUEUE_DEPTH_ALERT_THRESHOLD: positiveInt.default(500),
    WORKER_ENABLED: bool.default('true'),
    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(1000),
    OUTBOX_BATCH_SIZE: positiveInt.default(50),

    // ── Authentication ──────────────────────────────────────────────────────
    JWT_SECRET: secret(32),
    JWT_ACCESS_TTL: duration.default('15m'),
    JWT_REFRESH_TTL: duration.default('7d'),
    JWT_REFRESH_TTL_REMEMBER_ME: duration.default('30d'),
    JWT_ISSUER: z.string().default('hixaa-dms'),
    SESSION_COOKIE_NAME: z.string().default('hixaa_rt'),
    SESSION_COOKIE_DOMAIN: z.string().default('localhost'),
    CSRF_SECRET: secret(32),
    ENCRYPTION_KEY_V1: secret(32),
    ENCRYPTION_KEY_ACTIVE: z.string().default('V1'),
    ARGON2_MEMORY_COST: positiveInt.default(65_536),
    ARGON2_TIME_COST: positiveInt.default(3),
    ARGON2_PARALLELISM: positiveInt.default(4),
    PASSWORD_MIN_LENGTH: positiveInt.default(12),
    LOGIN_MAX_ATTEMPTS: positiveInt.default(5),
    LOGIN_LOCKOUT_MINUTES: positiveInt.default(15),
    MFA_ISSUER: z.string().default('Hixaa DMS'),

    // ── Business email (Hostinger) — customer-facing only ───────────────────
    MAIL_BUSINESS_DRIVER: z.enum(['smtp', 'log']).default('smtp'),
    MAIL_BUSINESS_HOST: z.string().default('smtp.hostinger.com'),
    MAIL_BUSINESS_PORT: port.default(465),
    MAIL_BUSINESS_SECURE: bool.default('true'),
    MAIL_BUSINESS_USER: z.string().default(''),
    MAIL_BUSINESS_PASSWORD: z.string().default(''),
    MAIL_BUSINESS_FROM_NAME: z.string().default('Hixaa Technologies'),
    MAIL_BUSINESS_FROM_ADDRESS: emailSchema.default('noreply@hixaa.com'),
    MAIL_BUSINESS_REPLY_TO: emailSchema.default('info@hixaa.com'),

    // ── Ops email (Gmail) — developer/infrastructure only ───────────────────
    MAIL_OPS_DRIVER: z.enum(['smtp', 'log']).default('smtp'),
    MAIL_OPS_HOST: z.string().default('smtp.gmail.com'),
    MAIL_OPS_PORT: port.default(587),
    MAIL_OPS_SECURE: bool.default('false'),
    MAIL_OPS_USER: z.string().default(''),
    MAIL_OPS_PASSWORD: z.string().default(''),
    MAIL_OPS_FROM_ADDRESS: z.string().default(''),
    MAIL_OPS_TO: z.string().default(''),

    // ── Storage ─────────────────────────────────────────────────────────────
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage/uploads'),
    STORAGE_SIGNED_URL_TTL: positiveInt.default(900),
    UPLOAD_MAX_SIZE_MB: positiveInt.default(10),
    UPLOAD_MAX_SIZE_DRAWING_MB: positiveInt.default(50),
    VIRUS_SCAN_DRIVER: z.enum(['noop', 'clamav']).default('noop'),
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: port.optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // ── Google Sheets backup ────────────────────────────────────────────────
    SHEETS_ENABLED: bool.default('false'),
    SHEETS_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
    SHEETS_PRIVATE_KEY: z.string().default(''),
    SHEETS_SPREADSHEET_ID_PRIMARY: z.string().default(''),
    SHEETS_SPREADSHEET_ID_TRANSACTIONS: z.string().default(''),
    SHEETS_SYNC_CRON: z.string().default('0 2 * * *'),
    SHEETS_BATCH_SIZE: positiveInt.default(1000),
    SHEETS_MAX_REQUESTS_PER_MINUTE: positiveInt.default(250),

    // ── Search, cache, throttling ───────────────────────────────────────────
    SEARCH_DRIVER: z.enum(['postgres', 'meilisearch']).default('postgres'),
    CACHE_TTL_DEFAULT: nonNegativeInt.default(300),
    CACHE_TTL_DASHBOARD: nonNegativeInt.default(300),
    CACHE_TTL_REFERENCE: nonNegativeInt.default(3600),
    THROTTLE_TTL: positiveInt.default(60),
    THROTTLE_LIMIT: positiveInt.default(300),
    THROTTLE_AUTH_LIMIT: positiveInt.default(5),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),

    // ── Business configuration (bootstrap values) ───────────────────────────
    COMPANY_LEGAL_NAME: z.string().default('Hixaa Technologies Pvt. Ltd.'),
    COMPANY_TRADE_NAME: z.string().default('HIXAA'),
    COMPANY_GSTIN: gstinSchema,
    COMPANY_PAN: panSchema,
    COMPANY_STATE_CODE: z.string().length(2),
    COMPANY_ADDRESS: z.string(),
    COMPANY_EMAIL: emailSchema,
    COMPANY_PHONE: z.string(),
    DEFAULT_CURRENCY: z.string().length(3).default('INR'),
    FINANCIAL_YEAR_START_MONTH: z.coerce.number().int().min(1).max(12).default(4),
    INVOICE_NUMBER_PREFIX: z.string().default('HTPL/INV'),
    ORDER_NUMBER_PREFIX: z.string().default('SO'),

    // ── Feature flags ───────────────────────────────────────────────────────
    FEATURE_MFA_ENABLED: bool.default('false'),
    FEATURE_SECONDARY_SALES: bool.default('true'),
    FEATURE_EINVOICE: bool.default('false'),
    FEATURE_SHEETS_BACKUP: bool.default('false'),
    FEATURE_SWAGGER: bool.default('true'),

    // ── Bootstrap ───────────────────────────────────────────────────────────
    SEED_SUPER_ADMIN_EMAIL: emailSchema.optional(),
    SEED_SUPER_ADMIN_PASSWORD: z.string().optional(),
  })
  // Cross-field rules. These are the misconfigurations that would otherwise
  // only reveal themselves at the worst possible moment.
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (env.NODE_ENV === 'production') {
      if (env.FEATURE_SWAGGER) {
        fail('FEATURE_SWAGGER', 'Swagger must be disabled in production (docs/06-security.md A05)');
      }
      if (env.JWT_SECRET.includes('CHANGE_ME')) {
        fail('JWT_SECRET', 'The placeholder secret cannot be used in production');
      }
      if (env.CSRF_SECRET.includes('CHANGE_ME')) {
        fail('CSRF_SECRET', 'The placeholder secret cannot be used in production');
      }
      if (env.ENCRYPTION_KEY_V1.includes('CHANGE_ME')) {
        fail('ENCRYPTION_KEY_V1', 'The placeholder key cannot be used in production');
      }
      if (env.MAIL_BUSINESS_DRIVER === 'smtp' && !env.MAIL_BUSINESS_PASSWORD) {
        fail('MAIL_BUSINESS_PASSWORD', 'Business SMTP credentials are required in production');
      }
      /*
       * ADR-0022. A production deployment with no ops recipient is a system
       * that cannot tell you anything is wrong: queue backlogs, dead letters,
       * failed backups, health-check failures and token-reuse alerts all route
       * here. Every one of them would be recorded as UNDELIVERABLE and read by
       * nobody.
       *
       * This refuses at BOOT, in the manner of the ClamAV and S3 drivers, so
       * the misconfiguration surfaces when it is introduced rather than during
       * the incident it was supposed to warn about.
       */
      if (!env.MAIL_OPS_TO) {
        fail('MAIL_OPS_TO', 'An ops alert recipient is required in production (ADR-0022)');
      }
      if (env.MAIL_OPS_DRIVER === 'smtp' && !env.MAIL_OPS_PASSWORD) {
        fail('MAIL_OPS_PASSWORD', 'Ops SMTP credentials are required in production');
      }
      if (env.CORS_ORIGINS.some((o) => o.includes('localhost'))) {
        fail('CORS_ORIGINS', 'localhost must not be an allowed origin in production');
      }
      if (env.APP_URL.startsWith('http://')) {
        fail('APP_URL', 'Production URLs must be https');
      }
    }

    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
        if (!env[key as keyof typeof env]) fail(key, `Required when STORAGE_DRIVER is "s3"`);
      }
    }

    if (env.VIRUS_SCAN_DRIVER === 'clamav' && !env.CLAMAV_HOST) {
      fail('CLAMAV_HOST', 'Required when VIRUS_SCAN_DRIVER is "clamav"');
    }

    if (env.SHEETS_ENABLED) {
      if (!env.SHEETS_SERVICE_ACCOUNT_EMAIL) {
        fail('SHEETS_SERVICE_ACCOUNT_EMAIL', 'Required when SHEETS_ENABLED is true');
      }
      if (!env.SHEETS_PRIVATE_KEY) {
        fail('SHEETS_PRIVATE_KEY', 'Required when SHEETS_ENABLED is true');
      }
      if (!env.SHEETS_SPREADSHEET_ID_PRIMARY) {
        fail('SHEETS_SPREADSHEET_ID_PRIMARY', 'Required when SHEETS_ENABLED is true');
      }
    }

    // The company's GSTIN encodes its state; a mismatch would produce wrong
    // CGST/SGST vs IGST splits on every invoice.
    if (env.COMPANY_GSTIN.slice(0, 2) !== env.COMPANY_STATE_CODE) {
      fail(
        'COMPANY_STATE_CODE',
        `Must match the first two characters of COMPANY_GSTIN ("${env.COMPANY_GSTIN.slice(0, 2)}") — ` +
          'this drives the place-of-supply tax split',
      );
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates process.env, or exits with a readable report.
 *
 * Nest's default behaviour on a config error is a stack trace; a operator
 * restarting a container at midnight needs a list of variable names instead.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  ✗ ${name}: ${issue.message}`;
    });

    throw new Error(
      [
        '',
        '─────────────────────────────────────────────────────────────',
        ' Invalid environment configuration — refusing to start.',
        '─────────────────────────────────────────────────────────────',
        ...lines,
        '',
        ' See .env.example and docs/11-environment-variables.md',
        '─────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
  }

  return result.data;
}

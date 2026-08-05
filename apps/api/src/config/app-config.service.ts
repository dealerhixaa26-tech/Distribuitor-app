import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed, grouped access to configuration.
 *
 * Services depend on this rather than on raw `ConfigService.get('SOME_KEY')`,
 * so a renamed variable is a compile error in one file instead of a runtime
 * `undefined` scattered across the codebase.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
  get isDevelopment(): boolean {
    return this.get('NODE_ENV') === 'development';
  }
  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  get app() {
    return {
      name: this.get('APP_NAME'),
      env: this.get('NODE_ENV'),
      url: this.get('APP_URL'),
      apiUrl: this.get('API_URL'),
      port: this.get('API_PORT'),
      prefix: this.get('API_PREFIX'),
      timezone: this.get('TZ'),
      logLevel: this.get('LOG_LEVEL'),
      corsOrigins: this.get('CORS_ORIGINS'),
    };
  }

  get database() {
    return {
      url: this.get('DATABASE_URL'),
      readUrl: this.get('DATABASE_READ_URL') ?? this.get('DATABASE_URL'),
      poolSize: this.get('DATABASE_POOL_SIZE'),
      statementTimeoutMs: this.get('DATABASE_STATEMENT_TIMEOUT_MS'),
      slowQueryMs: this.get('DATABASE_SLOW_QUERY_MS'),
    };
  }

  get redis() {
    return { url: this.get('REDIS_URL') };
  }

  get queue() {
    return {
      prefix: this.get('QUEUE_PREFIX'),
      concurrency: this.get('QUEUE_CONCURRENCY'),
      workerEnabled: this.get('WORKER_ENABLED'),
      depthAlertThreshold: this.get('QUEUE_DEPTH_ALERT_THRESHOLD'),
    };
  }

  get outbox() {
    return {
      pollIntervalMs: this.get('OUTBOX_POLL_INTERVAL_MS'),
      batchSize: this.get('OUTBOX_BATCH_SIZE'),
    };
  }

  get auth() {
    return {
      jwtSecret: this.get('JWT_SECRET'),
      accessTtl: this.get('JWT_ACCESS_TTL'),
      refreshTtl: this.get('JWT_REFRESH_TTL'),
      refreshTtlRememberMe: this.get('JWT_REFRESH_TTL_REMEMBER_ME'),
      issuer: this.get('JWT_ISSUER'),
      cookieName: this.get('SESSION_COOKIE_NAME'),
      cookieDomain: this.get('SESSION_COOKIE_DOMAIN'),
      csrfSecret: this.get('CSRF_SECRET'),
      passwordMinLength: this.get('PASSWORD_MIN_LENGTH'),
      maxLoginAttempts: this.get('LOGIN_MAX_ATTEMPTS'),
      lockoutMinutes: this.get('LOGIN_LOCKOUT_MINUTES'),
      mfaIssuer: this.get('MFA_ISSUER'),
      argon2: {
        memoryCost: this.get('ARGON2_MEMORY_COST'),
        timeCost: this.get('ARGON2_TIME_COST'),
        parallelism: this.get('ARGON2_PARALLELISM'),
      },
    };
  }

  get encryption() {
    return {
      activeVersion: this.get('ENCRYPTION_KEY_ACTIVE'),
      keys: { V1: this.get('ENCRYPTION_KEY_V1') } as Record<string, string>,
    };
  }

  /**
   * Business mail — Hostinger. Distributors and customers only.
   * Never used for deployment, backup, or monitoring notifications.
   */
  get mailBusiness() {
    return {
      driver: this.get('MAIL_BUSINESS_DRIVER'),
      host: this.get('MAIL_BUSINESS_HOST'),
      port: this.get('MAIL_BUSINESS_PORT'),
      secure: this.get('MAIL_BUSINESS_SECURE'),
      user: this.get('MAIL_BUSINESS_USER'),
      password: this.get('MAIL_BUSINESS_PASSWORD'),
      fromName: this.get('MAIL_BUSINESS_FROM_NAME'),
      fromAddress: this.get('MAIL_BUSINESS_FROM_ADDRESS'),
      replyTo: this.get('MAIL_BUSINESS_REPLY_TO'),
    };
  }

  /**
   * Ops mail — Gmail. The operator only.
   * Never used for customer-facing communication.
   */
  get mailOps() {
    return {
      driver: this.get('MAIL_OPS_DRIVER'),
      host: this.get('MAIL_OPS_HOST'),
      port: this.get('MAIL_OPS_PORT'),
      secure: this.get('MAIL_OPS_SECURE'),
      user: this.get('MAIL_OPS_USER'),
      password: this.get('MAIL_OPS_PASSWORD'),
      fromAddress: this.get('MAIL_OPS_FROM_ADDRESS'),
      to: this.get('MAIL_OPS_TO'),
    };
  }

  get storage() {
    return {
      driver: this.get('STORAGE_DRIVER'),
      localPath: this.get('STORAGE_LOCAL_PATH'),
      signedUrlTtl: this.get('STORAGE_SIGNED_URL_TTL'),
      maxSizeMb: this.get('UPLOAD_MAX_SIZE_MB'),
      maxSizeDrawingMb: this.get('UPLOAD_MAX_SIZE_DRAWING_MB'),
      virusScanDriver: this.get('VIRUS_SCAN_DRIVER'),
      clamav: { host: this.get('CLAMAV_HOST'), port: this.get('CLAMAV_PORT') },
      s3: {
        endpoint: this.get('S3_ENDPOINT'),
        region: this.get('S3_REGION'),
        bucket: this.get('S3_BUCKET'),
        accessKeyId: this.get('S3_ACCESS_KEY_ID'),
        secretAccessKey: this.get('S3_SECRET_ACCESS_KEY'),
      },
    };
  }

  get sheets() {
    return {
      enabled: this.get('SHEETS_ENABLED'),
      serviceAccountEmail: this.get('SHEETS_SERVICE_ACCOUNT_EMAIL'),
      privateKey: this.get('SHEETS_PRIVATE_KEY'),
      spreadsheetIdPrimary: this.get('SHEETS_SPREADSHEET_ID_PRIMARY'),
      spreadsheetIdTransactions: this.get('SHEETS_SPREADSHEET_ID_TRANSACTIONS'),
      cron: this.get('SHEETS_SYNC_CRON'),
      batchSize: this.get('SHEETS_BATCH_SIZE'),
      maxRequestsPerMinute: this.get('SHEETS_MAX_REQUESTS_PER_MINUTE'),
    };
  }

  get cache() {
    return {
      defaultTtl: this.get('CACHE_TTL_DEFAULT'),
      dashboardTtl: this.get('CACHE_TTL_DASHBOARD'),
      referenceTtl: this.get('CACHE_TTL_REFERENCE'),
    };
  }

  get throttle() {
    return {
      ttl: this.get('THROTTLE_TTL'),
      limit: this.get('THROTTLE_LIMIT'),
      authLimit: this.get('THROTTLE_AUTH_LIMIT'),
    };
  }

  /** Bootstrap values only — SystemSetting is authoritative once seeded. */
  get company() {
    return {
      legalName: this.get('COMPANY_LEGAL_NAME'),
      tradeName: this.get('COMPANY_TRADE_NAME'),
      gstin: this.get('COMPANY_GSTIN'),
      pan: this.get('COMPANY_PAN'),
      stateCode: this.get('COMPANY_STATE_CODE'),
      address: this.get('COMPANY_ADDRESS'),
      email: this.get('COMPANY_EMAIL'),
      phone: this.get('COMPANY_PHONE'),
      currency: this.get('DEFAULT_CURRENCY'),
      financialYearStartMonth: this.get('FINANCIAL_YEAR_START_MONTH'),
      invoicePrefix: this.get('INVOICE_NUMBER_PREFIX'),
      orderPrefix: this.get('ORDER_NUMBER_PREFIX'),
    };
  }

  get features() {
    return {
      mfa: this.get('FEATURE_MFA_ENABLED'),
      secondarySales: this.get('FEATURE_SECONDARY_SALES'),
      eInvoice: this.get('FEATURE_EINVOICE'),
      sheetsBackup: this.get('FEATURE_SHEETS_BACKUP'),
      swagger: this.get('FEATURE_SWAGGER'),
    };
  }

  get bootstrap() {
    return {
      superAdminEmail: this.get('SEED_SUPER_ADMIN_EMAIL'),
      superAdminPassword: this.get('SEED_SUPER_ADMIN_PASSWORD'),
    };
  }
}

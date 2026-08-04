import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './guards/csrf.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { AccessService } from './services/access.service';
import { EncryptionService } from './services/encryption.service';
import { PasswordService } from './services/password.service';
import { SessionService } from './services/session.service';
import { TokenService, parseDuration } from './services/token.service';

/**
 * Authentication and authorization.
 *
 * Global because the guards and `AccessService` are needed by every module.
 *
 * Guard order is significant and set by registration order:
 *   1. JwtAuthGuard      — who is this? (deny-by-default)
 *   2. CsrfGuard         — is this a genuine same-site request?
 *   3. PermissionsGuard  — may they do this?
 *
 * Scope — *on which records* — is enforced separately, at the repository layer
 * by the Prisma extension. A guard protects endpoints; only the query filter
 * protects rows. See ADR-0003.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.auth.jwtSecret,
        signOptions: {
          expiresIn: parseDuration(config.auth.accessTtl),
          issuer: config.auth.issuer,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    AccessService,
    EncryptionService,

    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthService, PasswordService, TokenService, SessionService, AccessService, EncryptionService],
})
export class AuthModule {}

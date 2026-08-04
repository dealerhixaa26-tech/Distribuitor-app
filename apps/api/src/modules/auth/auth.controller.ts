import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  acceptInviteSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type AcceptInviteDto,
  type ChangePasswordDto,
  type ForgotPasswordDto,
  type LoginDto,
  type ResetPasswordDto,
} from '@hixaa/contracts';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { UnauthenticatedError } from '../../common/errors/domain.error';
import { AppConfigService } from '../../config/app-config.service';
import { AuthService, type AuthResult } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { CSRF_COOKIE, CsrfGuard } from './guards/csrf.guard';
import type { AuthenticatedUser } from './guards/jwt-auth.guard';
import { SessionService } from './services/session.service';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly config: AppConfigService,
  ) {}

  // ── Login ─────────────────────────────────────────────────────────────────

  @Public()
  // Far stricter than the global limit: credential stuffing is the
  // highest-volume attack this endpoint will actually see.
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  async login(
    @Body(zodBody(loginSchema)) dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(dto, sessionContext(request));
    this.applyAuthCookies(response, result);
    return result.response;
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 900_000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and mint a new access token' })
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = request.cookies?.[this.config.auth.cookieName] as string | undefined;
    if (!token) throw new UnauthenticatedError('No refresh token present');

    try {
      const result = await this.auth.refresh(token, sessionContext(request));
      this.applyAuthCookies(response, result);
      return result.response;
    } catch (error) {
      // On any refresh failure — expiry, revocation, or reuse detection —
      // clear the cookies so the browser stops replaying a dead token.
      this.clearAuthCookies(response);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of the current session' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(user.sessionId, user.id);
    this.clearAuthCookies(response);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out of every session on every device' })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const revoked = await this.auth.logoutAll(user.id);
    this.clearAuthCookies(response);
    return { revoked };
  }

  // ── Password lifecycle ────────────────────────────────────────────────────

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Always returns 204, whether or not the address exists — reporting otherwise would ' +
      'make this endpoint an email enumeration oracle.',
  })
  async forgotPassword(
    @Body(zodBody(forgotPasswordSchema)) dto: ForgotPasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.auth.requestPasswordReset(dto.email, sessionContext(request));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  async resetPassword(
    @Body(zodBody(resetPasswordSchema)) dto: ResetPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.resetPassword(dto, sessionContext(request));
    // Every session was revoked, so the browser's cookies are now dead.
    this.clearAuthCookies(response);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change your own password' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(changePasswordSchema)) dto: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.auth.changePassword(user.id, user.sessionId, dto, sessionContext(request));
  }

  // ── Verification & invitations ────────────────────────────────────────────

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm an email address' })
  async verifyEmail(@Body(zodBody(verifyEmailSchema)) dto: { token: string }): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post('accept-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation and set a password' })
  async acceptInvite(
    @Body(zodBody(acceptInviteSchema)) dto: AcceptInviteDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.acceptInvite(dto, sessionContext(request));
    this.applyAuthCookies(response, result);
    return result.response;
  }

  // ── Session management ────────────────────────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user with effective permissions and scope' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.currentUser(user.id);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions across devices' })
  async listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.listForUser(user.id, user.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one session' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
  ): Promise<void> {
    // Scoped to the caller's own sessions: without this filter, any user could
    // revoke anyone else's session by guessing an id.
    const owned = await this.sessions.listForUser(user.id);
    if (!owned.some((session) => session.id === sessionId)) return;
    await this.sessions.revoke(sessionId, 'REVOKED_BY_USER');
  }

  // ── Cookies ───────────────────────────────────────────────────────────────

  /**
   * Sets the refresh and CSRF cookies.
   *
   * The refresh cookie is HTTP-only, so JavaScript cannot read it and an XSS
   * payload cannot exfiltrate the session. The CSRF cookie deliberately IS
   * readable — the double-submit pattern requires the client to echo it in a
   * header, which a cross-origin attacker cannot do. See CsrfGuard.
   */
  private applyAuthCookies(response: Response, result: AuthResult): void {
    const secure = this.config.isProduction;
    const maxAge = result.refreshExpiresAt.getTime() - Date.now();

    response.cookie(this.config.auth.cookieName, result.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      // Scoped to the auth routes: the refresh token is never transmitted on
      // an ordinary API call, so it is exposed on far fewer requests.
      path: `/${this.config.app.prefix}/auth`,
      maxAge,
      ...(this.config.isProduction ? { domain: this.config.auth.cookieDomain } : {}),
    });

    response.cookie(
      CSRF_COOKIE,
      CsrfGuard.issue(this.config.auth.csrfSecret, randomBytes(24).toString('base64url')),
      {
        httpOnly: false, // must be readable — that is the mechanism
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge,
      },
    );
  }

  private clearAuthCookies(response: Response): void {
    response.clearCookie(this.config.auth.cookieName, {
      path: `/${this.config.app.prefix}/auth`,
    });
    response.clearCookie(CSRF_COOKIE, { path: '/' });
  }
}

function sessionContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  };
}

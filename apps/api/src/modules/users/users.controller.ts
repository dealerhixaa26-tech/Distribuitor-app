import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  inviteUserSchema,
  listUsersQuerySchema,
  roleAssignmentSchema,
  suspendUserSchema,
  updateProfileSchema,
  updateUserSchema,
  uuidSchema,
  type InviteUserDto,
  type ListUsersQuery,
  type RoleAssignmentDto,
  type UpdateUserDto,
} from '@hixaa/contracts';
import { z } from 'zod';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import type { AuthenticatedUser } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';

const setRolesSchema = z.object({ roles: z.array(roleAssignmentSchema) });

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Own profile. Deliberately before `:id` — Nest matches routes in
   * declaration order, and `/users/me` would otherwise be captured as an id.
   */
  @Get('me')
  @ApiOperation({ summary: 'Your own profile' })
  async me(@CurrentUser('id') userId: string) {
    return this.users.findById(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update your own profile' })
  async updateMe(
    @CurrentUser('id') userId: string,
    @Body(zodBody(updateProfileSchema)) dto: UpdateUserDto,
  ) {
    // No permission required: every user may edit their own name and phone.
    // Roles and status are not part of this DTO, so privilege cannot be
    // self-escalated through it.
    return this.users.update(userId, dto, userId);
  }

  @Get()
  @RequirePermission(PERMISSIONS.USER_READ)
  @ApiOperation({ summary: 'List users' })
  async list(@Query(zodQuery(listUsersQuerySchema)) query: ListUsersQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.USER_READ)
  @ApiOperation({ summary: 'Get one user' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.users.findById(id);
  }

  @Post('invite')
  @RequirePermission(PERMISSIONS.USER_CREATE)
  @ApiOperation({
    summary: 'Invite a user',
    description:
      'Creates an INVITED account and emails an invitation. No password is set — the ' +
      'invitee chooses their own, so a temporary credential never exists to be intercepted.',
  })
  async invite(
    @Body(zodBody(inviteUserSchema)) dto: InviteUserDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.users.invite(dto, actorId);
  }

  @Post(':id/resend-invite')
  @RequirePermission(PERMISSIONS.USER_CREATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Re-send an invitation' })
  async resendInvite(@Param('id', zodParam(uuidSchema)) id: string): Promise<void> {
    await this.users.resendInvite(id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.USER_UPDATE)
  @ApiOperation({ summary: 'Update a user' })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateUserSchema)) dto: UpdateUserDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.users.update(id, dto, actorId);
  }

  @Put(':id/roles')
  @RequirePermission(PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    summary: 'Replace a user’s role assignments',
    description:
      'Requires role:assign, which is deliberately separate from user:update — editing ' +
      'someone’s name and granting them permissions are different levels of authority.',
  })
  async setRoles(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(setRolesSchema)) dto: { roles: RoleAssignmentDto[] },
    @CurrentUser('id') actorId: string,
  ) {
    return this.users.setRoles(id, dto.roles, actorId);
  }

  @Post(':id/suspend')
  @RequirePermission(PERMISSIONS.USER_SUSPEND)
  @ApiOperation({ summary: 'Suspend a user and revoke their sessions' })
  async suspend(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(suspendUserSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.users.suspend(id, dto.reason, actorId);
  }

  @Post(':id/reactivate')
  @RequirePermission(PERMISSIONS.USER_SUSPEND)
  @ApiOperation({ summary: 'Reactivate a suspended user' })
  async reactivate(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.users.reactivate(id, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.USER_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a user' })
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.users.remove(id, user.id);
  }
}

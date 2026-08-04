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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  createRoleSchema,
  updateRoleSchema,
  uuidSchema,
  type CreateRoleDto,
  type UpdateRoleDto,
} from '@hixaa/contracts';
import { zodBody, zodParam } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RolesService } from './roles.service';

@ApiTags('Roles & Permissions')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ROLE_READ)
  @ApiOperation({ summary: 'List roles with their permission sets' })
  async list() {
    return this.roles.list();
  }

  /** Declared before `:id` so it is not captured as an identifier. */
  @Get('permissions')
  @RequirePermission(PERMISSIONS.ROLE_READ)
  @ApiOperation({ summary: 'The permission catalogue, grouped by resource' })
  async catalogue() {
    return this.roles.catalogue();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ROLE_READ)
  @ApiOperation({ summary: 'Get one role' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.roles.findById(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.ROLE_CREATE)
  @ApiOperation({
    summary: 'Create a custom role',
    description:
      'Rejected if the permission set combines a separated pair — recording a payment and ' +
      'verifying it, creating an order and approving it, or drafting an invoice and issuing it.',
  })
  async create(
    @Body(zodBody(createRoleSchema)) dto: CreateRoleDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.roles.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ROLE_UPDATE)
  @ApiOperation({ summary: 'Update a custom role' })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateRoleSchema)) dto: UpdateRoleDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.roles.update(id, dto, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.ROLE_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a custom role that nobody holds' })
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.roles.remove(id, actorId);
  }
}

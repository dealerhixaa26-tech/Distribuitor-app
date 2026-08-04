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
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  createTerritorySchema,
  moveTerritorySchema,
  updateTerritorySchema,
  uuidSchema,
  type CreateTerritoryDto,
  type UpdateTerritoryDto,
} from '@hixaa/contracts';
import { zodBody, zodParam } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { TerritoriesService } from './territories.service';

@ApiTags('Territories')
@Controller('territories')
export class TerritoriesController {
  constructor(private readonly territories: TerritoriesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TERRITORY_READ)
  @ApiOperation({
    summary: 'List territories (flat)',
    description:
      'Scoped automatically: a territory-scoped caller sees only their own subtree, ' +
      'enforced at the repository layer rather than by this controller.',
  })
  async list(@Query('includeInactive') includeInactive?: string) {
    return this.territories.list(includeInactive === 'true');
  }

  /** Declared before `:id` so it is not captured as an identifier. */
  @Get('tree')
  @RequirePermission(PERMISSIONS.TERRITORY_READ)
  @ApiOperation({ summary: 'List territories as a nested tree' })
  async tree(@Query('includeInactive') includeInactive?: string) {
    return this.territories.tree(includeInactive === 'true');
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TERRITORY_READ)
  @ApiOperation({ summary: 'Get one territory' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.territories.findById(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.TERRITORY_CREATE)
  @ApiOperation({ summary: 'Create a territory' })
  async create(
    @Body(zodBody(createTerritorySchema)) dto: CreateTerritoryDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.territories.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.TERRITORY_UPDATE)
  @ApiOperation({
    summary: 'Update a territory',
    description: 'Cannot reparent — use /move, which rewrites the whole subtree.',
  })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateTerritorySchema)) dto: UpdateTerritoryDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.territories.update(id, dto, actorId);
  }

  @Post(':id/move')
  @RequirePermission(PERMISSIONS.TERRITORY_UPDATE)
  @ApiOperation({
    summary: 'Move a territory subtree',
    description:
      'Rewrites the path and depth of every descendant in one transaction. Rejected if it ' +
      'would place a territory beneath its own descendant, which would create a cycle.',
  })
  async move(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(moveTerritorySchema)) dto: { parentId: string | null },
    @CurrentUser('id') actorId: string,
  ) {
    return this.territories.move(id, dto.parentId, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.TERRITORY_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a leaf territory' })
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.territories.remove(id, actorId);
  }
}

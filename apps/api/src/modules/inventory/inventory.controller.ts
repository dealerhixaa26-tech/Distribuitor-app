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
  createReservationSchema,
  createTransferSchema,
  createWarehouseSchema,
  goodsReceiptSchema,
  listBalancesQuerySchema,
  listLedgerQuerySchema,
  listReservationsQuerySchema,
  listSerialsQuerySchema,
  listWarehousesQuerySchema,
  openingBalanceSchema,
  receiveTransferSchema,
  stockAdjustmentSchema,
  stockIssueSchema,
  updateWarehouseSchema,
  upsertInventorySettingSchema,
  uuidSchema,
  type CreateReservationDto,
  type CreateTransferDto,
  type CreateWarehouseDto,
  type GoodsReceiptDto,
  type ListBalancesQuery,
  type ListLedgerQuery,
  type ListWarehousesQuery,
  type OpeningBalanceDto,
  type StockAdjustmentDto,
  type StockIssueDto,
  type UpdateWarehouseDto,
  type UpsertInventorySettingDto,
} from '@hixaa/contracts';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { InventorySettingsService } from './inventory-settings.service';
import { ReconciliationService } from './reconciliation.service';
import { ReservationsService } from './reservations.service';
import { SerialsService } from './serials.service';
import { StockService } from './stock.service';
import { WarehousesService } from './warehouses.service';

// ── Warehouses ──────────────────────────────────────────────────────────────

@ApiTags('Warehouses')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.WAREHOUSE_READ)
  @ApiOperation({
    summary: 'List warehouses',
    description:
      'Scoped by territory: a territory-scoped caller sees only their own, enforced at the ' +
      'repository layer.',
  })
  async list(@Query(zodQuery(listWarehousesQuerySchema)) query: ListWarehousesQuery) {
    return this.warehouses.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_READ)
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.warehouses.findById(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.WAREHOUSE_CREATE)
  @ApiOperation({
    summary: 'Create a warehouse',
    description:
      'A DISTRIBUTOR warehouse must name its owner and no other type may — mixing them up ' +
      'would count a partner’s stock as Hixaa’s own.',
  })
  async create(
    @Body(zodBody(createWarehouseSchema)) dto: CreateWarehouseDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.warehouses.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_UPDATE)
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateWarehouseSchema)) dto: UpdateWarehouseDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.warehouses.update(id, dto, actorId);
  }

  @Post(':id/set-default')
  @RequirePermission(PERMISSIONS.WAREHOUSE_UPDATE)
  async setDefault(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.warehouses.setDefault(id, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.WAREHOUSE_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a warehouse',
    description: 'Refused once it has movement history — the ledger must stay intact.',
  })
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.warehouses.remove(id, actorId);
  }
}

// ── Inventory ───────────────────────────────────────────────────────────────

@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly stock: StockService,
    private readonly reservations: ReservationsService,
    private readonly serials: SerialsService,
    private readonly settings: InventorySettingsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  @Get('balances')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({ summary: 'Stock balances — on hand, reserved, available, and value' })
  async balances(@Query(zodQuery(listBalancesQuerySchema)) query: ListBalancesQuery) {
    return this.stock.listBalances(query);
  }

  @Get('balances/product/:productId')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({ summary: 'One product’s stock across every visible warehouse' })
  async balancesForProduct(@Param('productId', zodParam(uuidSchema)) productId: string) {
    return this.stock.balancesForProduct(productId);
  }

  @Get('ledger')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary: 'The stock ledger — the audit trail',
    description:
      'Append-only and immutable: this is what answers "why is stock 47?" without guessing. ' +
      'Corrections appear as compensating ADJUSTMENT rows, never as edits.',
  })
  async ledger(@Query(zodQuery(listLedgerQuerySchema)) query: ListLedgerQuery) {
    return this.stock.listLedger(query);
  }

  @Get('low-stock')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({ summary: 'Products at or below their reorder level' })
  async lowStock(@Query('warehouseId') warehouseId?: string) {
    return this.stock.lowStock(warehouseId);
  }

  // ── Movements ─────────────────────────────────────────────────────────────

  @Post('receipts')
  @RequirePermission(PERMISSIONS.INVENTORY_RECEIVE)
  @ApiOperation({
    summary: 'Goods receipt',
    description:
      'Records quantity; serials are captured at dispatch (ADR-0009). A stated unitCost feeds ' +
      'the moving weighted average — omitted keeps the current average rather than defaulting ' +
      'to zero, which would understate inventory.',
  })
  async receive(
    @Body(zodBody(goodsReceiptSchema)) dto: GoodsReceiptDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stock.receive(dto, actorId);
  }

  @Post('issues')
  @RequirePermission(PERMISSIONS.INVENTORY_ISSUE)
  @ApiOperation({
    summary: 'Issue stock out of a warehouse',
    description:
      'A serial-tracked product requires exactly one serial per unit; a short list fails the ' +
      'whole issue rather than shipping units that cannot be traced back to a plant.',
  })
  async issue(
    @Body(zodBody(stockIssueSchema)) dto: StockIssueDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stock.issue(dto, actorId);
  }

  @Post('adjustments')
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  @ApiOperation({
    summary: 'Adjust stock, with a mandatory reason',
    description:
      'Its own permission because this is the only operation that creates or destroys stock ' +
      'without a physical event. Every adjustment is a SECURITY audit entry.',
  })
  async adjust(
    @Body(zodBody(stockAdjustmentSchema)) dto: StockAdjustmentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stock.adjust(dto, actorId);
  }

  @Post('opening-balances')
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  @ApiOperation({
    summary: 'Post opening balances in bulk',
    description:
      'Refused where a product already has movement history in that warehouse — an opening ' +
      'balance after trading has begun misrepresents when the stock arrived.',
  })
  async openingBalances(
    @Body(zodBody(openingBalanceSchema)) dto: OpeningBalanceDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stock.openingBalances(dto, actorId);
  }

  // ── Transfers ─────────────────────────────────────────────────────────────

  @Post('transfers')
  @RequirePermission(PERMISSIONS.INVENTORY_TRANSFER)
  async createTransfer(
    @Body(zodBody(createTransferSchema)) dto: CreateTransferDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stock.createTransfer(dto, actorId);
  }

  @Post('transfers/:id/dispatch')
  @RequirePermission(PERMISSIONS.INVENTORY_TRANSFER)
  @ApiOperation({
    summary: 'Dispatch a transfer (source → transit)',
    description:
      'Phase one of two. Stock rests in transit so it stays VISIBLE while moving, rather than ' +
      'vanishing for however long the journey takes.',
  })
  async dispatchTransfer(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.stock.dispatchTransfer(id, actorId);
  }

  @Post('transfers/:id/receive')
  @RequirePermission(PERMISSIONS.INVENTORY_TRANSFER)
  @ApiOperation({
    summary: 'Receive a transfer (transit → destination)',
    description: 'Short receipts are recorded rather than silently reconciled.',
  })
  async receiveTransfer(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(receiveTransferSchema))
    dto: { lines: Array<{ productId: string; quantityReceived: string }> },
    @CurrentUser('id') actorId: string,
  ) {
    return this.stock.receiveTransfer(id, dto.lines, actorId);
  }

  // ── Reservations ──────────────────────────────────────────────────────────

  @Get('reservations')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async listReservations(
    @Query(zodQuery(listReservationsQuerySchema))
    query: { warehouseId?: string; productId?: string; orderId?: string; status?: string; cursor?: string; limit: number; includeTotal: boolean },
  ) {
    return this.reservations.list(query as never);
  }

  @Post('reservations')
  @RequirePermission(PERMISSIONS.INVENTORY_ISSUE)
  @ApiOperation({
    summary: 'Reserve stock',
    description:
      'Does NOT move stock — the goods are still on the shelf, so no ledger row is written. ' +
      'Only `available` falls. Refused when insufficient is available, which is not the same ' +
      'as insufficient on hand.',
  })
  async reserve(
    @Body(zodBody(createReservationSchema)) dto: CreateReservationDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.reservations.reserve(dto, actorId);
  }

  @Post('reservations/:id/release')
  @RequirePermission(PERMISSIONS.INVENTORY_ISSUE)
  async release(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.reservations.release(id, actorId);
  }

  @Post('reservations/:id/consume')
  @RequirePermission(PERMISSIONS.INVENTORY_ISSUE)
  @ApiOperation({
    summary: 'Consume a reservation — the goods ship',
    description:
      'Releases the hold and posts the ISSUE movement in ONE transaction, so stock can never ' +
      'be decremented without its reservation being cleared, nor the reverse.',
  })
  async consume(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.reservations.consume(id, actorId);
  }

  // ── Serials ───────────────────────────────────────────────────────────────

  @Get('serials')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  async listSerials(
    @Query(zodQuery(listSerialsQuerySchema))
    query: { q?: string; productId?: string; distributorId?: string; status?: string; warrantyExpiringInDays?: number; cursor?: string; limit: number; includeTotal: boolean },
  ) {
    return this.serials.list(query);
  }

  /** Declared before `:serial` cannot capture it — this path is more specific. */
  @Get('serials/:serial')
  @RequirePermission(PERMISSIONS.INVENTORY_READ)
  @ApiOperation({
    summary: 'Trace a serial number',
    description:
      'The liability lookup. Given the serial printed on a device found in a plant: which ' +
      'distributor received it, when, and is it still under warranty?',
  })
  async traceSerial(@Param('serial') serial: string) {
    return this.serials.trace(serial);
  }

  // ── Reorder policy ────────────────────────────────────────────────────────

  @Put('settings')
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  @ApiOperation({ summary: 'Set the reorder policy for a product in a warehouse' })
  async upsertSetting(
    @Body(zodBody(upsertInventorySettingSchema)) dto: UpsertInventorySettingDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.settings.upsert(dto, actorId);
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  @Post('reconcile')
  @RequirePermission(PERMISSIONS.INVENTORY_COUNT)
  @ApiOperation({
    summary: 'Re-derive every balance from the ledger and report drift',
    description:
      'Runs nightly; this triggers it on demand. It REPORTS drift and never heals it — ' +
      'silently correcting would destroy the only evidence that a bug exists.',
  })
  async reconcile() {
    return this.reconciliation.reconcile();
  }
}

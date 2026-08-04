import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  approveOrderSchema,
  cancelOrderSchema,
  createCustomerContactSchema,
  createCustomerSchema,
  createOrderSchema,
  createQuotationSchema,
  createShipmentSchema,
  deliverShipmentSchema,
  dispatchShipmentSchema,
  listCustomersQuerySchema,
  listOrdersQuerySchema,
  listQuotationsQuerySchema,
  listShipmentsQuerySchema,
  rejectOrderSchema,
  rejectQuotationSchema,
  sendQuotationSchema,
  updateCustomerSchema,
  updateOrderSchema,
  updateQuotationSchema,
  uuidSchema,
  type ApproveOrderDto,
  type CreateCustomerContactDto,
  type CreateCustomerDto,
  type CreateOrderDto,
  type CreateQuotationDto,
  type CreateShipmentDto,
  type DispatchShipmentDto,
  type ListCustomersQuery,
  type ListOrdersQuery,
  type ListQuotationsQuery,
  type UpdateCustomerDto,
  type UpdateOrderDto,
  type UpdateQuotationDto,
} from '@hixaa/contracts';
import type { Response } from 'express';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CustomersService } from './customers.service';
import { OrdersService } from './orders.service';
import { QuotationPdfService } from './quotation-pdf.service';
import { QuotationsService } from './quotations.service';
import { ShipmentsService } from './shipments.service';

// ── Customers ───────────────────────────────────────────────────────────────

@ApiTags('Customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  @ApiOperation({
    summary: 'List end customers',
    description:
      'Territory-scoped. A Customer is an END customer — a plant, a mine, a government body — ' +
      'distinct from a Distributor, which is a channel partner.',
  })
  async list(@Query(zodQuery(listCustomersQuerySchema)) query: ListCustomersQuery) {
    return this.customers.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_READ)
  @ApiOperation({ summary: 'Customer detail — contacts, recent orders, installed base' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.customers.findDetail(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CUSTOMER_CREATE)
  async create(
    @Body(zodBody(createCustomerSchema)) dto: CreateCustomerDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.customers.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_UPDATE)
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateCustomerSchema)) dto: UpdateCustomerDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.customers.update(id, dto, actorId);
  }

  @Post(':id/contacts')
  @RequirePermission(PERMISSIONS.CUSTOMER_UPDATE)
  async addContact(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(createCustomerContactSchema)) dto: CreateCustomerContactDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.customers.addContact(id, dto, actorId);
  }

  @Delete(':id/contacts/:contactId')
  @RequirePermission(PERMISSIONS.CUSTOMER_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeContact(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('contactId', zodParam(uuidSchema)) contactId: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.customers.removeContact(id, contactId, actorId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.customers.remove(id, actorId);
  }
}

// ── Quotations ──────────────────────────────────────────────────────────────

@ApiTags('Quotations')
@Controller('quotations')
export class QuotationsController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly pdf: QuotationPdfService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.QUOTATION_READ)
  async list(@Query(zodQuery(listQuotationsQuerySchema)) query: ListQuotationsQuery) {
    return this.quotations.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.QUOTATION_READ)
  @ApiOperation({ summary: 'Quotation detail, with every revision in the group' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.quotations.findDetail(id);
  }

  /**
   * Synchronous download. Emailing goes through the outbox, but a person
   * clicking a button should not wait on a queue (ADR-0013 §4).
   */
  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.QUOTATION_READ)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({ summary: 'Download the quotation as a PDF' })
  async downloadPdf(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pdf.render(id);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Content-Length', buffer.length);
    response.end(buffer);
  }

  @Post()
  @RequirePermission(PERMISSIONS.QUOTATION_CREATE)
  @ApiOperation({
    summary: 'Create a quotation',
    description:
      'Lines carry only product and quantity — prices are resolved server-side by the pricing ' +
      'engine and snapshotted onto the line (ADR-0007, ADR-0011). A client cannot post a price.',
  })
  async create(
    @Body(zodBody(createQuotationSchema)) dto: CreateQuotationDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.quotations.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.QUOTATION_UPDATE)
  @ApiOperation({ summary: 'Edit a DRAFT quotation. A SENT one must be revised instead.' })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateQuotationSchema)) dto: UpdateQuotationDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.quotations.update(id, dto, actorId);
  }

  @Get(':id/reprice')
  @RequirePermission(PERMISSIONS.QUOTATION_READ)
  @ApiOperation({
    summary: 'What would this cost today?',
    description:
      'Re-runs the pricing engine and reports what moved. Deliberately does NOT write — ' +
      'silently adopting new numbers is what the snapshot design exists to prevent.',
  })
  async reprice(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.quotations.repricePreview(id, actorId);
  }

  @Post(':id/send')
  @RequirePermission(PERMISSIONS.QUOTATION_SEND)
  @ApiOperation({ summary: 'Send to the customer — the PDF is emailed by the worker' })
  async send(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(sendQuotationSchema)) dto: { to?: string[]; message?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.quotations.send(id, dto.to, dto.message, actorId);
  }

  @Post(':id/revise')
  @RequirePermission(PERMISSIONS.QUOTATION_UPDATE)
  @ApiOperation({
    summary: 'Supersede with a new revision',
    description:
      'The previous revision is kept exactly as it was — a customer may be holding it, and ' +
      'rewriting a document already in someone’s inbox is how disputes start.',
  })
  async revise(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateQuotationSchema)) dto: UpdateQuotationDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.quotations.revise(id, dto, actorId);
  }

  @Post(':id/accept')
  @RequirePermission(PERMISSIONS.QUOTATION_UPDATE)
  async accept(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.quotations.accept(id, actorId);
  }

  @Post(':id/reject')
  @RequirePermission(PERMISSIONS.QUOTATION_UPDATE)
  async reject(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(rejectQuotationSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.quotations.reject(id, dto.reason, actorId);
  }
}

// ── Orders ──────────────────────────────────────────────────────────────────

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ORDER_READ)
  async list(@Query(zodQuery(listOrdersQuerySchema)) query: ListOrdersQuery) {
    return this.orders.list(query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ORDER_READ)
  @ApiOperation({ summary: 'Order detail — lines, approvals, shipments, timeline' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.orders.findDetail(id);
  }

  @Get(':id/timeline')
  @RequirePermission(PERMISSIONS.ORDER_READ)
  async timeline(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.orders.timeline(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.ORDER_CREATE)
  @ApiOperation({
    summary: 'Create an order',
    description:
      'PRIMARY is sell-in (Hixaa → distributor); SECONDARY is sell-out (distributor → ' +
      'customer), which issues from the partner’s own channel warehouse (ADR-0014).',
  })
  async create(
    @Body(zodBody(createOrderSchema)) dto: CreateOrderDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.create(dto, actorId);
  }

  @Post('from-quotation/:quotationId')
  @RequirePermission(PERMISSIONS.QUOTATION_CONVERT)
  @ApiOperation({
    summary: 'Convert an ACCEPTED quotation into a DRAFT order',
    description: 'Re-prices as it converts rather than carrying a possibly stale number forward.',
  })
  async fromQuotation(
    @Param('quotationId', zodParam(uuidSchema)) quotationId: string,
    @Body() body: { warehouseId?: string; customerPoNumber?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.createFromQuotation(quotationId, body, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ORDER_UPDATE)
  @ApiOperation({ summary: 'Edit a DRAFT order. An approved order is frozen (ADR-0011).' })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateOrderSchema)) dto: UpdateOrderDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.update(id, dto, actorId);
  }

  @Post(':id/submit')
  @RequirePermission(PERMISSIONS.ORDER_SUBMIT)
  @ApiOperation({
    summary: 'Submit for approval',
    description: 'Refused unless the distributor is ACTIVE — only an active partner may transact.',
  })
  async submit(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.submit(id, actorId);
  }

  @Post(':id/approve')
  @RequirePermission(PERMISSIONS.ORDER_APPROVE)
  @ApiOperation({
    summary: 'Approve — credit, ceilings, and stock reservation',
    description:
      'Three gates in ONE transaction: the credit limit (refused unless a Finance Manager ' +
      'overrides with a stated reason), the approver’s discount and value ceilings ' +
      '(self-approval always refused), and per-line reservation — as much stock as exists, ' +
      'with the shortfall recorded as backordered (ADR-0012).',
  })
  async approve(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(approveOrderSchema)) dto: ApproveOrderDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.approve(id, dto, actorId);
  }

  @Post(':id/reject')
  @RequirePermission(PERMISSIONS.ORDER_REJECT)
  async reject(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(rejectOrderSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.reject(id, dto.reason, actorId);
  }

  @Post(':id/cancel')
  @RequirePermission(PERMISSIONS.ORDER_CANCEL)
  @ApiOperation({
    summary: 'Cancel, releasing every reservation it holds',
    description:
      'The release is the point — stock held against a dead order is stock nobody can sell, ' +
      'and the loss would be invisible.',
  })
  async cancel(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(cancelOrderSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.cancel(id, dto.reason, actorId);
  }

  @Post(':id/reserve')
  @RequirePermission(PERMISSIONS.ORDER_UPDATE)
  @ApiOperation({
    summary: 'Re-attempt reservation for backordered lines',
    description:
      'Explicit rather than automatic on goods receipt: allocating scarce stock between ' +
      'waiting customers is a commercial judgement (ADR-0012 §4).',
  })
  async reserve(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.orders.reserveOutstanding(id, actorId);
  }
}

// ── Shipments ───────────────────────────────────────────────────────────────

@ApiTags('Shipments')
@Controller('shipments')
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ORDER_READ)
  async list(
    @Query(zodQuery(listShipmentsQuerySchema))
    query: { orderId?: string; status?: string; warehouseId?: string; cursor?: string; limit: number; includeTotal: boolean },
  ) {
    return this.shipments.list(query as never);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ORDER_READ)
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.shipments.findDetail(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.ORDER_DISPATCH)
  @ApiOperation({
    summary: 'Build a shipment from order lines',
    description:
      'Validated against RESERVED quantities — a backordered line is refused with the ' +
      'shortfall and its expected date, not a generic "insufficient stock".',
  })
  async create(
    @Body(zodBody(createShipmentSchema)) dto: CreateShipmentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.shipments.create(dto, actorId);
  }

  @Post(':id/pack')
  @RequirePermission(PERMISSIONS.ORDER_DISPATCH)
  async pack(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.shipments.pack(id, actorId);
  }

  @Post(':id/dispatch')
  @RequirePermission(PERMISSIONS.ORDER_DISPATCH)
  @ApiOperation({
    summary: 'Dispatch — stock physically leaves',
    description:
      'One transaction: draws down the reservation and issues the stock (refused outright if ' +
      'nothing is reserved — invariant 2), posts the channel receipt into the partner’s ' +
      'warehouse for a sell-in (ADR-0014), records serials, and recomputes the order status.',
  })
  async dispatch(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(dispatchShipmentSchema)) dto: DispatchShipmentDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.shipments.dispatch(id, dto, actorId);
  }

  @Post(':id/deliver')
  @RequirePermission(PERMISSIONS.ORDER_DISPATCH)
  @ApiOperation({ summary: 'Record delivery and proof of delivery' })
  async deliver(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(deliverShipmentSchema))
    dto: { podDocumentId?: string; podReceivedBy?: string; deliveredAt?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.shipments.deliver(id, dto, actorId);
  }
}

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
  attachKycSchema,
  createAgreementSchema,
  createContactSchema,
  createDistributorSchema,
  createNoteSchema,
  listDistributorsQuerySchema,
  suspendDistributorSchema,
  updateCreditLimitSchema,
  updateDistributorSchema,
  uuidSchema,
  verifyKycSchema,
  type CreateContactDto,
  type CreateDistributorDto,
  type ListDistributorsQuery,
  type UpdateDistributorDto,
} from '@hixaa/contracts';
import { zodBody, zodParam, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { DistributorKycService } from './distributor-kyc.service';
import { DistributorRelationsService } from './distributor-relations.service';
import { DistributorsService } from './distributors.service';

@ApiTags('Distributors')
@Controller('distributors')
export class DistributorsController {
  constructor(
    private readonly distributors: DistributorsService,
    private readonly kyc: DistributorKycService,
    private readonly relations: DistributorRelationsService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_READ)
  @ApiOperation({
    summary: 'List distributors',
    description:
      'Scoped automatically: a territory-scoped caller sees only the distributors in their ' +
      'own subtree, enforced at the repository layer rather than here.',
  })
  async list(@Query(zodQuery(listDistributorsQuerySchema)) query: ListDistributorsQuery) {
    return this.distributors.list(query);
  }

  /** Declared before `:id` so it is not captured as an identifier. */
  @Get('kyc/expiring')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_READ)
  @ApiOperation({ summary: 'KYC certificates expiring within 30 days' })
  async expiringKyc(@Query('withinDays') withinDays?: string) {
    return this.kyc.expiring(withinDays ? Number(withinDays) : undefined);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_READ)
  @ApiOperation({ summary: 'Distributor 360 — profile, contacts, KYC, notes, agreements' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.distributors.findDetail(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_CREATE)
  @ApiOperation({
    summary: 'Create a distributor',
    description:
      'Always starts as a LEAD. Creating something already ACTIVE would bypass the KYC gate.',
  })
  async create(
    @Body(zodBody(createDistributorSchema)) dto: CreateDistributorDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.create(dto, actorId);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @ApiOperation({ summary: 'Update a distributor' })
  async update(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateDistributorSchema)) dto: UpdateDistributorDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.update(id, dto, actorId);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @Post(':id/submit')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @ApiOperation({ summary: 'Submit for approval (LEAD → PENDING_APPROVAL)' })
  async submit(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.submitForApproval(id, actorId);
  }

  @Post(':id/approve')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_APPROVE)
  @Idempotent()
  @ApiOperation({
    summary: 'Approve a distributor (→ ACTIVE)',
    description:
      'Refused unless the GST certificate, PAN, and agreement are all VERIFIED, a GSTIN is ' +
      'present, and there is at least one contact. Approving without verified KYC would make ' +
      'the first invoice for this partner legally defective.',
  })
  async approve(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.approve(id, actorId);
  }

  @Post(':id/suspend')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_APPROVE)
  @ApiOperation({ summary: 'Suspend a distributor' })
  async suspend(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(suspendDistributorSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.suspend(id, dto.reason, actorId);
  }

  @Post(':id/reactivate')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_APPROVE)
  @ApiOperation({ summary: 'Reactivate a suspended distributor' })
  async reactivate(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.reactivate(id, actorId);
  }

  @Post(':id/terminate')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_APPROVE)
  @ApiOperation({
    summary: 'Terminate a distributor',
    description: 'Terminal. Re-engaging a former partner is a new record, preserving history.',
  })
  async terminate(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(suspendDistributorSchema)) dto: { reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.terminate(id, dto.reason, actorId);
  }

  @Post(':id/credit-limit')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_CREDIT_UPDATE)
  @ApiOperation({
    summary: 'Change the credit limit',
    description:
      'Its own permission and a mandatory reason. The limit is what stands between the ' +
      'company and unrecoverable exposure, so it is never changeable as a side effect of ' +
      'editing a phone number.',
  })
  async setCreditLimit(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(updateCreditLimitSchema)) dto: { creditLimit: string; reason: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.distributors.setCreditLimit(id, dto.creditLimit, dto.reason, actorId);
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  @Post(':id/contacts')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @ApiOperation({ summary: 'Add a contact' })
  async addContact(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(createContactSchema)) dto: CreateContactDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.relations.addContact(id, dto, actorId);
  }

  @Delete(':id/contacts/:contactId')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a contact' })
  async removeContact(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('contactId', zodParam(uuidSchema)) contactId: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.relations.removeContact(id, contactId, actorId);
  }

  // ── KYC ───────────────────────────────────────────────────────────────────

  @Post(':id/kyc')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_DOCUMENT_MANAGE)
  @ApiOperation({ summary: 'Attach an uploaded document as KYC evidence' })
  async attachKyc(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(attachKycSchema))
    dto: { documentId: string; type: string; expiresAt?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.kyc.attach(id, dto.documentId, dto.type as never, dto.expiresAt, actorId);
  }

  @Post(':id/kyc/:kycId/verify')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_APPROVE)
  @ApiOperation({
    summary: 'Verify or reject KYC evidence',
    description:
      'Deliberately a different permission from attaching. Whoever uploads a GST certificate ' +
      'should not be the person who attests that it is genuine.',
  })
  async verifyKyc(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('kycId', zodParam(uuidSchema)) kycId: string,
    @Body(zodBody(verifyKycSchema)) dto: { approved: boolean; rejectionReason?: string },
    @CurrentUser('id') actorId: string,
  ) {
    return this.kyc.verify(id, kycId, dto.approved, dto.rejectionReason, actorId);
  }

  @Delete(':id/kyc/:kycId')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_DOCUMENT_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Detach KYC evidence' })
  async removeKyc(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Param('kycId', zodParam(uuidSchema)) kycId: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.kyc.remove(id, kycId, actorId);
  }

  // ── Notes & agreements ────────────────────────────────────────────────────

  @Post(':id/notes')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @ApiOperation({ summary: 'Add a note' })
  async addNote(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(createNoteSchema)) dto: { body: string; isPinned: boolean },
    @CurrentUser('id') actorId: string,
  ) {
    return this.relations.addNote(id, dto.body, dto.isPinned, actorId);
  }

  @Post(':id/agreements')
  @RequirePermission(PERMISSIONS.DISTRIBUTOR_UPDATE)
  @ApiOperation({ summary: 'Record an agreement' })
  async addAgreement(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Body(zodBody(createAgreementSchema))
    dto: {
      reference?: string;
      startDate: string;
      endDate?: string;
      targetAmount?: string;
      documentId?: string;
      notes?: string;
    },
    @CurrentUser('id') actorId: string,
  ) {
    return this.relations.addAgreement(id, dto, actorId);
  }
}

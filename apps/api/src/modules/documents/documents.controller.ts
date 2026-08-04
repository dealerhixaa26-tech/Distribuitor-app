import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, uuidSchema } from '@hixaa/contracts';
import type { Response } from 'express';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { ValidationError } from '../../common/errors/domain.error';
import { zodParam } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { DocumentsService, type UploadedFile } from './documents.service';

/** Hard ceiling before the buffer is even read; per-type limits apply after. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

@ApiTags('Documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.DOCUMENT_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a document',
    description:
      'Validated by magic bytes rather than extension or Content-Type — both are ' +
      'attacker-controlled. Scanned before the bytes reach disk, checksummed for ' +
      'deduplication, and stored under a generated key so the caller’s filename can never ' +
      'influence the path.',
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @UploadedFileParam() file: UploadedFile | undefined,
    @CurrentUser('id') actorId: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('purpose') purpose?: string,
  ) {
    if (!file) {
      throw new ValidationError('No file was uploaded.', [
        { field: 'file', code: 'REQUIRED', message: 'A file is required' },
      ]);
    }

    return this.documents.upload(file, actorId, {
      link: entityType && entityId ? { entityType, entityId, purpose } : undefined,
    });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Document metadata' })
  async findOne(@Param('id', zodParam(uuidSchema)) id: string) {
    return this.documents.findById(id);
  }

  @Get(':id/download')
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @RawResponse()
  @ApiOperation({
    summary: 'Download a document',
    description:
      'Streamed through this endpoint rather than served from a public path, so permission ' +
      'is re-checked on every request. Always sent as an attachment with nosniff, so a file ' +
      'is never rendered inline in the browser.',
  })
  async download(
    @Param('id', zodParam(uuidSchema)) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { stream, document } = await this.documents.openStream(id);

    response.setHeader('Content-Type', document.mimeType);
    response.setHeader('Content-Length', String(document.sizeBytes));
    // `attachment` plus nosniff means the browser downloads rather than
    // renders — the control that stops a crafted file executing in our origin.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(document.originalName)}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');

    stream.pipe(response);
  }

  @Get()
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Documents attached to an entity' })
  async listForEntity(
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    if (!entityType || !entityId) {
      throw new ValidationError('entityType and entityId are required.', [
        { field: 'entityType', code: 'REQUIRED', message: 'Required' },
      ]);
    }
    return this.documents.listForEntity(entityType, entityId);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.DOCUMENT_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a document' })
  async remove(
    @Param('id', zodParam(uuidSchema)) id: string,
    @CurrentUser('id') actorId: string,
  ): Promise<void> {
    await this.documents.remove(id, actorId);
  }
}

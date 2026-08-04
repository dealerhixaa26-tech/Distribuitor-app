import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@hixaa/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ClockService } from '../../common/utils/clock.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { AppConfigService } from '../../config/app-config.service';
import { AuditService } from '../../infrastructure/database/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { StorageService } from '../../infrastructure/storage/storage.service';
import { VirusScanner } from '../../infrastructure/storage/virus-scanner.service';
import { detectFileType, formatBytes } from './file-type';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface UploadOptions {
  visibility?: 'PUBLIC' | 'INTERNAL' | 'RESTRICTED';
  link?: { entityType: string; entityId: string; purpose?: string };
}

/**
 * Document lifecycle: validate → scan → store → record.
 *
 * Uses the `StorageService` and `VirusScanner` abstractions built in Phase 1,
 * so moving to S3 or enabling ClamAV is a config change rather than a rewrite.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scanner: VirusScanner,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly clock: ClockService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentsService.name);
  }

  async upload(file: UploadedFile, uploadedById: string, options: UploadOptions = {}) {
    // ── 1. Size ────────────────────────────────────────────────────────────
    const extension = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    const isDrawing = ['dxf', 'step'].includes(extension);
    const maxBytes =
      (isDrawing ? this.config.storage.maxSizeDrawingMb : this.config.storage.maxSizeMb) *
      1024 *
      1024;

    if (file.size > maxBytes) {
      throw new ValidationError(
        `File is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`,
        [{ field: 'file', code: ERROR_CODES.FILE_TOO_LARGE, message: 'Too large' }],
      );
    }
    if (file.size === 0) {
      throw new ValidationError('File is empty.', [
        { field: 'file', code: ERROR_CODES.VALIDATION_FAILED, message: 'Empty file' },
      ]);
    }

    // ── 2. Type, by magic bytes rather than extension or Content-Type ──────
    const detection = detectFileType(file.originalname, file.buffer, file.mimetype);
    if (!detection.ok || !detection.type) {
      throw new ValidationError(detection.reason ?? 'Unsupported file type.', [
        {
          field: 'file',
          code: ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
          message: detection.reason ?? 'Unsupported',
        },
      ]);
    }

    // ── 3. Checksum, which also gives us deduplication ─────────────────────
    const checksum = createHash('sha256').update(file.buffer).digest('hex');

    const duplicate = await this.prisma.db.document.findFirst({
      where: { checksumSha256: checksum },
      select: { id: true, storageKey: true, originalName: true, scanStatus: true },
    });

    if (duplicate) {
      // Byte-identical content already stored. Reuse it rather than writing a
      // second copy — the same GST certificate is often attached to several
      // records.
      this.logger.debug({ checksum, documentId: duplicate.id }, 'Duplicate upload deduplicated');
      if (options.link) await this.link(duplicate.id, options.link, uploadedById);
      return this.findById(duplicate.id);
    }

    // ── 4. Scan BEFORE the bytes reach disk ───────────────────────────────
    const scan = await this.scanner.scan(file.buffer);
    if (scan.verdict === 'INFECTED') {
      // Never stored. Logged as a security event because someone tried.
      await this.audit.recordStandalone({
        category: 'SECURITY',
        action: 'document.infected_rejected',
        metadata: {
          filename: file.originalname,
          checksum,
          engine: scan.engine,
          signature: scan.signature,
          uploadedById,
        },
      });
      throw new ValidationError('This file failed a malware scan and was not stored.', [
        { field: 'file', code: ERROR_CODES.FILE_INFECTED, message: 'Malware detected' },
      ]);
    }

    // ── 5. Store under a generated key ────────────────────────────────────
    // The caller's filename is never used as a path: it is attacker-controlled
    // and a traversal vector. It is kept as metadata for display only.
    const now = this.clock.now();
    const storageKey = `documents/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${detection.type.extension}`;

    const stored = await this.storage.put(storageKey, file.buffer, {
      contentType: detection.type.mimeType,
      originalName: file.originalname,
      size: file.size,
      checksum,
    });

    // ── 6. Record ─────────────────────────────────────────────────────────
    const document = await this.prisma.transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          storageKey: stored.key,
          provider: this.storage.provider,
          originalName: file.originalname.slice(0, 255),
          mimeType: detection.type!.mimeType,
          sizeBytes: BigInt(file.size),
          checksumSha256: checksum,
          scanStatus: scan.verdict,
          scanEngine: scan.engine,
          scannedAt: now,
          visibility: options.visibility ?? 'INTERNAL',
          uploadedById,
        },
        select: { id: true },
      });

      if (options.link) {
        await tx.documentLink.create({
          data: {
            documentId: created.id,
            entityType: options.link.entityType,
            entityId: options.link.entityId,
            purpose: options.link.purpose ?? null,
          },
        });
      }

      await this.audit.record(tx, {
        action: 'document.uploaded',
        entityType: 'Document',
        entityId: created.id,
        after: {
          originalName: file.originalname,
          sizeBytes: file.size,
          mimeType: detection.type!.mimeType,
          scanStatus: scan.verdict,
        },
      });

      return created;
    });

    this.logger.info(
      { documentId: document.id, size: file.size, scan: scan.verdict },
      'Document uploaded',
    );

    return this.findById(document.id);
  }

  async findById(id: string) {
    const document = await this.prisma.db.document.findFirst({
      where: { id },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        checksumSha256: true,
        scanStatus: true,
        visibility: true,
        uploadedById: true,
        createdAt: true,
        uploadedBy: { select: { firstName: true, lastName: true } },
        links: { select: { entityType: true, entityId: true, purpose: true } },
      },
    });
    if (!document) throw new NotFoundError('Document', id);

    return {
      id: document.id,
      originalName: document.originalName,
      mimeType: document.mimeType,
      // BigInt cannot be JSON-serialised; the transform interceptor would
      // stringify it, but a number is friendlier for a size.
      sizeBytes: Number(document.sizeBytes),
      checksum: document.checksumSha256,
      scanStatus: document.scanStatus,
      visibility: document.visibility,
      uploadedBy: document.uploadedBy
        ? `${document.uploadedBy.firstName} ${document.uploadedBy.lastName}`
        : null,
      createdAt: document.createdAt,
      links: document.links,
    };
  }

  /** Documents attached to an entity. */
  async listForEntity(entityType: string, entityId: string) {
    const links = await this.prisma.db.documentLink.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      select: { purpose: true, documentId: true },
    });

    if (links.length === 0) return [];

    const documents = await Promise.all(links.map((link) => this.findById(link.documentId)));
    return documents;
  }

  async link(
    documentId: string,
    target: { entityType: string; entityId: string; purpose?: string },
    actorId: string,
  ): Promise<void> {
    const document = await this.prisma.db.document.findFirst({
      where: { id: documentId },
      select: { id: true },
    });
    if (!document) throw new NotFoundError('Document', documentId);

    // find-then-create rather than upsert: `purpose` is nullable, and Prisma's
    // compound-unique lookup cannot express a null component, so the upsert
    // form does not typecheck for this key.
    const existingLink = await this.prisma.db.documentLink.findFirst({
      where: {
        documentId,
        entityType: target.entityType,
        entityId: target.entityId,
        purpose: target.purpose ?? null,
      },
      select: { id: true },
    });

    if (!existingLink) {
      await this.prisma.db.documentLink.create({
        data: {
          documentId,
          entityType: target.entityType,
          entityId: target.entityId,
          purpose: target.purpose ?? null,
        },
      });
    }

    this.logger.debug({ documentId, ...target, actorId }, 'Document linked');
  }

  /**
   * Opens a stream for download.
   *
   * A document sits at `PENDING` until a scanner clears it and is undownloadable
   * until then — that state machine is the whole reason the scan hook exists
   * rather than being a comment promising scanning later.
   */
  async openStream(id: string): Promise<{ stream: Readable; document: Awaited<ReturnType<DocumentsService['findById']>> }> {
    const document = await this.findById(id);

    if (document.scanStatus === 'PENDING') {
      throw new ConflictError(
        'This file is still being scanned for malware. Try again in a moment.',
      );
    }
    if (document.scanStatus === 'INFECTED') {
      throw new ConflictError('This file failed a malware scan and cannot be downloaded.');
    }

    const row = await this.prisma.db.document.findFirst({
      where: { id },
      select: { storageKey: true },
    });
    if (!row) throw new NotFoundError('Document', id);

    return { stream: await this.storage.get(row.storageKey), document };
  }

  async remove(id: string, actorId: string): Promise<void> {
    const document = await this.prisma.db.document.findFirst({
      where: { id },
      select: { id: true, originalName: true, storageKey: true, checksumSha256: true },
    });
    if (!document) throw new NotFoundError('Document', id);

    await this.prisma.transaction(async (tx) => {
      await tx.document.softDelete({ id });
      await this.audit.record(tx, {
        action: 'document.deleted',
        entityType: 'Document',
        entityId: id,
        before: { originalName: document.originalName },
        metadata: { actorId },
      });
    });

    // The stored object is deliberately NOT removed. Another document may share
    // it through checksum deduplication, and a soft-deleted record must stay
    // restorable. Orphaned objects are reclaimed by a retention job that checks
    // for remaining references.
    this.logger.info({ documentId: id }, 'Document soft-deleted; object retained');
  }
}

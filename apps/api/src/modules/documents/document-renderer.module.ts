import { Module } from '@nestjs/common';
import { DocumentRendererService } from './document-renderer.service';

/**
 * PDF rendering, shared across documents. See ADR-0013.
 *
 * Its own module rather than a provider inside Sales, because Phase 8's tax
 * invoice and Phase 9's statements will use exactly this renderer. Building it
 * once was the reason the owner chose to bring it forward into Phase 7.
 *
 * `SettingsService` is @Global, so the company identity the letterhead needs
 * requires no import here.
 */
@Module({
  providers: [DocumentRendererService],
  exports: [DocumentRendererService],
})
export class DocumentRendererModule {}

import { Global, Module } from '@nestjs/common';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { OutboxService } from './outbox.service';

/**
 * The emitter, available everywhere. Services write events inside their
 * transactions, so both the API and the worker need this.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}

/**
 * The dispatcher, imported by WorkerModule ONLY.
 *
 * Kept in a separate module rather than gated by a config flag: if the API also
 * provided it, every API replica would poll the outbox. `FOR UPDATE SKIP
 * LOCKED` makes that safe rather than incorrect, but it is still N processes
 * doing work one process should do, and the separation makes the intent
 * structural instead of conditional.
 */
@Module({
  providers: [OutboxDispatcherService],
  exports: [OutboxDispatcherService],
})
export class OutboxDispatcherModule {}

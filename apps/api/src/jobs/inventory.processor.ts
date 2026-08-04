import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { OutboxDispatcherService } from '../infrastructure/outbox/outbox-dispatcher.service';
import { ReconciliationService } from '../modules/inventory/reconciliation.service';
import { ReservationsService } from '../modules/inventory/reservations.service';
import { StockService } from '../modules/inventory/stock.service';

/**
 * Scheduled inventory housekeeping. Roadmap 6.6, 6.7, 6.8.
 *
 * Three jobs, each of which exists because an unattended deployment has to
 * notice its own problems rather than wait for someone to spot them at a stock
 * count months later.
 */
@Injectable()
export class InventoryProcessor {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly reservations: ReservationsService,
    private readonly stock: StockService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InventoryProcessor.name);
  }

  /**
   * Re-derives every balance from the ledger and alerts on drift (ADR-0002).
   *
   * Runs at 2am, before the 3am retention purge, so a drift is detected against
   * a ledger nothing has touched that night.
   *
   * It reports and does not heal — silently correcting would destroy the only
   * evidence that a bug exists.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async reconcileStock(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('stock-reconciliation', async () => {
      try {
        const result = await this.reconciliation.reconcile();
        if (!result.clean) {
          this.logger.error(
            {
              quantityDrifts: result.quantityDrifts.length,
              reservationDrifts: result.reservationDrifts.length,
            },
            'Stock reconciliation found drift — investigate before trusting balances',
          );
        }
      } catch (error) {
        this.logger.error({ err: error }, 'Stock reconciliation failed');
      }
    });
  }

  /**
   * Releases reservations past their expiry.
   *
   * Hourly rather than nightly: stock held behind an order nobody is
   * progressing is stock the business cannot sell, and a day of that is a day
   * of avoidable lost availability.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleReservations(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('reservation-expiry', async () => {
      try {
        await this.reservations.expireStale();
      } catch (error) {
        this.logger.error({ err: error }, 'Reservation expiry sweep failed');
      }
    });
  }

  /**
   * Raises low-stock alerts once a day.
   *
   * Daily, not hourly: a reorder level is crossed once and stays crossed until
   * someone buys more, so an hourly job would send the same alert 24 times and
   * train everyone to ignore it.
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async alertLowStock(): Promise<void> {
    if (!this.config.queue.workerEnabled) return;

    await OutboxDispatcherService.asSystem('low-stock-alert', async () => {
      try {
        const count = await this.stock.emitLowStockAlerts();
        if (count > 0) this.logger.warn({ count }, 'Low-stock alerts raised');
      } catch (error) {
        this.logger.error({ err: error }, 'Low-stock alert job failed');
      }
    });
  }
}

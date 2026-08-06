import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { StorageService } from '../storage/storage.service';
import { SheetsPort, type SheetLocation } from './sheets.port';

/** RFC 4180 quoting. A cell containing a comma or a quote must survive it. */
function toCsvLine(row: string[]): string {
  return row
    .map((cell) => {
      const value = cell ?? '';
      return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    })
    .join(',');
}

/** Splits one CSV line, honouring quotes and doubled quotes. */
function fromCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      out.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  out.push(cell);
  return out;
}

/**
 * A real backup target that happens to be the local disk.
 *
 * ADR-0023: this is the development driver, not a test double. It writes CSVs
 * a person can open, through the same `StorageService` seam everything else
 * uses, so switching the whole backup to S3 later is a driver swap.
 *
 * It exists so that the 85% of module 10.1 which is not Google-specific —
 * chunking, checkpoint resumption, masking, restore diffing — can be executed
 * and proven today, with no Google Cloud service account in existence (E7).
 * A mock would prove only that the right methods were called.
 */
@Injectable()
export class LocalFileSheetsAdapter extends SheetsPort {
  readonly provider = 'LOCAL_FILE' as const;

  /** Counted for parity with the Google adapter, so SyncJob reads the same. */
  private requests = 0;

  constructor(
    private readonly storage: StorageService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(LocalFileSheetsAdapter.name);
  }

  private key(location: SheetLocation): string {
    // Titles come from a fixed catalogue, never from user input, but they are
    // sanitised anyway — a title is about to become a path segment.
    const safe = location.title.replace(/[^A-Za-z0-9._-]/g, '_');
    const book = location.spreadsheetId.replace(/[^A-Za-z0-9._-]/g, '_');
    return `sheets-backup/${book}/${safe}.csv`;
  }

  async ensureSheet(location: SheetLocation): Promise<void> {
    this.requests++;
    const key = this.key(location);
    if (!(await this.storage.exists(key))) {
      await this.storage.put(key, Buffer.from('', 'utf8'), {
        contentType: 'text/csv',
        originalName: `${location.title}.csv`,
        size: 0,
      });
    }
  }

  async appendRows(location: SheetLocation, rows: string[][]): Promise<void> {
    if (rows.length === 0) return;
    this.requests++;

    const key = this.key(location);
    const existing = (await this.storage.exists(key))
      ? (await this.storage.getBuffer(key)).toString('utf8')
      : '';

    const body = rows.map(toCsvLine).join('\n');
    const next = existing.length > 0 ? `${existing.replace(/\n$/, '')}\n${body}\n` : `${body}\n`;

    const body2 = Buffer.from(next, 'utf8');
    await this.storage.put(key, body2, {
      contentType: 'text/csv',
      originalName: `${location.title}.csv`,
      size: body2.length,
    });
  }

  /**
   * Staging → target, then drop staging.
   *
   * Not atomic on a filesystem the way a Sheets batchUpdate is, and that
   * difference is recorded rather than papered over: the local adapter models
   * the SHAPE of the swap so the calling code is identical, but only the Google
   * adapter can make it genuinely atomic.
   */
  async swapSheet(staging: SheetLocation, target: SheetLocation): Promise<void> {
    this.requests++;
    const stagingKey = this.key(staging);
    const targetKey = this.key(target);

    const content = (await this.storage.exists(stagingKey))
      ? await this.storage.getBuffer(stagingKey)
      : Buffer.from('', 'utf8');

    await this.storage.put(targetKey, content, {
      contentType: 'text/csv',
      originalName: `${target.title}.csv`,
      size: content.length,
    });
    await this.storage.delete(stagingKey);

    this.logger.debug(
      { from: staging.title, to: target.title, bytes: content.length },
      'Sheet swapped',
    );
  }

  async readRows(location: SheetLocation): Promise<string[][]> {
    this.requests++;
    const key = this.key(location);
    if (!(await this.storage.exists(key))) return [];

    const text = (await this.storage.getBuffer(key)).toString('utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map(fromCsvLine);
  }

  async deleteSheet(location: SheetLocation): Promise<void> {
    this.requests++;
    const key = this.key(location);
    if (await this.storage.exists(key)) await this.storage.delete(key);
  }

  /** Always reachable — the target is a local directory. */
  async probe(spreadsheetId: string): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `local CSV directory sheets-backup/${spreadsheetId}` };
  }

  requestCount(): number {
    return this.requests;
  }
}

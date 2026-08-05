/**
 * The seam between "backing up to a tabular target" and "talking to Google".
 *
 * Almost nothing about module 10.1 is Google-specific: checkpointing, keyset
 * pagination, masking, restore diffing and quota pacing are properties of
 * exporting a database to a grid of cells. Isolating the handful of calls that
 * ARE Google-specific behind this interface is what lets the rest be written
 * and verified with no service account in existence. See ADR-0023.
 *
 * Two implementations:
 *   • `GoogleSheetsAdapter`   — real API, unexecuted until credentials exist.
 *   • `LocalFileSheetsAdapter` — writes real CSVs through `StorageService`.
 *
 * The local one is NOT a mock. It is the development driver, permanently, in
 * the same way `LocalStorageDriver` is for object storage.
 */

/** Where a backup lives. Sharded by entity — see `docs/07` §2. */
export interface SheetLocation {
  spreadsheetId: string;
  title: string;
}

export abstract class SheetsPort {
  abstract readonly provider: 'GOOGLE' | 'LOCAL_FILE';

  /** Creates the sheet if absent. Idempotent. */
  abstract ensureSheet(location: SheetLocation): Promise<void>;

  /**
   * Appends a batch of rows. Called repeatedly, once per chunk, so an export
   * of 400,000 rows never builds one enormous request.
   */
  abstract appendRows(location: SheetLocation, rows: string[][]): Promise<void>;

  /**
   * Replaces `target` with `staging` atomically from a reader's point of view,
   * then drops `staging`.
   *
   * This is why a failed run never leaves a half-written backup that looks
   * complete: every export writes to a staging sheet and only swaps at the end.
   */
  abstract swapSheet(staging: SheetLocation, target: SheetLocation): Promise<void>;

  /** Reads a sheet back, for restore and for verifying an export. */
  abstract readRows(location: SheetLocation): Promise<string[][]>;

  /** Removes a sheet — used to clean up staging after a failure. */
  abstract deleteSheet(location: SheetLocation): Promise<void>;

  /**
   * Requests issued so far. Surfaced onto `SyncJob.apiRequests` so quota
   * consumption is a number someone can look at rather than a guess.
   */
  abstract requestCount(): number;
}

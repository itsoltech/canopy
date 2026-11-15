import type { CopyAttemptProgress } from "./attempt.ts";
import type { JobProgress, JobRow } from "./jobs-store.ts";

/** Progress reaches clients a few times a second and the database every few seconds. */
const PUBLISH_MS = 250;
const PERSIST_MS = 2_000;

export interface LiveJob {
  row: JobRow;
  currentFile: string;
}

export const progressOf = (row: JobRow): JobProgress => ({
  bytes: row.bytes,
  totalBytes: row.total_bytes,
  files: row.files,
  totalFiles: row.total_files,
  skipped: row.skipped,
});

const max = <T extends bigint | number>(a: T, b: T): T => (a > b ? a : b);
const min = <T extends bigint | number>(a: T, b: T): T => (a < b ? a : b);

/**
 * One attempt's progress, throttled. A resumed or retried attempt counts again from zero (staged files are
 * confirmed by hash, then counted), so the job shows the higher of what it showed before and what this attempt
 * reached: its counters never step back. A file counts once the target wrote and verified it.
 */
export class AttemptReporter {
  started = false;
  #published = 0;
  #persisted = Date.now();
  readonly #before: JobRow;

  constructor(
    private readonly live: LiveJob,
    private readonly publish: (row: JobRow, currentFile: string) => void,
    private readonly persist: (id: string, progress: JobProgress) => Promise<void>,
    private readonly ready?: PromiseWithResolvers<void>,
  ) {
    this.#before = live.row;
  }

  readonly report = (progress: CopyAttemptProgress) => {
    this.started = true;
    this.ready?.resolve();
    const before = this.#before;
    // A fresh file list can change the totals; the counters stay within them.
    this.live.row = {
      ...this.live.row,
      status: progress.status === "finishing" ? "finishing" : "copying",
      bytes: min(max(before.bytes, progress.bytes), progress.totalBytes),
      total_bytes: progress.totalBytes,
      files: min(max(before.files, progress.files), progress.totalFiles),
      total_files: progress.totalFiles,
      skipped: progress.skipped,
    };
    this.live.currentFile = progress.currentFile;
    const now = Date.now();

    if (now - this.#published >= PUBLISH_MS || progress.status !== "copying") {
      this.#published = now;
      this.publish(this.live.row, this.live.currentFile);
    }

    if (now - this.#persisted >= PERSIST_MS) {
      this.#persisted = now;
      void this.persist(this.live.row.id, progressOf(this.live.row)).catch(() => {});
    }
  };

  /** Stores the counters the clients last saw, so a failed or finished job shows them after a reload too. */
  async flush(done?: CopyAttemptProgress) {
    if (done) this.report(done);
    await this.persist(this.live.row.id, progressOf(this.live.row)).catch(() => {});
  }
}

import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LOG_LIMITS, type LogCoverage, type LogSource } from "./limits.ts";
import { exportedRecord, LogRedactor } from "./redaction.ts";
import { reverseRecords } from "./records.ts";

export interface LogRegistration {
  source: LogSource;
  file: string;
  rotationVerified: boolean;
}

export interface ExportRange {
  hours: number;
  legacy: boolean;
  bytes: number;
}

export interface ExportedLog {
  coverage: LogCoverage;
  file: string;
}

/** One exporter per process/home. Only already-redacted complete records reach this private spool. */
export class LogExporter {
  #active = false;
  readonly redactor = new LogRedactor();
  constructor(readonly sources: readonly LogRegistration[]) {
    if (sources.length > 6 || new Set(sources.map((s) => s.source)).size !== sources.length)
      throw new Error("Invalid fixed log source registry");
  }
  async export(directory: string, range: ExportRange, signal: AbortSignal) {
    const output: ExportedLog[] = [];

    for await (const file of this.files(directory, range, signal)) output.push(file);

    return output;
  }
  async *files(directory: string, range: ExportRange, signal: AbortSignal) {
    if (this.#active) throw new Error("A log export is already running");

    if (
      ![1, 6, 24].includes(range.hours) ||
      !Number.isSafeInteger(range.bytes) ||
      range.bytes < 0 ||
      range.bytes > LOG_LIMITS.home
    )
      throw new Error("Invalid log export range");
    this.#active = true;

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const scan = { remaining: LOG_LIMITS.scan };
      const budget = Math.min(LOG_LIMITS.source, Math.floor(range.bytes / Math.max(1, this.sources.length)));
      const now = Date.now();

      for (const source of this.sources) {
        signal.throwIfAborted();
        yield await exportSource(
          source,
          join(directory, `${source.source}.log`),
          range,
          budget,
          now,
          scan,
          signal,
          this.redactor,
        );
      }
    } finally {
      this.#active = false;
    }
  }
}

async function exportSource(
  registration: LogRegistration,
  path: string,
  range: ExportRange,
  budget: number,
  now: number,
  scan: { remaining: number },
  signal: AbortSignal,
  redactor: LogRedactor,
): Promise<ExportedLog> {
  const coverage: LogCoverage = {
    source: registration.source,
    status: "done",
    bytes: 0,
    records: 0,
    omittedRecords: 0,
    omittedBytes: 0,
    redactedRecords: 0,
    firstAtMs: 0,
    lastAtMs: 0,
    legacy: false,
    rotationVerified: registration.rotationVerified,
  };

  const file = await open(path, "wx", 0o600);
  const output = Buffer.alloc(LOG_LIMITS.chunk);
  let used = 0;

  try {
    for (let index = 0; index < 4; index++) {
      try {
        const input = `${registration.file}${index ? `.${index}` : ""}`;

        for await (const record of reverseRecords(input, scan, signal)) {
          const text = record.line?.toString("utf8");
          const timestamp = text ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /.exec(text) : undefined;
          const at = timestamp ? Date.parse(timestamp[0].trimEnd()) : 0;

          if (at && (at < now - range.hours * 3_600_000 || at > now + 60_000)) continue;

          const redacted =
            text && (at || range.legacy)
              ? exportedRecord(
                  redactor.redact(timestamp ? text.slice(timestamp[0].length) : text),
                  registration.source,
                  at,
                  !at,
                )
              : undefined;

          if (!redacted || coverage.bytes + Buffer.byteLength(redacted) > budget) {
            coverage.omittedRecords++;
            coverage.omittedBytes += record.bytes;

            if (redacted) coverage.status = "truncated";
            continue;
          }

          const bytes = Buffer.from(redacted);

          if (used + bytes.length > output.length) {
            await file.writeFile(output.subarray(0, used));
            used = 0;
          }

          bytes.copy(output, used);
          used += bytes.length;
          coverage.bytes += Buffer.byteLength(redacted);
          coverage.records++;
          coverage.redactedRecords++;
          coverage.legacy ||= !at;
          coverage.firstAtMs = at ? Math.min(coverage.firstAtMs || at, at) : coverage.firstAtMs;
          coverage.lastAtMs = Math.max(coverage.lastAtMs, at);
        }
      } catch (error) {
        signal.throwIfAborted();

        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        coverage.status = "omitted";
        throw error;
      }
    }

    if (used) await file.writeFile(output.subarray(0, used));

    if (!scan.remaining) coverage.status = "truncated";

    if (!coverage.records && !coverage.omittedRecords) coverage.status = "not_available";
    else if (!coverage.records && coverage.status === "done") coverage.status = "omitted";

    return { coverage, file: path };
  } catch {
    await file.truncate(0);
    coverage.status = signal.aborted ? "timed_out" : "omitted";
    coverage.bytes = coverage.records = 0;

    return { coverage, file: path };
  } finally {
    await file.close();
  }
}

/** Rate limited reads never retain a whole source or ZIP in heap. */
export async function* logFileChunks(path: string, signal: AbortSignal, bytesPerSecond = 512 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    let position = 0;

    while (true) {
      signal.throwIfAborted();
      const data = Buffer.alloc(LOG_LIMITS.chunk);
      const { bytesRead } = await file.read(data, 0, data.length, position);

      if (!bytesRead) return;
      position += bytesRead;
      yield data.subarray(0, bytesRead);
      await delay(Math.ceil((bytesRead * 1000) / bytesPerSecond), undefined, { signal });
    }
  } finally {
    await file.close();
  }
}

/** Scoped to a dedicated private subdirectory, including restart leftovers. */
export async function cleanLogSpool(directory: string) {
  await rm(join(directory, "diagnostics-log-spool"), { recursive: true, force: true });
}

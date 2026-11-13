import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { LogExporter, logFileChunks } from "./export.ts";
import type { LogCoverage } from "./limits.ts";

export const logChecksum = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export function coverageMessage(value: LogCoverage, worker = 0) {
  return create(ui.DiagnosticsLogCoverageSchema, {
    ...value,
    worker,
    bytes: BigInt(value.bytes),
    records: BigInt(value.records),
    omittedRecords: BigInt(value.omittedRecords),
    omittedBytes: BigInt(value.omittedBytes),
    redactedRecords: BigInt(value.redactedRecords),
    firstAtMs: BigInt(value.firstAtMs),
    lastAtMs: BigInt(value.lastAtMs),
  });
}

/** Exactly one pull in flight; no retries, outbox, raw errors or retained transfer promises. */
export class LogPullSource {
  #active:
    | {
        id: string;
        controller: AbortController;
        iterator: AsyncGenerator<ui.DiagnosticsLogPart>;
        directory: string;
        started: number;
      }
    | undefined;
  #busy = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly exporter: LogExporter,
    readonly directory: string,
  ) {}

  async receive(command: ui.DiagnosticsLogSourceCommand) {
    if (this.#busy || !/^[a-f0-9-]{36}$/.test(command.transferId)) throw new Error("Invalid log source pull");
    this.#busy = true;

    try {
      if (command.cancel) {
        if (this.#active?.id === command.transferId) await this.close();

        return create(ui.DiagnosticsLogPartSchema, { end: true });
      }

      if (command.begin) {
        if (this.#active) throw new Error("Log source is already exporting");
        const controller = new AbortController();
        const directory = join(this.directory, command.transferId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        this.#active = {
          id: command.transferId,
          controller,
          directory,
          started: Date.now(),
          iterator: this.#stream(directory, command.begin, controller.signal),
        };
      }

      const active = this.#active;

      if (!active || active.id !== command.transferId || Date.now() - active.started > 60_000)
        throw new Error("Log source transfer expired");
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        active.controller.abort();
        void this.close();
      }, 15_000);
      this.#timer.unref();
      const result = await active.iterator.next();

      if (result.done) await this.close();

      return result.done ? create(ui.DiagnosticsLogPartSchema, { end: true }) : result.value;
    } catch {
      await this.close();
      throw new Error("Log source export unavailable");
    } finally {
      this.#busy = false;
    }
  }

  async close() {
    clearTimeout(this.#timer);
    const active = this.#active;
    this.#active = undefined;

    if (active) {
      active.controller.abort();
      await active.iterator.return(undefined).catch(() => {});
      await rm(active.directory, { recursive: true, force: true });
    }
  }

  async *#stream(directory: string, request: ui.DiagnosticsHomeLogsRequest, signal: AbortSignal) {
    const files = this.exporter.files(
      directory,
      { hours: request.hours, legacy: request.includeLegacy, bytes: request.budgetBytes },
      signal,
    );

    let sequence = 0;

    for await (const file of files) {
      yield create(ui.DiagnosticsLogPartSchema, { sequence: sequence++, coverage: coverageMessage(file.coverage) });

      for await (const data of logFileChunks(file.file, signal))
        yield create(ui.DiagnosticsLogPartSchema, { sequence: sequence++, data, checksum: logChecksum(data) });
    }
  }
}

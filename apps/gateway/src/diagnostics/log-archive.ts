import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { LogZip, LOG_LIMITS, logChecksum, logSource, verifiedLogChunks } from "@canopy/logs";
import { Code, ConnectError } from "@connectrpc/connect";
import { safeLogEnvironment } from "./log-environment.ts";
import { logJsonChunks } from "@canopy/logs";

/** Only two home readers share this writer. Backpressure waits before pulling another source chunk. */
export class LogArchive {
  #tail = Promise.resolve();
  #bytes = 0;
  constructor(readonly zip: LogZip) {}

  async home(
    alias: string,
    stream: AsyncIterable<ui.DiagnosticsLogPart>,
    home: ui.DiagnosticsLogsHome,
    budget: number,
    signal: AbortSignal,
  ) {
    const iterator = stream[Symbol.asyncIterator]();
    let current = await iterator.next();
    let sequence = 0;
    let bytes = 0;
    const seen = new Set<string>();

    const next = async () => {
      signal.throwIfAborted();
      const value = await iterator.next();

      if (value.done) throw new ConnectError("Log transfer ended early", Code.DataLoss);

      return value;
    };

    try {
      if (!current.done && current.value.environment && current.value.sequence === sequence++) {
        const environment = safeLogEnvironment(current.value.environment);
        const previous = this.#tail;
        const release = Promise.withResolvers<void>();
        this.#tail = release.promise;
        await previous;

        try {
          await this.zip.add(`${alias}/manifest.json`, logJsonChunks(environment), signal);
        } finally {
          release.resolve();
        }

        home.status = "redacting";
        current = await next();
      } else throw new ConnectError("Log environment metadata is missing", Code.DataLoss);

      while (!current.done) {
        const metadata = current.value;

        if (metadata.sequence !== sequence++) throw new ConnectError("Invalid log transfer sequence", Code.DataLoss);

        if (metadata.end) break;
        const coverage = metadata.coverage;

        if (
          !coverage ||
          metadata.data.length ||
          !logSource(coverage.source) ||
          coverage.worker > 16 ||
          (coverage.worker > 0 && coverage.source !== "worker") ||
          coverage.bytes > BigInt(LOG_LIMITS.source) ||
          !["done", "truncated", "not_available", "omitted", "timed_out", "offline", "unsupported"].includes(
            coverage.status,
          )
        )
          throw new ConnectError("Invalid log transfer metadata", Code.DataLoss);
        const name = `${alias}/${coverage.worker ? `Worker-${coverage.worker}/` : ""}${coverage.source}.log`;

        if (seen.has(name)) throw new ConnectError("Duplicate log source", Code.DataLoss);
        seen.add(name);

        // Projection discards unknown fields and never stores an error or an arbitrary remote string.
        const safe = create(ui.DiagnosticsLogCoverageSchema, {
          source: coverage.source,
          worker: coverage.worker,
          status: coverage.status,
          bytes: 0n,
          records: coverage.records,
          omittedRecords: coverage.omittedRecords,
          omittedBytes: coverage.omittedBytes,
          redactedRecords: coverage.redactedRecords,
          firstAtMs: coverage.firstAtMs,
          lastAtMs: coverage.lastAtMs,
          legacy: coverage.legacy,
          rotationVerified: coverage.rotationVerified,
        });

        home.sources.push(safe);
        home.status = "transferring";
        const previous = this.#tail;
        const release = Promise.withResolvers<void>();
        this.#tail = release.promise;
        await previous;

        try {
          let incoming = 0;

          const chunks = async function* (archive: LogArchive) {
            current = await next();

            while (!current.value.coverage && !current.value.end) {
              const part = current.value;

              if (
                part.sequence !== sequence++ ||
                !part.data.length ||
                part.data.length > LOG_LIMITS.chunk ||
                logChecksum(part.data) !== part.checksum
              )
                throw new ConnectError("Invalid log transfer chunk", Code.DataLoss);
              bytes += part.data.length;
              archive.#bytes += part.data.length;
              incoming += part.data.length;

              if (bytes > budget || archive.#bytes > LOG_LIMITS.action || incoming > LOG_LIMITS.source)
                throw new ConnectError("Log transfer budget reached", Code.ResourceExhausted);
              yield part.data;
              current = await next();
            }
          };

          const input = chunks(this);

          const verified = async function* () {
            for await (const data of verifiedLogChunks(input, logSource(safe.source)!, () => {
              safe.omittedRecords++;
              safe.status = "omitted";
            })) {
              safe.bytes += BigInt(data.length);
              home.bytes += BigInt(data.length);
              yield data;
            }
          };

          await this.zip.add(name, verified(), signal);
        } finally {
          release.resolve();
        }
      }

      if (current.done || !current.value.end) throw new ConnectError("Log transfer ended early", Code.DataLoss);
      home.status = home.sources.some((source) => source.status !== "done") ? "partial" : "done";
    } catch (error) {
      for (const source of home.sources) if (source.status === "done") source.status = "truncated";
      throw error;
    } finally {
      await iterator.return?.();
    }
  }
}

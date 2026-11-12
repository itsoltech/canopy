import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { LogExporter, LogPullSource, LOG_LIMITS, LOG_SOURCES, logSource, logChecksum } from "@canopy/logs";
import { Code, ConnectError } from "@connectrpc/connect";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GatewayCore, GatewayCoreOptions } from "../core/core.ts";
import { LogSources } from "./log-sources.ts";
import { LogPullClient } from "./log-pull.ts";
import { queryFamily } from "./query-context.ts";
import { logEnvironmentMessage } from "./log-environment.ts";

export class HomeLogExport {
  readonly registered = new LogSources();
  readonly active = new Map<string, AbortController>();
  constructor(
    readonly core: GatewayCore,
    readonly options: GatewayCoreOptions,
    readonly directory: string,
  ) {}

  async *stream(request: ui.DiagnosticsHomeLogsRequest, origin: string, parent: AbortSignal) {
    validateHomeLogRequest(request);

    if (this.active.size)
      throw new ConnectError("A log export is already running on this computer", Code.ResourceExhausted);
    const abort = new AbortController();
    const signal = AbortSignal.any([parent, abort.signal, AbortSignal.timeout(60_000)]);
    this.active.set(origin, abort);
    const directory = join(this.directory, "source", request.actionId);
    const local = new LogPullSource(new LogExporter(this.options.logSources ?? []), directory);
    const transfer = crypto.randomUUID();
    let sequence = 0;

    try {
      await this.core.diagnostics.logs.audit(request.actionId, "home_start", request.hours, 0);
      yield create(ui.DiagnosticsLogPartSchema, {
        sequence: sequence++,
        environment: logEnvironmentMessage(this.core),
      });
      const owner = this.options.userId;

      const workers = await this.options.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql<{ id: string }>`SELECT id FROM workers
          WHERE (owner_user_id=${owner}::uuid OR owner_user_id IS NULL)
            AND revoked_at IS NULL AND archived_at IS NULL ORDER BY id LIMIT 16`.pipe(
            queryFamily("diagnostics.history"),
          );
        }),
      );

      const registrations = [...this.registered.sessions.values()];
      const available = new Set((this.options.logSources ?? []).map((s) => s.source));

      for (const entry of registrations)
        for (const name of entry.sources) {
          const source = logSource(name);

          if (source) available.add(source);
        }

      const unit = Math.min(
        LOG_LIMITS.source,
        Math.floor(request.budgetBytes / Math.max(1, available.size + workers.length)),
      );

      const own = create(ui.DiagnosticsHomeLogsRequestSchema, {
        ...request,
        budgetBytes: unit * (this.options.logSources?.length ?? 0),
      });

      if (own.budgetBytes)
        for await (const part of pullSource((command) => local.receive(command), transfer, own, signal))
          yield create(ui.DiagnosticsLogPartSchema, { ...part, sequence: sequence++ });

      for (const entry of registrations) {
        const input = create(ui.DiagnosticsHomeLogsRequestSchema, {
          ...request,
          budgetBytes: unit * entry.sources.length,
        });

        for await (const part of remoteSource(entry.client, transfer, input, signal, entry.sources))
          yield create(ui.DiagnosticsLogPartSchema, { ...part, sequence: sequence++ });
      }

      for (const source of LOG_SOURCES)
        if (source !== "worker" && !available.has(source))
          yield create(ui.DiagnosticsLogPartSchema, {
            sequence: sequence++,
            coverage: { source, status: "not_available" },
          });

      for (let index = 0; index < workers.length; index++) {
        const connection = this.core.link.connections.get(workers[index]!.id);

        if (!connection?.hello.capabilities.includes("diagnostics_logs_v1")) {
          yield create(ui.DiagnosticsLogPartSchema, {
            sequence: sequence++,
            coverage: { source: "worker", worker: index + 1, status: connection ? "unsupported" : "offline" },
          });
          continue;
        }

        const input = create(ui.DiagnosticsHomeLogsRequestSchema, { ...request, budgetBytes: unit });

        for await (const part of remoteSource(connection.logSource, transfer, input, signal, ["worker"])) {
          if (part.coverage) part.coverage.worker = index + 1;
          yield create(ui.DiagnosticsLogPartSchema, { ...part, sequence: sequence++ });
        }
      }

      yield create(ui.DiagnosticsLogPartSchema, { sequence: sequence++, end: true });
      await this.core.diagnostics.logs.audit(request.actionId, "home_done", request.hours, 0);
    } finally {
      abort.abort();
      await local.close();
      await rm(directory, { recursive: true, force: true });
      this.active.delete(origin);
    }
  }

  revoke(origin: string) {
    this.active.get(origin)?.abort();
  }
  close() {
    for (const abort of this.active.values()) abort.abort();
    this.registered.close();
  }
}

export function validateHomeLogRequest(request: ui.DiagnosticsHomeLogsRequest) {
  if (
    !/^[a-f0-9-]{36}$/.test(request.actionId) ||
    ![1, 6, 24].includes(request.hours) ||
    request.budgetBytes > LOG_LIMITS.home ||
    request.budgetBytes < 1
  )
    throw new ConnectError("Choose a log range and a bounded export", Code.InvalidArgument);
}

async function* pullSource(
  receive: (command: ui.DiagnosticsLogSourceCommand) => Promise<ui.DiagnosticsLogPart>,
  transfer: string,
  begin: ui.DiagnosticsHomeLogsRequest,
  signal: AbortSignal,
) {
  let sequence = 0;

  while (true) {
    signal.throwIfAborted();

    const part = await receive(
      create(ui.DiagnosticsLogSourceCommandSchema, {
        requestId: crypto.randomUUID(),
        transferId: transfer,
        begin: sequence ? undefined : begin,
      }),
    );

    if (part.end) return;

    if (part.sequence !== sequence++) throw new ConnectError("Invalid log source sequence", Code.DataLoss);
    yield part;
  }
}

async function* remoteSource(
  client: LogPullClient,
  transfer: string,
  begin: ui.DiagnosticsHomeLogsRequest,
  signal: AbortSignal,
  allowed: string[],
) {
  let sequence = 0;
  let bytes = 0;
  let sourceBytes = 0;
  let expectedBytes = 0n;
  const seen = new Set<string>();

  try {
    while (true) {
      const part = await client.next(transfer, signal, sequence ? undefined : begin);

      if (part.end) {
        if (BigInt(sourceBytes) !== expectedBytes || seen.size !== allowed.length)
          throw new ConnectError("Log source transfer ended early", Code.DataLoss);

        return;
      }

      if (part.sequence !== sequence++ || part.data.length > LOG_LIMITS.chunk)
        throw new ConnectError("Invalid log source chunk", Code.DataLoss);

      if (part.coverage) {
        if (
          BigInt(sourceBytes) !== expectedBytes ||
          !allowed.includes(part.coverage.source) ||
          seen.has(part.coverage.source) ||
          part.data.length ||
          part.coverage.bytes > BigInt(LOG_LIMITS.source)
        )
          throw new ConnectError("Unexpected log source", Code.DataLoss);
        seen.add(part.coverage.source);
        sourceBytes = 0;
        expectedBytes = part.coverage.bytes;
      } else if (!seen.size || logChecksum(part.data) !== part.checksum)
        throw new ConnectError("Invalid log source checksum", Code.DataLoss);
      bytes += part.data.length;
      sourceBytes += part.data.length;

      if (bytes > begin.budgetBytes || sourceBytes > LOG_LIMITS.source)
        throw new ConnectError("Log source exceeded its budget", Code.ResourceExhausted);
      yield part;
    }
  } catch {
    signal.throwIfAborted();

    // A started source may be incomplete. Propagate so the archive marks its entry truncated.
    if (seen.size) throw new ConnectError("Log source transfer ended early", Code.DataLoss);

    for (const source of allowed)
      if (!seen.has(source))
        yield create(ui.DiagnosticsLogPartSchema, { coverage: { source, status: "not_available" } });
  } finally {
    client.cancel(transfer);
  }
}

import { join } from "node:path";
import { ui } from "@canopy/contracts";
import { Logs, registeredLogs, LOG_SOURCES, logChecksum } from "@canopy/logs";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

/** Identical fixed source state in both members; seeded outside measured intervals. */
export async function benchLogSources() {
  if (process.env["CANOPY_BENCH_STAGE"] !== "5") return {};
  const root = process.env["CANOPY_BENCH_STATE_DIR"];

  if (!root) throw new Error("Log workload needs fresh member state");
  const directory = join(root, "gateway-logs");
  const logs = new Logs(directory);

  for (const source of LOG_SOURCES) {
    const record = `${new Date().toISOString()} worker connected synthetic ${"x".repeat(512)}\n`;
    // 4 MiB/source, large enough to exercise redaction, tail budgets and disk ZIP writes.
    await Bun.write(join(directory, `${source}.log`), record.repeat(Math.floor((4 * 1024 * 1024) / record.length)));
  }

  const enabled = process.env["CANOPY_BENCH_DIAGNOSTICS"] === "1";

  const timer = setInterval(() => {
    for (const source of LOG_SOURCES) if (enabled) logs.write(source, "health check completed");
  }, 1000);

  timer.unref();

  return { logSources: registeredLogs(directory, LOG_SOURCES), diagnosticsLogDirectory: root };
}

/** One explicit action under concurrent RPC/worker load; no ZIP buffering in the driver. */
export async function benchLogExport(api: Client<typeof ui.GatewayService>, signal: AbortSignal) {
  const start = performance.now();
  const enabled = process.env["CANOPY_BENCH_DIAGNOSTICS"] === "1" && process.env["CANOPY_BENCH_CONTROL"] !== "1";

  try {
    let job = await api.collectDiagnosticsLogs(
      {
        actionId: crypto.randomUUID(),
        computerIds: ["local"],
        hours: 1,
        aliasHome: true,
      },
      { signal },
    );

    if (!enabled) throw new Error("Disabled log collection unexpectedly admitted an export");

    while (job.status === "collecting") {
      await Bun.sleep(200);
      signal.throwIfAborted();
      job = await api.getDiagnosticsLogsJob({ jobId: job.jobId }, { signal });

      if (performance.now() - start > 60_000) throw new Error("Log workload exceeded home deadline");
    }

    if (!["done", "partial"].includes(job.status)) throw new Error("Log workload did not produce an archive");
    let bytes = 0;
    let sequence = 0;
    let ended = false;

    for await (const part of api.downloadDiagnosticsLogs({ jobId: job.jobId }, { signal })) {
      if (part.sequence !== sequence++) throw new Error("Log download sequence mismatch");

      if (part.end) {
        ended = true;
        break;
      }

      if (logChecksum(part.data) !== part.checksum) throw new Error("Log download checksum mismatch");
      bytes += part.data.length;
    }

    if (!ended || BigInt(bytes) !== job.bytes) throw new Error("Log workload download incomplete");
    console.info(
      JSON.stringify({ phase: "log_action", bytes, elapsedMs: performance.now() - start, status: job.status }),
    );
    await api.cancelDiagnosticsLogs({ jobId: job.jobId }, { signal });
  } catch (error) {
    if (enabled || !(error instanceof ConnectError) || error.code !== Code.Unimplemented) throw error;
    console.info(
      JSON.stringify({ phase: "log_action", bytes: 0, elapsedMs: performance.now() - start, status: "disabled" }),
    );
  }
}

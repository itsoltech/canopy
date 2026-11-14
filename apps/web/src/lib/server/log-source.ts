import type { Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import {
  LogExporter,
  LogPullSource,
  installLogWriter,
  runtimeLogDirectory,
  registeredLogs,
  cleanLogSpool,
} from "@canopy/logs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

let started = false;

/**
 * Service-token only source registration. Remote paired desktop BFFs never register at another home. A web inside
 * the gateway process writes through the gateway's own log writer.
 */
export function startBffLogs(api: Client<typeof ui.GatewayService>) {
  if (
    started ||
    process.env["CANOPY_DESKTOP_CLIENT_TOKEN"] ||
    process.env["CANOPY_LOG_SUPERVISED"] === "1" ||
    process.env["CANOPY_WEB_IN_PROCESS"] === "1"
  )
    return;
  started = true;
  const directory = runtimeLogDirectory("web");
  installLogWriter("web", directory, [process.env["GATEWAY_SERVICE_TOKEN"] ?? ""]);

  const source = new LogPullSource(
    new LogExporter(registeredLogs(directory, ["web"])),
    join(dirname(directory), "diagnostics-log-spool", "web"),
  );

  const abort = new AbortController();
  process.once("beforeExit", () => {
    abort.abort();
    void source.close();
  });
  void (async () => {
    await cleanLogSpool(dirname(directory));

    while (!abort.signal.aborted) {
      const session = randomBytes(32).toString("base64url");

      try {
        for await (const command of api.watchDiagnosticsLogSource(
          { session, sources: ["web"] },
          { signal: abort.signal, timeoutMs: 0 },
        )) {
          if (command.session !== session) break;
          const part = await source.receive(command);

          const receipt = await api.replyDiagnosticsLogSource(
            { session, requestId: command.requestId, part },
            { signal: abort.signal, timeoutMs: 15_000 },
          );

          if (!receipt.accepted && !command.cancel) break;
        }
      } catch {
        /* Reconnect registers a new identity; never replay log bytes. */
      } finally {
        await source.close();
      }

      await delay(5000, undefined, { signal: abort.signal, ref: false }).catch(() => {});
    }
  })().catch(() => {});
}

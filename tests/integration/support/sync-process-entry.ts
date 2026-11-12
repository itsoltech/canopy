import { Schema } from "effect";
import { toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { syncMetrics } from "@canopy/transport";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { mountMobileNetwork } from "../../../apps/gateway/src/network/devices.ts";
import { isolatedGatewayTransport } from "../../../apps/web/src/lib/server/gateway-transport.ts";
import { sseResponse } from "../../../apps/web/src/lib/server/sse.ts";
import { coalesceDeltas } from "../../../apps/web/src/lib/server/coalesce.ts";
import { Control } from "./sync-process.ts";
import { scenarioComputer, scenarioMirror } from "./sync-scenario.ts";
import { syncActivity } from "./sync-activity.ts";
import { SERVICE_TOKEN } from "./gateway.ts";

async function main() {
  const role = process.env["CANOPY_SYNC_ROLE"];

  const computer =
    role === "bff"
      ? undefined
      : await scenarioComputer(false, process.env["CANOPY_SYNC_MEMORY"] === "1" ? 100 : undefined);

  const memory =
    process.env["CANOPY_SYNC_MEMORY"] === "1" && computer
      ? new (await import("./sync-memory-scenario.ts")).SyncMemoryScenario(computer)
      : undefined;

  const abort = new AbortController();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let start = process.cpuUsage();
  let elapsed = performance.now();
  let unmount: (() => void) | undefined;
  let reading: Promise<void> | undefined;
  let stop!: () => void;

  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });

  const node = computer?.links.hello().nodeId ?? "";

  const info = () =>
    JSON.stringify({
      url: computer!.gateway.grpcUrl,
      address: computer!.links.addresses[0] ?? "",
      node,
      threads: computer!.threads,
    });

  async function execute(command: Control) {
    switch (command.action) {
      case "info":
        return info();
      case "invitation":
        return (await computer!.links.createPairing()).code;
      case "pair":
        await computer!.links.pair(command.url, command.code);

        return "";
      case "mobile":
        unmount = mountMobileNetwork(computer!.gateway.core, computer!.links.options.network, SERVICE_TOKEN);

        return JSON.stringify(computer!.gateway.core.mobile.networkRoutes());
      case "stream":
        await syncActivity(computer!.gateway, computer!.threads[0]!);

        return "";
      case "restart":
        await computer!.restart();

        return info();
      case "attach":
        await computer!.attach();

        return "";
      case "mirror":
        await scenarioMirror(computer!, command.node, command.threads[0]!, command.code || "Offline change");

        return "";
      case "begin":
        syncMetrics?.reset();
        delay.reset();
        delay.enable();
        start = process.cpuUsage();
        elapsed = performance.now();

        return "";
      case "end": {
        const cpu = process.cpuUsage(start);
        delay.disable();

        return JSON.stringify({
          cpuMicros: cpu.user + cpu.system,
          elapsedMs: performance.now() - elapsed,
          eventLoopP99Ms: delay.percentile(99) / 1e6,
          eventLoopMaxMs: delay.max / 1e6,
          metrics: syncMetrics?.snapshot(),
        });
      }

      case "watch": {
        const api = createClient(
          ui.GatewayService,
          isolatedGatewayTransport(() =>
            createGrpcTransport({
              baseUrl: command.url,
              interceptors: [
                (next) => (request) => {
                  request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

                  return next(request);
                },
              ],
            }),
          ),
        );

        const response = sseResponse(
          new Request("http://localhost/events", { signal: abort.signal }),
          (signal) => coalesceDeltas(api.watchThread({ threadId: command.threads[0]!, incremental: true }, { signal })),
          (value) => toJson(ui.ThreadUpdateSchema, value),
        );

        reading = (async () => {
          try {
            for await (const _ of response.body!) {
              /* drain browser */
            }
          } catch {
            /* cancellation */
          }
        })();

        return "";
      }

      case "stop":
        stop();

        return "";
      default:
        if (!memory) throw new Error("Memory scenario is not enabled");

        return memory.execute(command);
    }
  }

  const receive = (command: Control) => {
    void execute(command).then(
      (payload) => process.send?.({ id: command.id, ok: true, payload }),
      (cause) => process.send?.({ id: command.id, ok: false, payload: String(cause) }),
    );
  };

  const boundary = Schema.decodeUnknownSync(Control);
  const onMessage = (message: Control) => receive(boundary(message));
  process.on("message", onMessage);
  process.send?.({ id: 0, ok: true, payload: "" });

  try {
    await stopped;
  } finally {
    process.off("message", onMessage);
    abort.abort();
    delay.disable();
    await reading;
    await memory?.release();
    unmount?.();
    await computer?.close();
    process.disconnect?.();
  }
}

await main();

process.exit(0);

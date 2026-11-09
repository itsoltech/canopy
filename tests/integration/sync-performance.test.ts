import { expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { syncMetrics } from "@canopy/transport";
import { qualifyId } from "@canopy/domain/computers";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { sseResponse } from "../../apps/web/src/lib/server/sse.ts";
import { coalesceDeltas } from "../../apps/web/src/lib/server/coalesce.ts";
import { toJson } from "@bufbuild/protobuf";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN } from "./support/gateway.ts";
import { syncActivity } from "./support/sync-activity.ts";
import { remoteThread, scenarioComputer, scenarioMirror, scenarioWatch } from "./support/sync-scenario.ts";

/** Explicit benchmark, never part of the default test run. Prints counters, never payloads or ids. */
test.skipIf(!dockerAvailable || process.env["CANOPY_SYNC_BENCH"] !== "1")(
  "sync protocol scenario",
  async () => {
    const legacy = process.env["CANOPY_SYNC_LEGACY"] === "1";
    const a = await scenarioComputer(legacy);
    const b = await scenarioComputer(legacy);
    const abort = new AbortController();
    const readers: Promise<void>[] = [];
    let unmount: (() => void) | undefined;

    try {
      const pairing = await a.links.createPairing();
      await b.links.pair(a.links.addresses[0]!, pairing.code);
      const nodeA = a.links.hello().nodeId;
      const nodeB = b.links.hello().nodeId;
      await scenarioMirror(a, nodeB, b.threads[0]!, "Scenario 0");
      await scenarioMirror(b, nodeA, a.threads[0]!, "Scenario 0");
      unmount = mountMobileNetwork(a.gateway.core, a.links.options.network, SERVICE_TOKEN);
      const connection = a.gateway.core.mobile.networkRoutes();
      const transport = nodePinnedTransport();
      const invitation = await a.gateway.api.createMobilePairing({});

      const paired = await routedMobileClient({ connection, transport }).pairing.exchangeMobilePairing({
        code: invitation.code,
        name: "Sync scenario",
        platform: "android",
      });

      const phone = routedMobileClient({ connection, transport, token: paired.deviceToken });

      const views = [];

      for (const [local, home, node] of [
        [a, b, nodeB],
        [b, a, nodeA],
      ] as const) {
        for (const id of home.threads) {
          const view = scenarioWatch(remoteThread(local.gateway, node, id, abort.signal));
          readers.push(view.done);
          views.push(view);
        }
      }

      await views[0]!.until("Scenario 0");
      const activeId = b.threads[0]!;

      const phoneView = scenarioWatch(
        observePhone(
          phone.api.watchThread(
            { threadId: qualifyId(activeId, nodeB), incremental: true, pageSize: 24 },
            { signal: abort.signal },
          ),
        ),
      );

      readers.push(phoneView.done);

      // Use the exact BFF SSE bridge and coalescer without a browser or a listening web server.
      const sse = sseResponse(
        new Request("http://localhost/events", { signal: abort.signal }),
        (signal) => coalesceDeltas(remoteThread(a.gateway, nodeB, activeId, signal)),
        (value) => toJson(ui.ThreadUpdateSchema, value),
      );

      readers.push(consume(sse.body!));

      for (const gateway of [a.gateway, b.gateway])
        readers.push(
          (async () => {
            try {
              for await (const _ of gateway.api.watchOverview({ includeSnapshot: true }, { signal: abort.signal })) {
                /* sidebar open */
              }
            } catch {
              /* scenario shutdown */
            }
          })(),
        );
      await phoneView.until("Scenario 0");
      await Bun.sleep(500);
      syncMetrics?.reset();
      const started = performance.now();
      const cpuStarted = process.cpuUsage();
      await syncActivity(b.gateway, activeId);
      const changed = performance.now();
      await b.gateway.api.updateThread({ threadId: activeId, title: "Streaming complete" });
      await views[0]!.until("Streaming complete");
      await phoneView.until("Streaming complete");
      const consistencyMs = performance.now() - changed;
      const streaming = syncMetrics?.snapshot();
      const streamMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStarted);
      abort.abort();
      await Promise.all(readers);
      unmount();
      unmount = undefined;
      await b.restart();
      await b.gateway.api.updateThread({ threadId: activeId, title: "Offline change" });
      syncMetrics?.reset();
      const reconnected = performance.now();
      await b.attach();
      await scenarioMirror(a, nodeB, activeId, "Offline change");
      const reconnectMs = performance.now() - reconnected;
      const catchup = syncMetrics?.snapshot();
      const resumeAbort = new AbortController();
      const resumed = scenarioWatch(remoteThread(a.gateway, nodeB, activeId, resumeAbort.signal));
      await resumed.until("Offline change");
      resumeAbort.abort();
      await resumed.done;
      expect(resumed.state?.thread?.title).toBe("Offline change");
      console.log(
        "CANOPY_SYNC_BENCH",
        JSON.stringify({
          legacy,
          streaming,
          streamMs,
          consistencyMs,
          processCpuMicros: cpu.user + cpu.system,
          reconnectMs,
          catchup,
        }),
      );
    } finally {
      abort.abort();
      await Promise.allSettled(readers);
      unmount?.();
      await b.close();
      await a.close();
    }
  },
  120_000,
);

async function* observePhone(source: AsyncIterable<ui.ThreadUpdate>) {
  for await (const update of source) {
    syncMetrics?.record("phone.protobuf", toBinary(ui.ThreadUpdateSchema, update).length, 0, update.change.case);
    yield update;
  }
}

async function consume(body: ReadableStream<Uint8Array>) {
  try {
    for await (const _ of body) {
      /* drain the browser transport */
    }
  } catch {
    /* scenario shutdown */
  }
}

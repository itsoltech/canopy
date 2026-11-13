import { expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { QueryCache } from "@canopy/domain/shared-query";
import { OverviewInvalidation } from "@canopy/domain/shared-query-events";
import { DATABASE_FAMILIES, databaseMetric, measureKey } from "@canopy/domain/diagnostics";
import { remoteServe, sharedHost, uiHandlers, uiRoutes } from "@canopy/gateway/api";
import { startConnectHttpServer } from "@canopy/transport";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";
import { mobileClient } from "../../apps/mobile/src/api/client.ts";
import { sseResponse } from "../../apps/web/src/lib/server/sse.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

function measureGateway(gateway: TestGateway) {
  const collector = gateway.core.diagnostics.collector;
  collector.tick();
  const droppedBeforeRead = collector.budget.dropped;
  const view = rpcSnapshot(collector, 15);
  const trace = collector.tracing.export(collector.tracing.state().leaseId);

  const families = Object.fromEntries(
    DATABASE_FAMILIES.map((family) => {
      const key = measureKey(databaseMetric(family.name, "execute"));
      const count = collector.minutes.slots.reduce((sum, slot) => sum + (slot?.measures?.get(key)?.events ?? 0n), 0n);

      return [family.name, Number(count)];
    }),
  );

  return {
    calls: Object.fromEntries(view.calls.map((row) => [`${row.layer}:${row.method}`, Number(row.started)])),
    families,
    queries: Number(view.gatewayMeasures.find((row) => row.metricId === 11)?.events ?? 0),
    unclassified: Number(view.gatewayMeasures.find((row) => row.metricId === 10)?.events ?? 0),
    dropped: collector.budget.dropped,
    bytes: collector.budget.used,
    databaseBytes: collector.databaseBudget.used,
    measureBytes: collector.measureBudget.used,
    readDrops: collector.budget.dropped - droppedBeforeRead,
    minuteLabels: collector.minutes.slots.flatMap((slot) => (slot ? [slot.measures?.size ?? 0] : [])),
    traceSpans: trace?.spans.length,
    traceDropped: trace ? Number(trace.droppedSamples) : undefined,
  };
}

// Opt-in paired workload, not a UI test. Run the same file against each revision.
test.skipIf(!dockerAvailable || process.env["CANOPY_CHATTER_BENCH"] !== "1")(
  "idle desktop SSE, mobile Connect and a linked computer share bounded background work",
  async () => {
    const a = await startTestGateway({ role: "desktop", diagnostics: true });
    const b = await startTestGateway({ role: "desktop", diagnostics: true });

    const attach = (gateway: typeof a) => {
      const handlers = uiHandlers(gateway.core);

      const computers = linkedComputers({
        store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
        core: gateway.core,
        shared: sharedHost(gateway.core, handlers),
        serve: remoteServe(handlers, gateway.core),
        host: "127.0.0.1",
      });

      gateway.core.computers = computers;
      gateway.core.network = computers.options.network;

      return computers;
    };

    const local = attach(a);
    const home = attach(b);
    const abort = new AbortController();
    const tasks: Promise<void>[] = [];
    const caches: QueryCache[] = [];

    const http = await startConnectHttpServer({
      routes: uiRoutes(a.core),
      interceptors: [a.core.diagnostics.interceptor],
    });

    const phone = mobileClient({ gatewayUrl: http.url, development: true, fetch }).api;

    try {
      const threads: string[] = [];

      for (const gateway of [a, b]) {
        const project = (await gateway.api.createProject({ name: "Chatter fixture" })).project!.id;

        const workspace = (
          await gateway.api.createWorkspace({
            projectId: project,
            workerId: gateway.workerId,
            rootPath: "/repo/chatter",
          })
        ).workspace!.id;

        for (let n = 0; n < 12; n++)
          threads.push(
            (await gateway.api.createThread({ projectId: project, workspaceId: workspace, provider: Provider.CODEX }))
              .thread!.id,
          );
      }

      await local.start();
      await home.start();
      await home.pair(local.addresses[0]!, (await local.createPairing()).code);
      expect(await eventually(async () => local.reachable().includes(home.hello().nodeId), Boolean, 15_000)).toBe(true);

      for (const gateway of [a, b]) {
        if (process.env["CANOPY_CHATTER_COLLECT"] === "0") gateway.core.diagnostics.resources.start();
        else await gateway.core.diagnostics.start();
      }

      if (process.env["CANOPY_CHATTER_TRACE"] === "1")
        for (const gateway of [a, b])
          gateway.core.diagnostics.collector.tracing.start(crypto.randomUUID(), "gateway", 1);
      a.core.bots.start();
      b.core.bots.start();

      for (const api of [a.api, phone]) {
        const queries = new QueryCache();
        caches.push(queries);
        queries.watch(
          "GetComputers",
          () => api.getComputers({}),
          () => {},
        );
        const invalidation = new OverviewInvalidation(queries);
        tasks.push(
          (async () => {
            for await (const update of api.watchOverview({ includeSnapshot: true }, { signal: abort.signal })) {
              if (update.change.case === "mobileSnapshot")
                invalidation.synced(update.change.value.overview?.workers ?? [], false);
              invalidation.apply(update);
            }
          })(),
        );
      }

      const response = sseResponse(
        new Request("http://localhost/chatter", { signal: abort.signal }),
        (signal) => a.api.watchThread({ threadId: threads[0]!, sequence: true }, { signal }),
        (value) => toJson(ui.ThreadUpdateSchema, value),
      );

      tasks.push(response.body!.pipeTo(new WritableStream({ write() {} }), { signal: abort.signal }));
      tasks.push(
        (async () => {
          for await (const _ of phone.watchThread(
            { threadId: threads[0]!, sequence: true },
            { signal: abort.signal },
          )) {
            // Consume exactly as a foreground phone, without native rendering.
          }
        })(),
      );

      for (const task of tasks) void task.catch(() => {});
      await Bun.sleep(5000);

      const measure = () => [a, b].map(measureGateway);

      const before = measure();
      const seconds = Number(process.env["CANOPY_CHATTER_SECONDS"] ?? 30);
      await Bun.sleep(seconds * 1000);
      const after = measure();
      console.info(JSON.stringify({ seconds, before, after }));
      expect((await phone.getOverview({})).workers.length).toBeGreaterThanOrEqual(2);
    } finally {
      abort.abort();

      for (const cache of caches) cache.dispose();
      await Promise.allSettled(tasks);
      await http.close();
      await Promise.allSettled([local.close(), home.close()]);
      await a.close();
      await b.close();
    }
  },
  120_000,
);

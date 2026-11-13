import { expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { governorMetric } from "@canopy/domain/diagnostics";
import { tempDir } from "@canopy/testing";
import { uiRoutes } from "@canopy/gateway/api";
import { startConnectHttpServer } from "@canopy/transport";
import { mobileClient } from "../../apps/mobile/src/api/client.ts";
import { sseResponse } from "../../apps/web/src/lib/server/sse.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";
import { linkedProjectFixture } from "./support/linked-projects.ts";

test.skipIf(!dockerAvailable || process.env["CANOPY_CHATTER_BENCH"] !== "1")(
  "overview refreshes reuse real worker Git origins across the old TTL",
  async () => {
    const fixture = await linkedProjectFixture(tempDir("canopy-origin-chatter-"), { diagnostics: true });
    const { a, b } = fixture;

    const http = await startConnectHttpServer({
      routes: uiRoutes(a.gw.core),
      interceptors: [a.gw.core.diagnostics.interceptor],
    });

    const phone = mobileClient({ gatewayUrl: http.url, development: true, fetch }).api;
    const abort = new AbortController();

    const response = sseResponse(
      new Request("http://localhost/origins", { signal: abort.signal }),
      (signal) => a.gw.api.watchOverview({}, { signal }),
      (value) => toJson(ui.OverviewUpdateSchema, value),
    );

    const desktop = response.body!.pipeTo(new WritableStream({ write() {} }), { signal: abort.signal });

    const mobile = (async () => {
      for await (const _ of phone.watchOverview({}, { signal: abort.signal })) {
        /* consume */
      }
    })();

    void desktop.catch(() => {});
    void mobile.catch(() => {});

    try {
      await a.gw.core.diagnostics.start();
      await b.gw.core.diagnostics.start();

      const measure = () =>
        [a, b].map(({ gw }) => {
          gw.core.diagnostics.collector.tick();
          const view = rpcSnapshot(gw.core.diagnostics.collector, 15);

          return {
            origins: Number(
              view.calls.find((row) => row.method === "worker.command/readWorkspaceOrigin")?.started ?? 0,
            ),
            git: Number(
              view.gatewayMeasures.find((row) => row.metricId === governorMetric("git", "user", "execution"))?.events ??
                0,
            ),
            queries: Number(view.gatewayMeasures.find((row) => row.metricId === 11)?.events ?? 0),
          };
        });

      const before = measure();
      const seconds = Number(process.env["CANOPY_CHATTER_SECONDS"] ?? 65);
      const end = Date.now() + seconds * 1000;

      while (Date.now() < end) {
        const [desktopView, mobileView] = await Promise.all([a.gw.api.getOverview({}), phone.getOverview({})]);
        expect(desktopView.projects.some((p) => p.workspaces.some((w) => w.gitOrigin))).toBe(true);
        expect(mobileView.projects.some((p) => p.workspaces.some((w) => w.gitOrigin))).toBe(true);
        await Bun.sleep(Math.min(2000, Math.max(0, end - Date.now())));
      }

      console.info(JSON.stringify({ seconds, before, after: measure() }));
    } finally {
      abort.abort();
      await Promise.allSettled([desktop, mobile]);
      await http.close();
      await fixture.close();
    }
  },
  150_000,
);

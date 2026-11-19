import { expect, test } from "bun:test";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { CLAUDE_PROXY_MODEL } from "./fixtures/claude-proxy.ts";
import { eventually } from "./support/gateway.ts";
import { startInstanceFixture } from "./support/instance-fixture.ts";

function proxyFixture() {
  const requests: string[] = [];
  let failDiscovery = false;

  const bind = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        if (request.headers.get("authorization") !== "Bearer fixture-proxy-key")
          return new Response(null, { status: 401 });

        switch (new URL(request.url).pathname) {
          case "/route/v1/models": {
            if (failDiscovery && request.headers.has("x-fixture-discovery")) {
              failDiscovery = false;

              return new Response(null, { status: 503 });
            }

            return Response.json({ data: [{ id: CLAUDE_PROXY_MODEL, supported_endpoint_types: ["messages"] }] });
          }

          case "/route/v1/messages":
            requests.push(await request.text());

            return Response.json({});
          default:
            return new Response(null, { status: 404 });
        }
      },
    });

  let server = bind(0);
  const port = server.port!;

  return {
    requests,
    baseUrl: `${server.url.origin}/route`,
    stop: () => server.stop(true),
    restore: (failFirstDiscovery = false) => {
      failDiscovery = failFirstDiscovery;
      server = bind(port);
    },
  };
}

test.skipIf(!dockerAvailable).each([
  { recovery: "after startup discovery", duringDiscovery: false },
  { recovery: "between Claude and worker discovery", duringDiscovery: true },
])(
  "Retry runs once through the saved proxy when it recovers $recovery",
  async ({ duringDiscovery }) => {
    const f = await startInstanceFixture();
    let proxy: ReturnType<typeof proxyFixture> | undefined;

    const catalog = async (refresh = false) =>
      (await f.gw.api.listModels({ workerId: f.workerId, unfiltered: true, refresh })).workers[0]?.profiles.find(
        (p) => p.provider === Provider.CLAUDE && p.profileId === "native",
      );

    const offersModel = (p: Awaited<ReturnType<typeof catalog>>) =>
      p?.models.some((m) => m.id === CLAUDE_PROXY_MODEL) ?? false;

    try {
      proxy = proxyFixture();
      await f.gw.api.saveProxy({
        id: f.proxy.id,
        name: f.proxy.name,
        kind: f.proxy.kind,
        baseUrl: proxy.baseUrl,
      });
      await f.save(Provider.CLAUDE, "recovery", ProviderProfileKind.CLIPROXYAPI, "native", false, [
        { name: "FIXTURE_CLAUDE_PROXY", value: "1" },
      ]);
      expect(await eventually(catalog, offersModel)).toMatchObject({ detail: "" });
      const thread = await f.thread(Provider.CLAUDE);
      await f.gw.api.updateThread({ threadId: thread.id, model: CLAUDE_PROXY_MODEL });
      const initial = await f.send(thread.id, "Start working");
      expect((await f.finished(thread.id, initial.id)).status).toBe("completed");

      await proxy.stop();
      const original = await f.send(thread.id, "Keep working");
      expect(await f.finished(thread.id, original.id)).toMatchObject({ status: "failed", errorClass: "network" });

      if (duringDiscovery) proxy.restore(true);
      await f.restartWorker();
      const offline = await eventually(catalog, (p) => !!p?.models.length && !offersModel(p));
      expect(offline?.models.map((m) => m.id)).toEqual(["default"]);

      if (!duringDiscovery) proxy.restore();
      const request = { threadId: thread.id, text: "Continue", clientRequestId: "retry" };
      const pending = [f.gw.api.sendMessage(request), f.gw.api.sendMessage(request)] as const;
      const [first, duplicate] = await Promise.all(pending).finally(() => Promise.allSettled(pending));
      expect(first.turn?.id).toBe(duplicate.turn?.id);
      expect(await f.finished(thread.id, first.turn!.id)).toMatchObject({
        status: "completed",
        model: CLAUDE_PROXY_MODEL,
      });
      const expectedRequest = JSON.stringify({ model: CLAUDE_PROXY_MODEL });
      expect(proxy.requests).toEqual([expectedRequest, expectedRequest]);
      expect(offline?.detail).toBeTruthy();

      const refreshed = await catalog(true);
      expect(refreshed?.detail).toBe("");
      expect(offersModel(refreshed)).toBe(true);
    } finally {
      try {
        await f.close();
      } finally {
        await proxy?.stop();
      }
    }
  },
  60_000,
);

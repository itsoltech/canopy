import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

/** One client's overview stream, collecting updates for the test to wait on. */
function subscriber(gw: TestGateway) {
  const abort = new AbortController();
  const updates: ui.OverviewUpdate[] = [];
  const waiters = new Set<() => void>();

  void (async () => {
    try {
      for await (const update of gw.api.watchOverview({}, { signal: abort.signal })) {
        updates.push(update);

        for (const wake of waiters) wake();
      }
    } catch {
      /* closed by the test */
    }
  })();

  async function next<C extends ui.OverviewUpdate["change"]["case"]>(
    kind: C,
    match: (update: ui.OverviewUpdate) => boolean = () => true,
    timeoutMs = 5000,
  ) {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const found = updates.findIndex((update) => update.change.case === kind && match(update));

      if (found >= 0) return updates.splice(found, 1)[0]!;

      if (Date.now() > deadline) throw new Error(`No ${kind} within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiters.delete(wake);
          resolve();
        };

        waiters.add(wake);
        setTimeout(wake, 100);
      });
    }
  }

  return { updates, next, close: () => abort.abort() };
}

describe.skipIf(!dockerAvailable)("pushed bot, connector and proxy changes", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  test("a stream announces what it pushes, and bot changes from another client arrive without ListBots", async () => {
    const watcher = subscriber(gw);
    const feeds = await watcher.next("feeds");

    if (feeds.change.case === "feeds") expect(feeds.change.value.pushed).toEqual(["bots", "connectors", "proxies"]);
    // Let the feed take its baseline.
    await Bun.sleep(300);

    const bot = (
      await gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: "Pushed bot",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          workerId: gw.workerId,
        },
      })
    ).bot!;

    const created = await watcher.next("bot", (u) => u.change.case === "bot" && u.change.value.id === bot.id, 2000);
    expect(created.change.case === "bot" && created.change.value.configuration?.name).toBe("Pushed bot");

    await gw.api.archiveBot({ botId: bot.id });
    const archived = await watcher.next("bot", (u) => u.change.case === "bot" && u.change.value.id === bot.id, 2000);
    expect(archived.change.case === "bot" && archived.change.value.archived).toBe(true);

    // A write by the scheduler or another gateway instance reaches the stream through the bot journal.
    await gw.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE bots SET archived_at = NULL WHERE id = ${bot.id}::uuid`),
    );
    const restored = await watcher.next("bot", (u) => u.change.case === "bot" && u.change.value.id === bot.id, 5000);
    expect(restored.change.case === "bot" && restored.change.value.archived).toBe(false);

    await gw.api.deleteBot({ botId: bot.id });
    await watcher.next("botRemoved", (u) => u.change.case === "botRemoved" && u.change.value === bot.id, 2000);
    watcher.close();
  }, 20_000);

  test("connector and proxy writes invalidate both lists for every subscriber", async () => {
    const watchers = [subscriber(gw), subscriber(gw)];
    using _closing = { [Symbol.dispose]: () => watchers.forEach((w) => w.close()) };
    await Promise.all(watchers.map((w) => w.next("feeds")));
    await Bun.sleep(300);

    await gw.api.saveConnectorAccount({
      connectorType: "custom",
      name: "Pushed connector",
      url: "https://example.com/mcp",
      authKind: "headers",
      transport: "http",
    });
    await Promise.all(watchers.map((w) => w.next("connectorsChanged", () => true, 2000)));

    await gw.api.saveProxy({
      name: "Pushed proxy",
      kind: "cliproxyapi",
      baseUrl: "https://proxy.example/v1/",
      secret: "test-only-proxy-key",
    });
    await Promise.all(watchers.map((w) => w.next("proxiesChanged", () => true, 2000)));
  }, 20_000);

  test("an idle stream sends no bot, connector or proxy updates", async () => {
    const watcher = subscriber(gw);
    await watcher.next("feeds");
    await Bun.sleep(4500);
    expect(
      watcher.updates.filter((u) =>
        ["bot", "botRemoved", "connectorsChanged", "proxiesChanged"].includes(u.change.case ?? ""),
      ),
    ).toEqual([]);
    watcher.close();
  }, 15_000);
});

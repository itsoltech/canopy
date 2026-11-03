/**
 * Live (OA_LIVE=1): a Claude bot created the way the wizard does it, with the instance's default model, replies
 * through CLIProxyAPI. The worker's real Claude catalog names that model `default` (a Claude Code alias the
 * Messages API refuses); CreateBot stores the concrete model it resolves to (the wizard offers that one too), and a
 * bot saved earlier with the alias is resolved at runtime.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();
const url = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const key = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["OA_LIVE"] !== "1" || !url || !key || !dockerAvailable)("a wizard-made Claude bot with the default model replies through live CLIProxyAPI", () => {
  let gw: TestGateway;
  let stopWorker = async () => {};
  const state = tempDir("oa-bots-alias-state-");
  beforeAll(async () => {
    gw = await startTestGateway();
    const worker = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ ownerUserId: gw.userId, name: "bots-alias-worker" })));
    await useLiveProxy(gw, worker.workerId, { url: url!, key: key!, allowedRoots: [tempDir("oa-bots-alias-repo-")], harnesses: [Provider.CLAUDE] });
    const runtime = ManagedRuntime.make(Journal.layer(join(state, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(state, "worker"), clientVersion: "bots-alias-live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: worker.credential, hello: { workerId: worker.workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stopWorker = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    await liveProxyReady(gw, worker.workerId, [Provider.CLAUDE]);
    gw.core.bots.start();
  }, 120_000);
  afterAll(async () => { await gw?.core.bots.stop(); await stopWorker(); await gw?.close(); });

  test("the default model resolves to the concrete API model, at creation and for a bot saved with the alias", async () => {
    // What the worker reports for the proxy: `default` with the model it resolves to.
    const catalogs = await eventually(async () => (await gw.api.listModels({})).workers,
      (workers) => workers.some((w) => w.profiles.some((p) => p.provider === Provider.CLAUDE && p.profileId === "cliproxyapi" && p.models.some((m) => m.id === "default" && m.resolvedModel))), 60_000);
    const resolved = catalogs.flatMap((w) => w.profiles).find((p) => p.profileId === "cliproxyapi" && p.provider === Provider.CLAUDE)!.models.find((m) => m.id === "default")!.resolvedModel;
    expect(resolved).toStartWith("claude-");
    console.info(`live: Claude default resolves to ${resolved}`);

    const bot = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: {
      name: "Kropek live", shape: "round", color: "#f97316", provider: Provider.CLAUDE, providerInstance: "cliproxyapi", model: "default", approvalPolicy: "safe",
    } })).bot!;
    expect(bot.configuration?.model).toBe(resolved);
    const ask = async (text: string) => {
      await gw.api.sendBotMessage({ botId: bot.id, text, clientRequestId: Bun.randomUUIDv7() });
      return eventually(() => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id)), (s) => !s.working, 120_000);
    };
    const first = await ask("Reply with exactly WIZARD_DEFAULT_OK");
    expect(first.messages.at(-1)).toMatchObject({ failed: false });
    expect(first.messages.at(-1)?.text).toContain("WIZARD_DEFAULT_OK");

    // A bot saved before the fix (like the stack's "Kropek") still names the alias.
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE bots SET configuration = jsonb_set(configuration, '{model}', '"default"') WHERE id = ${bot.id}::uuid`;
    }));
    const legacy = await ask("Reply with exactly LEGACY_ALIAS_OK");
    expect(legacy.messages.at(-1)).toMatchObject({ failed: false });
    expect(legacy.messages.at(-1)?.text).toContain("LEGACY_ALIAS_OK");
  }, 300_000);
});

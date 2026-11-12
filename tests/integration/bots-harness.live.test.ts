/** Opt-in inference through real official CLIs; the proxy is configured only behind those binaries. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const temp = tempDirs();
const url = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const key = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
  test.skipIf(process.env["CANOPY_LIVE"] !== "1" || !url || !key)(
    `${Provider[provider]} bot uses the official harness and Canopy MCP`,
    async () => {
      const gw = await startTestGateway();
      const dir = temp("canopy-bot-live-");
      const worker = await gw.addWorker("Bot live worker");
      const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
      const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test" });
      let closeLink = () => {};
      let serving: ReturnType<typeof serveLink> | undefined;

      try {
        await useLiveProxy(gw, worker.workerId, { url: url!, key: key!, allowedRoots: [], harnesses: [provider] });

        const link = await openGatewayLink({
          baseUrl: gw.grpcUrl,
          credential: worker.credential,
          hello: {
            workerId: worker.workerId,
            capabilities: ["bot_harness_v1", "bot_web_v1", "bot_workspace_v1"],
            ...(await runtime.runPromise(journalHello())),
          },
        });

        closeLink = () => link.close();
        serving = serveLink(link, host, runtime);
        await liveProxyReady(gw, worker.workerId, [provider]);

        const model =
          provider === Provider.CLAUDE
            ? (process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5")
            : (process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol");

        await gw.api.setInstanceModels({ harness: provider, id: "cliproxyapi", models: { custom: [model] } });

        const bot = (
          await gw.api.createBot({
            clientRequestId: crypto.randomUUID(),
            configuration: {
              name: "Live harness bot",
              shape: "round",
              color: "#22aaff",
              provider,
              providerInstance: "cliproxyapi",
              workerId: worker.workerId,
              model,
            },
          })
        ).bot!;

        gw.core.bots.start();
        await gw.api.sendBotMessage({
          botId: bot.id,
          clientRequestId: crypto.randomUUID(),
          text: "Call the Canopy list_projects tool once. Then reply with exactly HARNESS_BOT_OK. No other actions.",
        });

        const result = await eventually(
          () => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id)),
          (r) => !r.working,
          120_000,
        );

        expect(result.messages.at(-1)?.text).toContain("HARNESS_BOT_OK");

        const calls = await gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            return yield* sql`SELECT c.id FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id
            WHERE t.bot_id = ${bot.id}::uuid AND c.tool ->> 'name' = 'list_projects' AND c.status = 'completed'`;
          }),
        );

        expect(calls).toHaveLength(1);
      } finally {
        await host.close();
        closeLink();
        await serving;
        await runtime.dispose();
        await gw.close();
      }
    },
    180_000,
  );
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { bots, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();
const url = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const key = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["CANOPY_LIVE"] !== "1" || !url || !key || !dockerAvailable)("bots in the gateway through live CLIProxyAPI (both providers)", () => {
  let gw: TestGateway;
  let workerId = "";
  let projectId = "";
  let workspaceId = "";
  let stopWorker = async () => {};
  const state = tempDir("oa-bots-live-state-");
  const repo = tempDir("oa-bots-live-repo-");
  beforeAll(async () => {
    gw = await startTestGateway();
    const worker = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ ownerUserId: gw.userId, name: "bots-live-worker" })));
    workerId = worker.workerId;
    await useLiveProxy(gw, workerId, { url: url!, key: key!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(state, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(state, "worker"), clientVersion: "bots-live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: worker.credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stopWorker = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    await liveProxyReady(gw, workerId);
    projectId = (await gw.api.createProject({ name: "Bots live" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
    gw.core.bots.start();
  }, 120_000);
  afterAll(async () => { await gw?.core.bots.stop(); await stopWorker(); await gw?.close(); });

  for (const provider of [Provider.CLAUDE, Provider.CODEX]) test(`${Provider[provider]}: chat, shell refusal, platform start_thread and completion follow-up`, async () => {
    const model = provider === Provider.CLAUDE ? process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" : process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
    const bot = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: {
      name: `Live ${Provider[provider]}`, shape: "ghost", color: "#22aaff", provider, providerInstance: "cliproxyapi", model, effort: "low", approvalPolicy: "safe",
    } })).bot!;
    const conversation = () => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id));
    const send = async (text: string) => {
      await gw.api.sendBotMessage({ botId: bot.id, text, clientRequestId: Bun.randomUUIDv7() });
      const result = await eventually(conversation, (s) => !s.working, 90_000);
      expect(result.working).toBe(false);
      return result;
    };
    expect((await send("Reply with exactly BOT_HELLO")).messages.at(-1)?.text).toContain("BOT_HELLO");
    const refused = await send("Run ls on your own gateway filesystem. If you cannot, respond exactly NO_LOCAL_TOOLS. Do not delegate to a worker or any other bot.");
    expect(refused.messages.at(-1)?.text).toContain("NO_LOCAL_TOOLS");
    expect((await gw.api.listThreads({ projectId })).threads).toHaveLength(provider === Provider.CLAUDE ? 0 : 1);
    await gw.api.sendBotMessage({ botId: bot.id, clientRequestId: Bun.randomUUIDv7(), text:
      `Use start_thread exactly once now, with project_id=${projectId}, workspace_id=${workspaceId}, provider=${provider === Provider.CLAUDE ? "claude" : "codex"}, provider_instance=cliproxyapi, model=${model}, effort=low, permission=read_only, prompt="Reply with exactly WORKER_BOT_DONE. Do not use tools.". Do not ask a question or use another tool. When you receive the automatic Thread completion follow-up, say WORKER_BOT_DONE_RECEIVED.`,
    });
    const final = await eventually(conversation, (s) => !s.working && s.messages.some((m) => m.kind === "event" && m.text.startsWith("Thread ")) && s.messages.at(-1)?.text.includes("WORKER_BOT_DONE_RECEIVED") === true, 120_000);
    expect(final.messages.some((m) => m.kind === "event" && m.text.includes("WORKER_BOT_DONE"))).toBe(true);
    expect(final.messages.at(-1)?.text).toContain("WORKER_BOT_DONE_RECEIVED");
    expect(final.approvals).toHaveLength(0);
    const threads = (await gw.api.listThreads({ projectId })).threads;
    expect(threads.filter((t) => t.provider === provider)).toHaveLength(1);
    expect(threads.find((t) => t.provider === provider)?.workerId).toBe(workerId);
  }, 240_000);
});

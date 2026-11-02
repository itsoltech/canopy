import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Provider } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { tempDirs } from "@open-agents/testing";
import { journalHello, openGatewayLink } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();
const url = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const key = process.env["OA_LIVE_CLIPROXYAPI_KEY"];

describe.skipIf(process.env["OA_LIVE"] !== "1" || !url || !key || !dockerAvailable)("bot provisions a project through live CLIProxyAPI", () => {
  let gw: TestGateway;
  let workerId = "";
  let stopWorker = async () => {};
  const state = tempDir("oa-bot-platform-live-state-");
  const repo = tempDir("oa-bot-platform-live-repo-");
  beforeAll(async () => {
    gw = await startTestGateway();
    const worker = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ ownerUserId: gw.userId, name: "stack-worker" })));
    workerId = worker.workerId;
    await useLiveProxy(gw, workerId, { url: url!, key: key!, allowedRoots: [repo], harnesses: [Provider.CODEX] });
    const runtime = ManagedRuntime.make(Journal.layer(join(state, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(state, "worker"), clientVersion: "bot-platform-live" });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: worker.credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stopWorker = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    await liveProxyReady(gw, workerId, [Provider.CODEX]);
    gw.core.bots.start();
  }, 120_000);
  afterAll(async () => { await gw?.core.bots.stop(); await stopWorker(); await gw?.close(); });

  test("natural request creates a project, workspace and pwd thread, then reports the completion", async () => {
    const model = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
    const name = `Bot platform ${Bun.randomUUIDv7().slice(-8)}`;
    const bot = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: {
      name: "Platform live", shape: "round", color: "#22aaff", provider: Provider.CODEX,
      providerInstance: "cliproxyapi", model, effort: "low", approvalPolicy: "safe",
      instructions: "For coding threads use codex/cliproxyapi and read_only permissions. Wait for the automatic completion notification, then report the actual result. You can configure the platform using its tools but have no local execution.",
    } })).bot!;
    await gw.api.sendBotMessage({ botId: bot.id, clientRequestId: Bun.randomUUIDv7(), text:
      `Create a new project named '${name}' on stack-worker at '${repo}', then start a thread there that runs pwd. Report the project's name, worker, and actual working directory after the agent finishes.`,
    });
    const final = await eventually(() => gw.core.bots.run((s) => s.conversation(gw.userId, bot.id)),
      (s) => s.approvals.some((a) => a.status === "pending") || !s.working && s.messages.some((m) => m.kind === "event" && m.text.startsWith("Thread ")), 180_000);
    expect(final.approvals.filter((a) => a.status === "pending")).toEqual([]);
    expect(final.working).toBe(false);
    const project = (await gw.api.getOverview({})).projects.find((p) => p.name === name);
    expect(project).toBeDefined();
    expect(project?.workspaces).toContainEqual(expect.objectContaining({ workerId, rootPath: repo }));
    const threads = (await gw.api.listThreads({ projectId: project!.id })).threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ workerId, cwd: repo, workspaceId: project!.workspaces[0]!.id });
    expect(final.messages.some((m) => m.kind === "event" && m.text.startsWith("Thread ") && m.text.includes(repo))).toBe(true);
    expect(final.messages.at(-1)?.text).toContain(repo);
    expect(final.messages.at(-1)?.text).toContain(name);
  }, 240_000);
});

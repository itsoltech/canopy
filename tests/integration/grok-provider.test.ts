import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { Provider, ProviderProfileKind, PermissionMode, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { tempDirs } from "@open-agents/testing";
import { journalHello, openGatewayLink } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { WorkerHost, serveLink } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";
import { startTestGateway, eventually, watchUntil } from "./support/gateway.ts";

const tempDir = tempDirs();
const fake = resolve(import.meta.dir, "../../apps/worker/src/providers/grok/fixtures/agent.ts");
test.skipIf(!dockerAvailable)("Grok: UI API→gateway→worker→fake ACP, approvals, MCP, interrupt, steer queue, restart/resume", async () => {
  const gw = await startTestGateway();
  const data = tempDir("oa-grok-worker-"); const repo = tempDir("oa-grok-repo-");
  const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: "Grok fake", ownerUserId: gw.userId })));
  await gw.runtime.runPromise(GatewayStore.use((s) => s.setWorkerConfig(added.workerId, { grok: { enabled: true, executablePath: fake } }, gw.userId)));
  let stop = async () => {};
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [{ id: "fake-grok" }] }) });
  const connect = async () => {
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: data, clientVersion: "test", probe: { which: () => fake, version: () => "grok 1.0.70", realDirectory: (p) => p, login: () => "Fake Grok" } });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: added.credential, hello: { workerId: added.workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link, host, runtime);
    stop = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    await eventually(async () => (await gw.api.getOverview({})).workers.find((w) => w.id === added.workerId), (w) => !!w?.providerInstances.some((i) => i.harness === Provider.GROK && i.available), 15_000);
  };
  try {
    await Bun.write(join(repo, "fixture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    await connect();
    const snapshot = async (threadId: string) => {
      const updates = await watchUntil(gw.api, threadId, (us) => us.some((u) => u.change.case === "snapshot"));
      const change = updates.find((u) => u.change.case === "snapshot")!.change;
      if (change.case !== "snapshot") throw new Error("snapshot missing");
      return change.value;
    };
    const project = (await gw.api.createProject({ name: "Grok" })).project!;
    const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: added.workerId, rootPath: repo })).workspace!;
    const thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.GROK, model: "fake-grok", title: "Grok test", permissionMode: PermissionMode.ASK, clientRequestId: crypto.randomUUID() })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle", 15_000);
    const turn = async (text: string, allow = true) => {
      const sent = await gw.api.sendMessage({ threadId: thread.id, text, clientRequestId: crypto.randomUUID() });
      const turnId = sent.turn!.id; const answered = new Set<string>();
      const answer = (i: ui.Interaction) => {
        if (i.turnId !== turnId || i.status !== "pending" || answered.has(i.requestId)) return;
        answered.add(i.requestId); void gw.api.answerInteraction({ requestId: i.requestId, allow });
      };
      const done = (t: ui.Turn) => t.id === turnId && ["completed", "failed", "interrupted"].includes(t.status);
      const updates = await watchUntil(gw.api, thread.id, (us) => us.some((u) => u.change.case === "turn" ? done(u.change.value) : u.change.case === "snapshot" && u.change.value.turns.some(done)), (u) => {
        if (u.change.case === "interaction") answer(u.change.value);
        if (u.change.case === "snapshot") u.change.value.interactions.forEach(answer);
      }, 15_000);
      return { updates, answered, state: await snapshot(thread.id) };
    };
    const initial = await turn("MCP_IMAGE");
    expect(initial.state.turns.at(-1)?.status).toBe("completed");
    const items = initial.state.items.map((i) => i.item?.content.case);
    expect(items).toContain("commandExecution"); expect(items).toContain("fileChange"); expect(items).toContain("reasoning"); expect(items).toContain("plan");
    expect(initial.state.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === "GROK_OK")).toBe(true);
    expect(initial.state.items.some((i) => i.item?.content.case === "agentBusCall")).toBe(true);
    expect(initial.state.items.some((i) => i.item?.content.case === "image" && !!i.item.content.value.blob?.sha256)).toBe(true);
    const allowed = await turn("PERMISSION", true);
    expect(allowed.answered.size).toBe(1);
    expect(allowed.state.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === "ALLOWED")).toBe(true);
    const denied = await turn("PERMISSION", false);
    expect(denied.answered.size).toBe(1);
    expect(denied.state.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === "DENIED")).toBe(true);
    await gw.api.saveProviderInstance({ harness: Provider.GROK, id: "fake-proxy", label: "Fake proxy", kind: ProviderProfileKind.CLIPROXYAPI, create: true,
      baseUrl: proxy.url.href, apiKey: "fake-grok-secret-key", workerIds: [added.workerId] });
    await eventually(async () => (await gw.api.getOverview({})).workers.find((w) => w.id === added.workerId), (w) => !!w?.providerInstances.some((i) => i.id === "fake-proxy" && i.available), 15000);
    const proxied = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.GROK, providerProfileId: "fake-proxy", model: "fake-grok",
      title: "Proxy Grok", initialMessage: "MCP", permissionMode: PermissionMode.FULL_AUTO, clientRequestId: crypto.randomUUID() })).thread!;
    const proxyTurn = await eventually(() => snapshot(proxied.id), (r) => r.turns.at(-1)?.status === "completed", 15000);
    expect(proxyTurn.items.some((i) => i.item?.content.case === "agentBusCall")).toBe(true);
    await stop(); await connect();
    const resumed = await turn("RESUMED");
    expect(resumed.state.turns.at(-1)?.status).toBe("completed");
    await gw.api.sendMessage({ threadId: thread.id, text: "HANG", clientRequestId: crypto.randomUUID() });
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "running", 5000);
    const steered = await gw.api.sendMessage({ threadId: thread.id, text: "QUEUED", clientRequestId: crypto.randomUUID(), delivery: ui.MessageDelivery.STEER });
    const queued = await eventually(() => snapshot(thread.id), (r) => r.steers.some((s) => s.id === steered.steer?.id && s.status === "queued"), 5000);
    expect(queued.steers.find((s) => s.id === steered.steer?.id)?.status).toBe("queued");
    await gw.api.interruptThread({ threadId: thread.id });
    const interrupted = await eventually(() => snapshot(thread.id), (r) => r.turns.some((t) => t.status === "interrupted"), 5000);
    expect(interrupted.turns.some((t) => t.status === "interrupted")).toBe(true);
    const drained = await eventually(() => snapshot(thread.id), (r) => r.turns.at(-1)?.status === "completed", 5000);
    expect(drained.turns.at(-1)?.status).toBe("completed");
    const waiting = await gw.api.sendMessage({ threadId: thread.id, text: "PERMISSION", clientRequestId: crypto.randomUUID() });
    await eventually(() => snapshot(thread.id), (r) => r.interactions.some((i) => i.turnId === waiting.turn?.id && i.status === "pending"), 5000);
    await gw.api.interruptThread({ threadId: thread.id });
    const cancelled = await eventually(() => snapshot(thread.id), (r) => r.turns.find((t) => t.id === waiting.turn?.id)?.status === "interrupted", 10000);
    expect(cancelled.interactions.filter((i) => i.turnId === waiting.turn?.id).every((i) => i.status !== "pending")).toBe(true);
  } finally { await stop(); await proxy.stop(true); await gw.close(); }
}, 60_000);

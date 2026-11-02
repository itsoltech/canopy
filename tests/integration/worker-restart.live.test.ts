/**
 * Live, the whole chain across a worker restart (docs/durability.md, 3.4): UI API -> gateway core (PostgreSQL) ->
 * real worker host -> Codex app-server; the worker process is replaced (same data dir and journal) like the dev
 * stack after a merge. A turn running at the restart ends as interrupted by the system ("worker restarted", then
 * "worker restarted mid-turn" from the worker's reconciliation with the rollout), nothing of it stays open, and the queue goes
 * on; a Codex thread created without any turn (no rollout) still works after the restart.
 * Opt-in: OA_LIVE=1 with the CLIProxyAPI env; needs Docker for PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionMode, Provider, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { journalHello, openGatewayLink, resendPending } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const codexModel = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
const MINUTE = 60_000;

async function until<A>(what: string, read: () => Promise<A>, done: (value: A) => boolean, timeoutMs: number): Promise<A> {
  const value = await eventually(read, done, timeoutMs);
  if (!done(value)) throw new Error(`timed out waiting for: ${what}`);
  return value;
}

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("worker restart, end to end (live)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-live-restart-"));
  const repo = mkdtempSync(join(tmpdir(), "oa-live-restart-repo-"));
  let gw: TestGateway;
  let workerId = "";
  let credential = "";
  let stop: () => Promise<void> = async () => {};
  let projectId = "";
  let workspaceId = "";

  /** One worker process: journal, host (recover first, like main.ts), link with the running_turns report. */
  const startWorker = async () => {
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
    const recovered = await host.recover();
    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential,
      hello: { workerId, capabilities: ["running_turns"], runningTurns: host.runningTurns(), ...(await runtime.runPromise(journalHello())) },
    });
    await runtime.runPromise(resendPending(link));
    const serving = serveLink(link, host, runtime);
    stop = async () => {
      link.close();
      await serving;
      await host.close(); // the app-server dies with the process, a running turn with it
      await runtime.dispose();
    };
    await until("worker configured", () => gw.api.getOverview({}), (o) => o.workers.find((w) => w.id === workerId)?.online === true && host.config !== undefined, 30_000);
    return recovered;
  };
  const restart = async () => {
    await stop();
    return startWorker();
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    const store = <A>(use: (s: GatewayStore["Service"]) => import("effect").Effect.Effect<A, unknown>) => gw.runtime.runPromise(GatewayStore.use(use));
    ({ workerId, credential } = await store((s) => s.addWorker({ name: "live-restart", ownerUserId: gw.userId })));
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo], harnesses: [Provider.CODEX] });
    await startWorker();
    projectId = (await gw.api.createProject({ name: "Live restart" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
  }, 2 * MINUTE);

  afterAll(async () => {
    await stop();
    await gw?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const newThread = async (title: string) => {
    const thread = (
      await gw.api.createThread({ projectId, workspaceId, title, provider: Provider.CODEX, providerProfileId: "cliproxyapi", model: codexModel, permissionMode: PermissionMode.FULL_AUTO })
    ).thread!;
    await until("thread ready", () => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle", MINUTE);
    return thread.id;
  };
  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
    return updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
  };
  const lastAnswer = (s: ui.ThreadSnapshot) =>
    s.items
      .map((i) => i.item?.content)
      .filter((c) => c?.case === "agentMessage")
      .map((c) => (c?.case === "agentMessage" ? c.value.text : ""))
      .at(-1) ?? "";

  test("a turn running at the restart ends as interrupted; the queued message runs on the new process", async () => {
    const threadId = await newThread("restart mid-turn");
    await gw.api.sendMessage({
      threadId,
      clientRequestId: "long",
      text: "Run this exact shell command in the foreground and wait for it to finish: `sleep 120`. Then reply with the single word SLEPT.",
    });
    await until("turn running", () => snapshot(threadId), (s) => s.turns[0]?.status === "running" && s.items.length > 1, 2 * MINUTE);
    await gw.api.sendMessage({ threadId, clientRequestId: "next", text: "Reply with the single word DONE." });

    const recovered = await restart();
    expect(recovered.turns).toBe(1);
    const s = await until("queued turn done", () => snapshot(threadId), (x) => x.turns[1]?.status === "completed", 3 * MINUTE);
    // The gateway ends it ("worker restarted"), then the new process settles it from the rollout: the system's interruption.
    expect(s.turns.map((t) => [t.status, t.interruptSource])).toEqual([
      ["interrupted", "system"],
      ["completed", ""],
    ]);
    expect(s.turns[0]?.interruptReason).toContain("worker restarted");
    expect(s.items.filter((i) => i.turnId === s.turns[0]?.id).every((i) => i.item?.status !== 1)).toBe(true);
    expect(lastAnswer(s)).toContain("DONE");
    expect(s.thread?.status).toBe("idle");
  }, 8 * MINUTE);

  test("a Codex thread created without a turn still works after the restart (a new Codex thread replaces it)", async () => {
    const threadId = await newThread("restart before the first turn");
    const before = (await gw.api.getThread({ threadId })).thread!;
    await restart();
    await gw.api.sendMessage({ threadId, clientRequestId: "first", text: "Reply with the single word OK." });
    const s = await until("turn done", () => snapshot(threadId), (x) => x.turns[0]?.status === "completed" || x.turns[0]?.status === "failed", 3 * MINUTE);
    expect(s.turns[0]).toMatchObject({ status: "completed", error: "" });
    expect(lastAnswer(s)).toContain("OK");
    expect(before.runtime).toBe("worker");
    // And again after another restart: the new Codex thread has a rollout now and is resumed.
    await restart();
    await gw.api.sendMessage({ threadId, clientRequestId: "second", text: "Reply with the single word AGAIN." });
    const again = await until("second turn done", () => snapshot(threadId), (x) => x.turns[1]?.status === "completed" || x.turns[1]?.status === "failed", 3 * MINUTE);
    expect(again.turns[1]?.status).toBe("completed");
    expect(lastAnswer(again)).toContain("AGAIN");
  }, 8 * MINUTE);
});

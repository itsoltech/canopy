/**
 * Live, the whole chain: UI API -> gateway core (PostgreSQL) -> real worker host -> Codex app-server /
 * Claude Code -> events -> ingest -> UI. Harness goals (docs/goals.md) and background work
 * (docs/execution.md). Opt-in: OA_LIVE=1 with the CLIProxyAPI env; needs Docker for PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ItemStatus, PermissionMode, Provider, ui, type Item } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayStore } from "@open-agents/gateway/store";
import { tempDir } from "@open-agents/testing";
import { journalHello, openGatewayLink, resendPending } from "@open-agents/worker/gateway-link";
import { Journal } from "@open-agents/worker/journal";
import { serveLink, WorkerHost } from "@open-agents/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const codexModel = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
const claudeModel = process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";
const MINUTE = 60_000;

/** Like eventually, but a condition that never holds fails the test (with what was awaited). */
async function until<A>(what: string, read: () => Promise<A>, done: (value: A) => boolean, timeoutMs: number): Promise<A> {
  const value = await eventually(read, done, timeoutMs);
  if (!done(value)) throw new Error(`timed out waiting for: ${what}`);
  return value;
}

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("harness goals and background work, end to end (live)", () => {
  const dir = tempDir("oa-live-goals-");
  const repo = tempDir("oa-live-goals-repo-");
  let gw: TestGateway;
  let close: () => Promise<void> = async () => {};
  let projectId = "";
  let workspaceId = "";

  beforeAll(async () => {
    gw = await startTestGateway();
    const store = <A>(use: (s: GatewayStore["Service"]) => import("effect").Effect.Effect<A, unknown>) => gw.runtime.runPromise(GatewayStore.use(use));
    const { workerId, credential } = await store((s) => s.addWorker({ name: "live", ownerUserId: gw.userId }));
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
    await host.recover();
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential, hello: { workerId, ...(await runtime.runPromise(journalHello())) } });
    await runtime.runPromise(resendPending(link));
    const serving = serveLink(link, host, runtime);
    close = async () => {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
    };
    projectId = (await gw.api.createProject({ name: "Live goals" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
    await liveProxyReady(gw, workerId);
  }, 2 * MINUTE);

  afterAll(async () => {
    await close();
    await gw?.close();
  });

  const newThread = async (provider: Provider, title: string) => {
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title,
        provider,
        providerProfileId: "cliproxyapi",
        model: provider === Provider.CLAUDE ? claudeModel : codexModel,
        permissionMode: PermissionMode.FULL_AUTO,
      })
    ).thread!;
    await until("condition", () => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle", 60_000);
    return thread.id;
  };
  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
    return updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
  };
  const background = (s: ui.ThreadSnapshot) => s.items.map((i) => i.item).find((i): i is Item => i?.content.case === "backgroundTask");
  const output = (item: Item | undefined) => (item?.content.case === "backgroundTask" ? item.content.value.output : "");
  const stopReason = (item: Item | undefined) => (item?.content.case === "backgroundTask" ? item.content.value.stopReason : "");

  test("Codex: a process outlives its turn, streams output, is stopped from the UI", async () => {
    const threadId = await newThread(Provider.CODEX, "codex background");
    await gw.api.sendMessage({
      threadId,
      clientRequestId: "codex-bg",
      text:
        "Run this exact shell command directly in your exec tool, without nohup, & or redirection, with a short yield time (about 2 seconds) " +
        "so the call returns while the process keeps running: `for i in $(seq 1 300); do echo tick $i; sleep 1; done`. " +
        "Do not poll it or wait for it to finish. As soon as the call returns, reply with the single word STARTED.",
    });
    await until("condition", () => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 1 && r.thread.status === "idle", 3 * MINUTE);
    const running = await until("condition", () => snapshot(threadId), (s) => output(background(s)).includes("tick 8"), MINUTE);
    const task = background(running)!;
    expect(task.status).toBe(ItemStatus.IN_PROGRESS);
    expect(running.turns.map((t) => t.status)).toEqual(["completed"]);
    await gw.api.stopBackgroundTask({ threadId, itemId: task.itemId });
    await until("condition", () => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 0, MINUTE);
    const stopped = background(await snapshot(threadId));
    expect([stopped?.status, stopReason(stopped)]).toEqual([ItemStatus.INTERRUPTED, "stopped_by_user"]);
    expect((await snapshot(threadId)).turns).toHaveLength(1); // no phantom turns from the late output
  }, 6 * MINUTE);

  test("Codex: goal set, continued by Codex, paused, resumed and cleared", async () => {
    const threadId = await newThread(Provider.CODEX, "codex goal");
    const set = await gw.api.setGoal({
      threadId,
      action: "set",
      objective: "Count from 1 to 10 using one separate shell command `sleep 5; echo N` per number, then report the numbers.",
      tokenBudget: 200_000n,
    });
    expect(set.goal?.status).toBe("active");
    // Codex works on it by itself (a provider turn of the goal) and reports its usage.
    let s = await until("goal progress", () => snapshot(threadId), (x) => (x.goal?.tokensUsed ?? 0n) > 0n, 3 * MINUTE);
    expect(s.turns.some((t) => t.trigger === "provider" && t.goalId === set.goal!.id)).toBe(true);
    expect(s.goal?.nativeStatus).toBe("active");
    expect((await gw.api.setGoal({ threadId, action: "pause" })).goal?.status).toBe("paused");
    s = await until("paused by Codex", () => snapshot(threadId), (x) => x.goal?.nativeStatus === "paused", MINUTE);
    expect(s.goal?.status).toBe("paused");
    // The running turn ends normally; no continuation starts while paused.
    await until("idle after pause", () => gw.api.getThread({ threadId }), (r) => r.thread?.status === "idle", 3 * MINUTE);
    const turnsWhilePaused = (await snapshot(threadId)).turns.length;
    await Bun.sleep(5_000);
    expect((await snapshot(threadId)).turns.length).toBe(turnsWhilePaused);
    expect((await gw.api.setGoal({ threadId, action: "resume" })).goal?.status).toBe("active");
    s = await until("resumed by Codex", () => snapshot(threadId), (x) => x.goal?.nativeStatus === "active", MINUTE);
    expect((await gw.api.setGoal({ threadId, action: "clear" })).goal?.status).toBe("cancelled");
    s = await until("cleared by Codex", () => snapshot(threadId), (x) => x.goal?.nativeStatus === "cleared", MINUTE);
    expect(s.goal).toMatchObject({ id: set.goal!.id, status: "cancelled" });
    expect(s.goal?.tokensUsed).toBeGreaterThan(0n);
    expect(s.goal?.iterations).toBeGreaterThanOrEqual(1);
    expect((await gw.api.getThread({ threadId })).thread?.goalStatus).toBe("");
  }, 10 * MINUTE);

  test("Claude: background Bash with output from its file, stopped from the UI; a finished task starts Claude's own turn", async () => {
    const threadId = await newThread(Provider.CLAUDE, "claude background");
    await gw.api.sendMessage({
      threadId,
      clientRequestId: "claude-bg",
      text: "Use the Bash tool with run_in_background set to true to run exactly: for i in $(seq 1 300); do echo tick $i; sleep 1; done\nDo not wait for it or check its output. Then reply with the single word STARTED.",
    });
    await until("condition", () => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 1 && r.thread.status === "idle", 3 * MINUTE);
    const running = await until("condition", () => snapshot(threadId), (s) => output(background(s)).includes("tick 4"), MINUTE);
    await gw.api.stopBackgroundTask({ threadId, itemId: background(running)!.itemId });
    await until("condition", () => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 0, MINUTE);
    const stopped = background(await snapshot(threadId));
    expect([stopped?.status, stopReason(stopped)]).toEqual([ItemStatus.INTERRUPTED, "stopped_by_user"]);

    // A short task: when it ends, Claude reports it in a turn it starts itself.
    await gw.api.sendMessage({
      threadId,
      clientRequestId: "claude-bg-2",
      text: "Use the Bash tool with run_in_background set to true to run exactly: for i in 1 2 3; do echo step $i; sleep 1; done\nDo not wait for it. Reply with the single word STARTED.",
    });
    const s = await until("condition", () => snapshot(threadId), (x) => x.turns.some((t) => t.trigger === "provider" && t.status === "completed"), 3 * MINUTE);
    const done = s.items.map((i) => i.item).filter((i) => i?.content.case === "backgroundTask").at(-1);
    expect(done?.status).toBe(ItemStatus.COMPLETED);
    expect(output(done)).toContain("step 3");
  }, 8 * MINUTE);

  test("Claude: /goal set from the UI, the evaluator's verdict achieves it", async () => {
    const threadId = await newThread(Provider.CLAUDE, "claude goal");
    const set = await gw.api.setGoal({ threadId, action: "set", objective: "A file named goal.txt exists in the current directory and contains exactly the word done" });
    const s = await until("condition", () => snapshot(threadId), (x) => x.goal?.status === "achieved", 4 * MINUTE);
    expect(s.goal).toMatchObject({ id: set.goal!.id, nativeStatus: "met", createdBy: "user" });
    expect(s.goal?.lastReason).not.toBe("");
    expect(s.turns.find((t) => t.trigger === "goal")).toMatchObject({ inputText: expect.stringMatching(/^\/goal /), goalId: set.goal!.id });
    expect((await Bun.file(join(repo, "goal.txt")).text()).trim()).toBe("done");
  }, 5 * MINUTE);
});

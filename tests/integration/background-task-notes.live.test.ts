/**
 * Live (docs/execution.md, "Pobudka"): a real worker host behind the CLIProxyAPI starts a background process for
 * Codex and for Claude, the worker is stopped gracefully mid-task (as main.ts does on SIGTERM: shutdown, flush,
 * close) and started again on the same journal. The task ends as worker_shutdown with its end time, the agent gets
 * the platform's note in a turn of its own after the restart, and can say what happened (get_background_task).
 * Opt-in: OA_LIVE=1 with the CLIProxyAPI env; needs Docker for PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ItemStatus, PermissionMode, Provider, ui, type Item } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink, resendPending } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const codexModel = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
const claudeModel = process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";
const MINUTE = 60_000;

async function until<A>(what: string, read: () => Promise<A>, done: (value: A) => boolean, timeoutMs: number): Promise<A> {
  const value = await eventually(read, done, timeoutMs);
  if (!done(value)) throw new Error(`timed out waiting for: ${what}`);
  return value;
}

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("background task notes across a worker restart (live)", () => {
  const dir = tempDir("oa-live-bgnotes-");
  const repo = tempDir("oa-live-bgnotes-repo-");
  let gw: TestGateway;
  let workerId = "";
  let credential = "";
  let projectId = "";
  let workspaceId = "";
  let worker: { stop: () => Promise<number>; close: () => Promise<void> } | undefined;

  /** One worker process: the host on the journal in `dir`, linked like main.ts (recover, resend, serve). */
  const startWorker = async () => {
    const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
    await host.recover();
    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential,
      hello: { workerId, capabilities: ["running_turns", "attachments"], runningTurns: host.runningTurns(), ...(await runtime.runPromise(journalHello())) },
    });
    await runtime.runPromise(resendPending(link));
    const serving = serveLink(link, host, runtime);
    const close = async () => {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
    };
    // A graceful stop as on SIGTERM: runtimes down (tasks end as worker_shutdown), acked, then the link closes.
    const stop = async () => {
      const tasks = await host.shutdown();
      await host.flush(5_000);
      await close();
      return tasks;
    };
    worker = { stop, close };
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    const store = <A>(use: (s: GatewayStore["Service"]) => import("effect").Effect.Effect<A, unknown>) => gw.runtime.runPromise(GatewayStore.use(use));
    ({ workerId, credential } = await store((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })));
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    await startWorker();
    projectId = (await gw.api.createProject({ name: "Live background notes" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
    await liveProxyReady(gw, workerId);
  }, 2 * MINUTE);

  afterAll(async () => {
    await worker?.close();
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
    await until("thread ready", () => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle", 60_000);
    return thread.id;
  };
  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
    return updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
  };
  const background = (s: ui.ThreadSnapshot) => s.items.map((i) => i.item).find((i): i is Item => i?.content.case === "backgroundTask");
  const output = (item: Item | undefined) => (item?.content.case === "backgroundTask" ? item.content.value.output : "");
  const lastMessage = (s: ui.ThreadSnapshot, turnId: string) =>
    s.items.filter((i) => i.turnId === turnId && i.item?.content.case === "agentMessage").map((i) => (i.item!.content.value as { text: string }).text).at(-1) ?? "";

  /** Start a task, stop the worker mid-task, start it again: the note turn runs, the agent answers what happened. */
  const restartScenario = async (threadId: string, start: string) => {
    await gw.api.sendMessage({ threadId, clientRequestId: `${threadId}-start`, text: start });
    await until("task running after its turn", () => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 1 && r.thread.status === "idle", 3 * MINUTE);
    await until("output", () => snapshot(threadId), (s) => output(background(s)).includes("tick 3"), MINUTE);

    expect(await worker!.stop()).toBe(1);
    const stopped = await until("task stopped by the shutdown", () => snapshot(threadId), (s) => background(s)?.status === ItemStatus.INTERRUPTED, MINUTE);
    const task = background(stopped)!;
    expect(task.content.case === "backgroundTask" && task.content.value.stopReason).toBe("worker_shutdown");
    expect(task.content.case === "backgroundTask" && task.content.value.endedAt).toBeTruthy();
    // The note turn waits for the worker.
    const queued = await until("note turn queued", () => snapshot(threadId), (s) => s.turns.some((t) => t.trigger === "background_task"), MINUTE);
    expect(queued.turns.filter((t) => t.trigger === "background_task")).toHaveLength(1);

    await startWorker();
    const noted = await until(
      "note turn ran",
      () => snapshot(threadId),
      (s) => s.turns.some((t) => t.trigger === "background_task" && (t.status === "completed" || t.status === "failed")),
      4 * MINUTE,
    );
    const note = noted.turns.find((t) => t.trigger === "background_task")!;
    expect(note.status).toBe("completed");
    expect(note.backgroundItemIds).toEqual([task.itemId]);
    expect(note.inputText).toContain("shut down for a restart or deploy");
    expect(lastMessage(noted, note.id)).toMatch(/restart|deploy|shut ?down|shutdown/i);
    // Observe beyond the old split (~0.5 s) and the adapter's idle grace (3 s), before sending more input.
    // A predicate that returns as soon as the note completes would miss the following provider turn.
    await Bun.sleep(4_000);
    const settled = await snapshot(threadId);
    expect(settled.turns.map((t) => t.trigger)).toEqual(["user", "background_task"]);
    expect(lastMessage(settled, note.id)).toBeTruthy();

    // The user asks; the agent can tell (and check with its tool).
    await gw.api.sendMessage({
      threadId,
      clientRequestId: `${threadId}-ask`,
      text: "What happened to the background task you started? Check it with get_background_task and answer in one or two sentences, including why it ended.",
    });
    const answered = await until(
      "answer",
      () => snapshot(threadId),
      (s) => s.turns.filter((t) => t.trigger === "user").at(-1)?.status === "completed" && s.turns.filter((t) => t.trigger === "user").length === 2,
      4 * MINUTE,
    );
    const ask = answered.turns.filter((t) => t.trigger === "user").at(-1)!;
    const answer = lastMessage(answered, ask.id);
    console.info(`[live] answer: ${answer.slice(0, 400)}`);
    expect(answer).toMatch(/restart|deploy|shut ?down|shutdown/i);
    const called = answered.items.some((i) => i.item?.content.case === "agentBusCall" && i.item.content.value.toolName === "get_background_task");
    console.info(`[live] get_background_task called: ${called}`);
    expect(called).toBe(true);
    expect(answered.turns.filter((t) => t.trigger === "background_task")).toHaveLength(1);
  };

  test("Codex: a process killed by a worker restart; the agent hears why and can check it", async () => {
    const threadId = await newThread(Provider.CODEX, "codex restart note");
    await restartScenario(
      threadId,
      "Run this exact shell command directly in your exec tool, without nohup, & or redirection, with a short yield time (about 2 seconds) " +
        "so the call returns while the process keeps running: `for i in $(seq 1 180); do echo tick $i; sleep 1; done`. " +
        "Do not poll it or wait for it. It is a throwaway demo: if it is interrupted later, do not start it again. Reply with the single word STARTED.",
    );
  }, 15 * MINUTE);

  test("Claude: a background Bash killed by a worker restart; the agent hears why and can check it", async () => {
    const threadId = await newThread(Provider.CLAUDE, "claude restart note");
    await restartScenario(
      threadId,
      "Use the Bash tool with run_in_background set to true to run exactly: for i in $(seq 1 180); do echo tick $i; sleep 1; done\n" +
        "Do not wait for it or check its output. It is a throwaway demo: if it is interrupted later, do not start it again. Reply with the single word STARTED.",
    );
  }, 15 * MINUTE);

  test("Claude: natural completion wakes the harness once, without a second platform note turn", async () => {
    const threadId = await newThread(Provider.CLAUDE, "claude natural completion");
    await gw.api.sendMessage({
      threadId,
      clientRequestId: `${threadId}-natural`,
      text: "Use Bash with run_in_background true to run exactly: sleep 12; echo NATURAL_DONE\n" +
        "Do not wait or check its output. Reply STARTED. When the background task finishes, acknowledge its completion in one sentence.",
    });
    await until("natural task running after its turn", () => gw.api.getThread({ threadId }), (r) => r.thread?.backgroundTasks === 1 && r.thread.status === "idle", 3 * MINUTE);
    const completed = await until("Claude's completion answer", () => snapshot(threadId), (s) =>
      background(s)?.status === ItemStatus.COMPLETED && s.turns.some((t) => t.trigger === "provider" && t.status === "completed" && lastMessage(s, t.id).length > 0),
    3 * MINUTE);
    const wake = completed.turns.find((t) => t.trigger === "provider")!;
    expect(lastMessage(completed, wake.id)).toBeTruthy();
    // The platform fallback runs after 15 s: observe its entire window, not just Claude's fast reply.
    await Bun.sleep(17_000);
    await gw.core.backgroundTasks.tick();
    expect((await snapshot(threadId)).turns.map((t) => t.trigger)).toEqual(["user", "provider"]);
  }, 6 * MINUTE);
});

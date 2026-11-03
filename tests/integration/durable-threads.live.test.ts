/**
 * Live: a worker process killed mid-turn (SIGKILL, like a crash or OOM) on Codex and on Claude Code
 * (docs/durability.md, "Rekoncyliacja z transkryptu harnessu"). UI API -> gateway (PostgreSQL) -> a real worker
 * process (apps/worker/src/main.ts) -> the harness through CLIProxyAPI. After a new worker process starts on the same
 * data dir, the turn's final state must match what the harness wrote in its own transcript (Codex rollout, Claude
 * session JSONL), nothing of it may stay open, and the thread must take the next message (the harness session is
 * resumed with its context).
 * Opt-in: OA_LIVE=1 with the CLIProxyAPI env; needs Docker for PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const LIVE = process.env["OA_LIVE"] === "1";
const proxyUrl = process.env["OA_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["OA_LIVE_CLIPROXYAPI_KEY"];
const codexModel = process.env["OA_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
const claudeModel = process.env["OA_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";
const MINUTE = 60_000;
const WORKER_MAIN = join(import.meta.dir, "../../apps/worker/src/main.ts");

async function until<A>(what: string, read: () => Promise<A>, done: (value: A) => boolean, timeoutMs: number): Promise<A> {
  const value = await eventually(read, done, timeoutMs);
  if (!done(value)) throw new Error(`timed out waiting for: ${what}`);
  return value;
}

/** Every process below a pid (the harness processes a killed worker leaves behind). */
function descendants(pid: number): number[] {
  const children = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
  return children.flatMap((child) => [child, ...descendants(child)]);
}

function findFile(dir: string, match: (name: string) => boolean): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(path, match);
      if (found) return found;
    } else if (match(entry.name)) return path;
  }
  return undefined;
}

const jsonl = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown> & { type?: string; payload?: Record<string, unknown> }];
      } catch {
        return [];
      }
    });

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("worker killed mid-turn, settled from the harness transcript (live)", () => {
  const dir = tempDir("oa-live-durable-");
  const repo = tempDir("oa-live-durable-repo-");
  const dataDir = join(dir, "data");
  const logs: string[] = [];
  let gw: TestGateway;
  let workerId = "";
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  const leftovers = new Set<number>();
  let projectId = "";
  let workspaceId = "";

  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, params as never[])));

  /** A worker process like the dev stack runs it (its config file, its data dir); waits until it is configured. */
  const startWorker = async () => {
    const proc = Bun.spawn(["bun", WORKER_MAIN], {
      env: { ...process.env, OA_WORKER_CONFIG: join(dir, "worker.json") },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const stream of [proc.stdout, proc.stderr]) {
      void (async () => {
        for await (const chunk of stream) logs.push(new TextDecoder().decode(chunk));
      })();
    }
    worker = proc;
    await until(
      "worker online and configured",
      () => gw.api.getOverview({}),
      (o) => {
        const w = o.workers.find((x) => x.id === workerId);
        return w?.online === true && w.appliedVersion > 0n && w.appliedVersion === w.configVersion;
      },
      MINUTE,
    );
  };
  const killWorker = async () => {
    const proc = worker!;
    for (const pid of descendants(proc.pid)) leftovers.add(pid);
    proc.kill("SIGKILL");
    await proc.exited;
    await until("worker offline", () => gw.api.getOverview({}), (o) => o.workers.find((w) => w.id === workerId)?.online === false, 30_000);
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    const store = <A>(use: (s: GatewayStore["Service"]) => Effect.Effect<A, unknown>) => gw.runtime.runPromise(GatewayStore.use(use));
    let credential = "";
    ({ workerId, credential } = await store((s) => s.addWorker({ name: "live-durable", ownerUserId: gw.userId })));
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const config = join(dir, "worker.json");
    writeFileSync(config, JSON.stringify({ gateway_url: gw.grpcUrl, worker_id: workerId, credential, data_dir: dataDir }));
    chmodSync(config, 0o600);
    await startWorker();
    projectId = (await gw.api.createProject({ name: "Live durable" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
  }, 2 * MINUTE);

  afterAll(async () => {
    worker?.kill("SIGTERM");
    await worker?.exited;
    for (const pid of leftovers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await gw?.close();
    if (process.env["OA_TEST_LOG"] === "1") console.error(logs.join(""));
  });

  const newThread = async (title: string, provider: Provider, model: string) => {
    const thread = (
      await gw.api.createThread({ projectId, workspaceId, title, provider, providerProfileId: "cliproxyapi", model, permissionMode: PermissionMode.FULL_AUTO })
    ).thread!;
    await until("thread ready", () => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle", MINUTE);
    return thread.id;
  };
  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
    return updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
  };
  const commandRunning = (s: ui.ThreadSnapshot) => s.items.some((i) => i.item?.content.case === "commandExecution" && i.item.status === 1);
  const answers = (s: ui.ThreadSnapshot, turnId: string) =>
    s.items.filter((i) => i.turnId === turnId && i.item?.content.case === "agentMessage").map((i) => (i.item?.content.case === "agentMessage" ? i.item.content.value.text : ""));
  const statusName = (status: number) => ["unspecified", "in_progress", "completed", "failed", "declined", "interrupted"][status] ?? String(status);

  /** Kill mid-command, start again, wait until the turn is settled and the next message ran. */
  async function killMidTurn(threadId: string) {
    await gw.api.sendMessage({
      threadId,
      clientRequestId: Bun.randomUUIDv7(),
      text: "Run this exact shell command in the foreground and wait for it to finish: `sleep 25; echo slept-ok`. Then reply with the single word SLEPT.",
    });
    await until("command running", () => snapshot(threadId), commandRunning, 3 * MINUTE);
    await killWorker();
    // The harness may outlive its worker for a moment and finish what it was doing: give it time to write it down.
    await Bun.sleep(5_000);
    await startWorker();
    // First the gateway ends the turn ("worker restarted": the new process does not run it), then the new process's
    // reconciliation with the transcript replaces that with what really happened.
    const settled = await until(
      "turn settled from the transcript",
      () => snapshot(threadId),
      (s) => s.turns[0]?.status !== "running" && s.turns[0]?.interruptReason !== "worker restarted" && !s.items.some((i) => i.item?.status === 1),
      2 * MINUTE,
    );
    await gw.api.sendMessage({ threadId, clientRequestId: Bun.randomUUIDv7(), text: "Reply with the single word AFTER." });
    const after = await until("next turn done", () => snapshot(threadId), (s) => ["completed", "failed"].includes(s.turns[1]?.status ?? ""), 3 * MINUTE);
    return { settled, after };
  }

  /** The harness process (below the running worker) whose command line matches. */
  const harnessPid = (match: RegExp) =>
    descendants(worker!.pid).find((pid) => {
      try {
        return match.test(readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "));
      } catch {
        return false;
      }
    });

  /** Kill the harness mid-command while the worker lives on; the next message must run (a new harness process). */
  async function killHarnessMidTurn(threadId: string, match: RegExp) {
    await gw.api.sendMessage({
      threadId,
      clientRequestId: Bun.randomUUIDv7(),
      text: "Run this exact shell command in the foreground and wait for it to finish: `sleep 25; echo slept-ok`. Then reply with the single word SLEPT.",
    });
    await until("command running", () => snapshot(threadId), commandRunning, 3 * MINUTE);
    const pid = harnessPid(match);
    expect(pid, "harness process").toBeDefined();
    for (const child of descendants(pid!)) leftovers.add(child);
    process.kill(pid!, "SIGKILL");
    const settled = await until("turn settled", () => snapshot(threadId), (s) => s.turns[0]?.status !== "running" && !s.items.some((i) => i.item?.status === 1), 2 * MINUTE);
    await gw.api.sendMessage({ threadId, clientRequestId: Bun.randomUUIDv7(), text: "Reply with the single word AFTER." });
    const after = await until("next turn done", () => snapshot(threadId), (s) => ["completed", "failed"].includes(s.turns[1]?.status ?? ""), 3 * MINUTE);
    return { settled, after };
  }

  test("Codex app-server killed while the worker lives: failed in the harness (process exit), a new app-server takes the next turn", async () => {
    const threadId = await newThread("codex harness killed", Provider.CODEX, codexModel);
    const { settled, after } = await killHarnessMidTurn(threadId, /app-server/);
    const turn = settled.turns[0]!;
    console.info(`codex crash: turn ${turn.status} (${turn.errorSource || turn.interruptSource}: ${turn.error || turn.interruptReason}; ${turn.errorCode})`);
    expect(turn).toMatchObject({ status: "failed", errorSource: "harness", errorCode: "process_exit" });
    expect(turn.error).toContain("harness process exited");
    expect(settled.thread?.status).toBe("idle");
    expect(after.turns[1]?.status).toBe("completed");
    expect(answers(after, after.turns[1]!.id).join(" ")).toContain("AFTER");
  }, 12 * MINUTE);

  test("Claude Code process killed while the worker lives: settled from its transcript, the session resumes", async () => {
    const threadId = await newThread("claude harness killed", Provider.CLAUDE, claudeModel);
    const { settled, after } = await killHarnessMidTurn(threadId, /claude/i);
    const turn = settled.turns[0]!;
    console.info(`claude crash: turn ${turn.status} (${turn.errorSource || turn.interruptSource}: ${turn.error || turn.interruptReason}; ${turn.errorCode})`);
    expect(turn).toMatchObject({ status: "failed", errorSource: "harness", errorCode: "process_exit" });
    expect(settled.thread?.status).toBe("idle");
    expect(after.turns[1]?.status).toBe("completed");
    expect(answers(after, after.turns[1]!.id).join(" ")).toContain("AFTER");
  }, 12 * MINUTE);

  test("Codex: the turn ends as its rollout says, every recorded item matches, the thread goes on", async () => {
    const threadId = await newThread("codex killed mid-turn", Provider.CODEX, codexModel);
    const { settled, after } = await killMidTurn(threadId);
    const turn = settled.turns[0]!;
    const [row] = await query<{ provider_turn_ref: string | null; provider_thread_id: string }>(
      "SELECT u.provider_turn_ref, t.provider_thread_id FROM turns u JOIN threads t ON t.id = u.thread_id WHERE u.id = $1::uuid",
      turn.id,
    );
    const rollout = findFile(join(dataDir, "codex-home", "sessions"), (name) => name.endsWith(`${row!.provider_thread_id}.jsonl`));
    expect(rollout).toBeDefined();
    const records = jsonl(rollout!);
    const codexTurn = row!.provider_turn_ref!;
    const ended = records.find((r) => r.type === "event_msg" && ["task_complete", "turn_aborted"].includes(String(r.payload?.["type"])) && r.payload?.["turn_id"] === codexTurn);
    console.info(`codex: turn ${turn.status} (${turn.interruptSource || turn.errorSource}: ${turn.interruptReason || turn.error}); rollout end: ${ended?.payload?.["type"] ?? "none"}`);
    if (!ended) expect(turn).toMatchObject({ status: "interrupted", interruptSource: "system", interruptReason: "worker restarted mid-turn" });
    else if (ended.payload?.["type"] === "task_complete") expect(turn.status).toBe(ended.payload["error"] ? "failed" : "completed");
    // Codex aborts the turn when its worker dies (its input closes): nobody asked, so it is the system's.
    else expect(turn).toMatchObject({ status: "interrupted", interruptSource: "system", interruptReason: expect.stringContaining("worker restarted mid-turn") });
    // Every item Codex recorded for the turn is in the timeline with the same id and its real end.
    const recorded = records.filter((r) => r.type === "event_msg" && r.payload?.["type"] === "item_completed" && r.payload["turn_id"] === codexTurn);
    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      const item = r.payload!["item"] as { id: string; type: string; status?: string };
      const mine = settled.items.find((i) => i.item?.itemId === item.id);
      expect(mine, `item ${item.type} ${item.id}`).toBeDefined();
      if (item.status === "completed" || item.status === "failed") expect(statusName(mine!.item!.status)).toBe(item.status);
    }
    expect(settled.items.filter((i) => i.turnId === turn.id).every((i) => i.item?.status !== 1)).toBe(true);
    expect(after.turns[1]?.status).toBe("completed");
    expect(answers(after, after.turns[1]!.id).join(" ")).toContain("AFTER");
    expect(after.thread?.status).toBe("idle");
  }, 12 * MINUTE);

  test("Claude: the turn ends as its session transcript says, the open tool call ends, the session resumes", async () => {
    const threadId = await newThread("claude killed mid-turn", Provider.CLAUDE, claudeModel);
    const { settled, after } = await killMidTurn(threadId);
    const turn = settled.turns[0]!;
    const transcript = findFile(join(dataDir, "claude-home", "projects"), (name) => name === `${threadId}.jsonl`);
    expect(transcript).toBeDefined();
    const entries = jsonl(transcript!).filter((e) => (e.type === "assistant" || e.type === "user") && !e["isSidechain"]);
    const toolUses = entries.flatMap((e) => ((e["message"] as { content?: unknown })?.content instanceof Array ? ((e["message"] as { content: { type: string; id?: string }[] }).content) : []).filter((b) => b.type === "tool_use"));
    const results = new Set(entries.flatMap((e) => ((e["message"] as { content?: unknown })?.content instanceof Array ? ((e["message"] as { content: { type: string; tool_use_id?: string }[] }).content) : []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)));
    console.info(`claude: turn ${turn.status} (${turn.interruptSource || turn.errorSource}: ${turn.interruptReason || turn.error}); tool calls ${toolUses.length}, with results ${results.size}`);
    // The Bash call the worker died in: in the transcript without a result, so it ended as interrupted, and so did the turn.
    const bash = toolUses.at(-1)!;
    const item = settled.items.find((i) => i.item?.itemId === bash.id)?.item;
    expect(item).toBeDefined();
    if (!results.has(bash.id)) {
      expect(statusName(item!.status)).toBe("interrupted");
      expect(turn).toMatchObject({ status: "interrupted", interruptSource: "system", interruptReason: "worker restarted mid-turn" });
    }
    expect(settled.items.filter((i) => i.turnId === turn.id).every((i) => i.item?.status !== 1)).toBe(true);
    expect(after.turns[1]?.status).toBe("completed");
    expect(answers(after, after.turns[1]!.id).join(" ")).toContain("AFTER");
    expect(after.thread?.status).toBe("idle");
  }, 12 * MINUTE);
});

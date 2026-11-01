/**
 * Models, reasoning effort and steering end to end on PostgreSQL (docs/ui-api.md, docs/protocol.md):
 * the worker's model catalog reaches the UI, threads and messages pick a model and effort (validated against
 * the catalog) that StartTurn carries, and a message can join the running turn (steer) or fall back to the queue.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ui, type AgentToolResult } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let projectId = "";
let workspaceId = "";

const query = <A extends object>(text: string, ...params: unknown[]) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(text, params as never[]);
    }),
  );
const turns = (threadId: string) =>
  query<{ id: string; ordinal: number; status: string; trigger: string; model: string; effort: string; text: string }>(
    "SELECT id, ordinal, status, trigger, model, effort, input->>'text' AS text FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
    threadId,
  );
const steers = (threadId: string) => query<{ id: string; status: string; reason: string | null; queued_turn_id: string | null }>(
  "SELECT id, status, reason, queued_turn_id FROM turn_steers WHERE thread_id = $1::uuid ORDER BY created_at",
  threadId,
);
const json = (result: AgentToolResult) => JSON.parse(result.content) as Record<string, unknown>;

async function newThread(title: string, init: Partial<{ model: string; effort: string; initialMessage: string }> = {}) {
  return (
    await gw.api.createThread({ projectId, workspaceId, title, provider: Provider.CODEX, permissionMode: PermissionMode.ASK, clientRequestId: `create-${title}`, ...init })
  ).thread!;
}

/** A thread with a held (running) first turn. */
async function runningThread(title: string) {
  gw.worker.holdTurns = true;
  const thread = await newThread(title, { initialMessage: "long task" });
  const [turn] = await eventually(() => turns(thread.id), (t) => t[0]?.status === "running");
  return { thread, turnId: turn!.id };
}

describe.skipIf(!dockerAvailable)("models, effort and steering (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Models" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("the worker's catalog after its config: ListModels, and a refresh asks the worker again", async () => {
    const listed = await eventually(() => gw.api.listModels({}), (r) => r.workers.length === 1);
    const worker = listed.workers[0]!;
    expect([worker.workerId, worker.configVersion]).toEqual([gw.workerId, 1n]);
    expect(worker.profiles.map((p) => [p.provider, p.profileId, p.models.map((m) => m.id)])).toEqual([[Provider.CODEX, "native", ["gpt-6.1-sol", "gpt-5.5"]]]);
    expect(worker.profiles[0]!.models[0]).toMatchObject({ isDefault: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "low" });

    const [codex] = gw.worker.models;
    gw.worker.models = [{ provider: Provider.CODEX, profileId: "native", models: [...(codex?.models ?? []), { id: "gpt-6-luna", efforts: ["low"] }] }];
    const refreshed = await gw.api.listModels({ workerId: gw.workerId, refresh: true });
    expect(refreshed.workers[0]!.profiles[0]!.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-5.5", "gpt-6-luna"]);
  });

  test("thread defaults and per-message overrides reach StartTurn, validated against the catalog", async () => {
    expect(await failure(newThread("bad-model", { model: "gpt-9" }))).toContain('does not offer the model "gpt-9"');
    expect(await failure(newThread("bad-effort", { model: "gpt-5.5", effort: "xhigh" }))).toContain("supports the reasoning efforts low, medium, high");
    // Without a model the catalog's default model judges the effort.
    expect(await failure(newThread("bad-default-effort", { effort: "max" }))).toContain("GPT-6.1-Sol supports the reasoning efforts");

    gw.worker.holdTurns = false;
    const thread = await newThread("defaults", { model: "gpt-5.5", effort: "high", initialMessage: "one" });
    expect([thread.model, thread.effort]).toEqual(["gpt-5.5", "high"]);
    const [first] = await eventually(() => turns(thread.id), (t) => t[0]?.status === "completed");
    expect(gw.worker.turnSettings.get(first!.id)).toEqual({ model: "gpt-5.5", effort: "high" });
    expect([first!.model, first!.effort]).toEqual(["gpt-5.5", "high"]); // recorded as what the turn ran with

    // One message overrides both; the next one is back on the thread's defaults.
    const sent = await gw.api.sendMessage({ threadId: thread.id, text: "two", clientRequestId: "m-2", model: "gpt-6.1-sol", effort: "xhigh" });
    expect([sent.turn?.model, sent.turn?.effort, sent.steer]).toEqual(["gpt-6.1-sol", "xhigh", undefined]);
    await gw.api.sendMessage({ threadId: thread.id, text: "three", clientRequestId: "m-3" });
    const all = await eventually(() => turns(thread.id), (t) => t.length === 3 && t[2]?.status === "completed");
    expect(all.map((t) => gw.worker.turnSettings.get(t.id))).toEqual([
      { model: "gpt-5.5", effort: "high" },
      { model: "gpt-6.1-sol", effort: "xhigh" },
      { model: "gpt-5.5", effort: "high" },
    ]);
    expect(await failure(gw.api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "m-4", effort: "ultra" }))).toContain("not \"ultra\"");

    // New thread defaults apply to the turns after them; the UI hears about the change.
    const updated = (await gw.api.updateThread({ threadId: thread.id, model: "", effort: "medium" })).thread!;
    expect([updated.model, updated.effort]).toEqual(["", "medium"]);
    expect(await failure(gw.api.updateThread({ threadId: thread.id, model: "gpt-9" }))).toContain("does not offer");
    await gw.api.sendMessage({ threadId: thread.id, text: "four", clientRequestId: "m-5" });
    const fourth = (await eventually(() => turns(thread.id), (t) => t[3]?.status === "completed"))[3]!;
    expect(gw.worker.turnSettings.get(fourth.id)).toEqual({ model: "", effort: "medium" });
    const snapshot = (await watchUntil(gw.api, thread.id, (u) => u.length >= 1))[0]!;
    const view = snapshot.change.case === "snapshot" ? snapshot.change.value : undefined;
    expect(view?.thread?.effort).toBe("medium");
    expect(view?.turns.map((t) => [t.model, t.effort])).toEqual([
      ["gpt-5.5", "high"],
      ["gpt-6.1-sol", "xhigh"],
      ["gpt-5.5", "high"],
      ["", "medium"],
    ]);
  });

  test("steer: the message joins the running turn, shows where it entered, and is idempotent", async () => {
    gw.worker.steerMode = "accept";
    const { thread, turnId } = await runningThread("steer");
    const sent = await gw.api.sendMessage({ threadId: thread.id, text: "also do X", clientRequestId: "s-1", delivery: ui.MessageDelivery.STEER });
    expect(sent.turn).toBeUndefined();
    expect([sent.steer?.turnId, sent.steer?.text]).toEqual([turnId, "also do X"]);
    const steerId = sent.steer!.id;
    await eventually(() => steers(thread.id), (s) => s[0]?.status === "delivered");
    expect(gw.worker.steered.get(steerId)).toBe("also do X");

    const retry = await gw.api.sendMessage({ threadId: thread.id, text: "also do X", clientRequestId: "s-1", delivery: ui.MessageDelivery.STEER });
    expect(retry.steer?.id).toBe(steerId);
    expect(await steers(thread.id)).toHaveLength(1);

    // The snapshot has the steer and its user_message item (client_id) in the running turn.
    const updates = await watchUntil(gw.api, thread.id, (u) => u.length >= 1);
    const snapshot = updates[0]!.change.case === "snapshot" ? updates[0]!.change.value : undefined;
    expect(snapshot?.steers.map((s) => [s.id, s.status])).toEqual([[steerId, "delivered"]]);
    const item = snapshot?.items.find((i) => i.item?.content.case === "userMessage" && i.item.content.value.clientId === steerId);
    expect(item?.turnId).toBe(turnId);

    gw.worker.finish(thread.id, turnId);
    const done = await eventually(() => turns(thread.id), (t) => t[0]?.status === "completed");
    expect(done).toHaveLength(1); // nothing queued
  });

  test("steer without a running turn is queued like any message", async () => {
    gw.worker.holdTurns = false;
    const thread = await newThread("idle", { initialMessage: "first" });
    await eventually(() => turns(thread.id), (t) => t[0]?.status === "completed");
    const sent = await gw.api.sendMessage({ threadId: thread.id, text: "now", clientRequestId: "i-1", delivery: ui.MessageDelivery.STEER });
    expect([sent.steer, sent.turn?.inputText]).toEqual([undefined, "now"]);
    await eventually(() => turns(thread.id), (t) => t[1]?.status === "completed");
  });

  test("steer the worker cannot deliver (turn over, or taken and dropped) becomes the next turn with a reason", async () => {
    for (const mode of ["not_running", "drop"] as const) {
      gw.worker.steerMode = mode;
      const { thread, turnId } = await runningThread(`fallback-${mode}`);
      const sent = await gw.api.sendMessage({ threadId: thread.id, text: "late", clientRequestId: `f-${mode}`, delivery: ui.MessageDelivery.STEER, effort: "high" });
      const [steer] = await eventually(() => steers(thread.id), (s) => s[0]?.status === "queued");
      expect(steer?.reason).toBe("the turn ended before the message could join it");
      gw.worker.holdTurns = false;
      gw.worker.finish(thread.id, turnId);
      const all = await eventually(() => turns(thread.id), (t) => t[1]?.status === "completed");
      expect([all[1]?.id, all[1]?.text, all[1]?.trigger, all[1]?.effort]).toEqual([steer!.queued_turn_id ?? "", "late", "user", "high"]);
      const updates = await watchUntil(gw.api, thread.id, (u) => u.length >= 1);
      const snapshot = updates[0]!.change.case === "snapshot" ? updates[0]!.change.value : undefined;
      expect(snapshot?.steers.map((s) => [s.id, s.status, s.queuedTurnId])).toEqual([[sent.steer!.id, "queued", steer!.queued_turn_id ?? ""]]);
    }
    gw.worker.steerMode = "accept";
  });

  test("agent bus send_message with delivery = steer joins the target's running turn; the caller hears when it ends", async () => {
    gw.worker.holdTurns = false;
    const main = await newThread("orchestrator", { initialMessage: "plan" });
    await eventually(() => turns(main.id), (t) => t[0]?.status === "completed");
    gw.worker.holdTurns = true;
    const spawned = await gw.worker.callTool({ threadId: main.id, tool: "spawn_thread", args: { title: "Worker", prompt: "work" } });
    const sideId = json(spawned)["thread_id"] as string;
    const [sideTurn] = await eventually(() => turns(sideId), (t) => t[0]?.status === "running");

    const sent = await gw.worker.callTool({ threadId: main.id, tool: "send_message", args: { thread_id: sideId, prompt: "focus on tests", delivery: "steer" } });
    expect(json(sent)).toMatchObject({ thread_id: sideId, turn_id: sideTurn!.id, delivery: "steer" });
    await eventually(() => steers(sideId), (s) => s[0]?.status === "delivered");
    const steered = [...gw.worker.steered.values()].at(-1)!;
    expect(steered).toContain(`[open-agents] Message from the thread "orchestrator" (thread_id: ${main.id}):`);
    expect(steered).toContain("focus on tests");

    // One report for the spawn and the steer: both target the side thread's running turn.
    gw.worker.holdTurns = false;
    gw.worker.finish(sideId, sideTurn!.id, "tests fixed");
    const mainTurns = await eventually(() => turns(main.id), (t) => t.length === 3 && t.every((x) => x.status === "completed"));
    expect(mainTurns.slice(1).map((t) => t.trigger)).toEqual(["agent_bus", "agent_bus"]);
    expect(mainTurns.slice(1).every((t) => t.text.includes("tests fixed"))).toBe(true);
    expect(await turns(sideId)).toHaveLength(1);
  });

  test("model favorites are a user settings section", async () => {
    const current = await gw.api.getSettings({});
    const favorites = { models: [{ provider: Provider.CODEX, profileId: "native", model: "gpt-5.5" }, { provider: Provider.CLAUDE, profileId: "", model: "claude-haiku-5-5" }] };
    const saved = await gw.api.updateUserSettings({ modelFavorites: favorites, expectedVersion: current.user!.version });
    expect(saved.settings?.modelFavorites?.models.map((m) => m.model)).toEqual(["gpt-5.5", "claude-haiku-5-5"]);
    expect((await gw.api.getSettings({})).user?.modelFavorites?.models).toHaveLength(2);
    expect(await failure(gw.api.updateUserSettings({ modelFavorites: { models: [{ provider: Provider.CODEX, model: "" }] }, expectedVersion: saved.settings!.version }))).toContain(
      "needs a model id",
    );
  });
});

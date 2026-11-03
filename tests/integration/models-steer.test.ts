/**
 * Models, reasoning effort and steering end to end on PostgreSQL (docs/ui-api.md, docs/protocol.md):
 * the worker's model catalog reaches the UI, threads and messages pick a model and effort (validated against
 * the catalog) that StartTurn carries, and a message can join the running turn (steer) or fall back to the queue.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ui, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
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
    expect([worker.workerId, worker.configVersion]).toEqual([gw.workerId, 2n]);
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

  test("a turn carries no effort to a model without efforts; an effort the model lacks falls back to its default", async () => {
    const before = gw.worker.models;
    const [codex] = before;
    const withModels = async (models: typeof before) => {
      gw.worker.models = models;
      await gw.api.listModels({ workerId: gw.workerId, refresh: true });
    };
    await withModels([
      {
        provider: Provider.CODEX,
        profileId: "native",
        models: [
          ...(codex?.models ?? []),
          { id: "grok-5", displayName: "Grok 5", efforts: [] },
          { id: "gpt-5-mini", displayName: "GPT-5 mini", efforts: ["low", "medium"], defaultEffort: "medium" },
        ],
      },
    ]);
    gw.worker.holdTurns = false;
    const ran = async (threadId: string, n: number) => {
      const t = (await eventually(() => turns(threadId), (all) => all.length === n && all[n - 1]?.status === "completed"))[n - 1]!;
      return { sent: gw.worker.turnSettings.get(t.id), recorded: { model: t.model, effort: t.effort } };
    };

    // A new thread on a model without efforts keeps none as its default.
    expect((await newThread("no-effort-model", { model: "grok-5", effort: "high" })).effort).toBe("");

    const thread = await newThread("effort-fallback", { model: "gpt-6.1-sol", effort: "xhigh", initialMessage: "one" });
    expect((await ran(thread.id, 1)).sent).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    // Picking a model for one message: the thread's xhigh does not reach it.
    await gw.api.sendMessage({ threadId: thread.id, text: "two", clientRequestId: "fb-2", model: "grok-5" });
    expect(await ran(thread.id, 2)).toEqual({ sent: { model: "grok-5", effort: "" }, recorded: { model: "grok-5", effort: "" } });
    await gw.api.sendMessage({ threadId: thread.id, text: "three", clientRequestId: "fb-3", model: "grok-5", effort: "high" });
    expect((await ran(thread.id, 3)).sent).toEqual({ model: "grok-5", effort: "" });
    await gw.api.sendMessage({ threadId: thread.id, text: "four", clientRequestId: "fb-4", model: "gpt-5-mini" });
    expect((await ran(thread.id, 4)).sent).toEqual({ model: "gpt-5-mini", effort: "medium" });
    await gw.api.sendMessage({ threadId: thread.id, text: "five", clientRequestId: "fb-5", model: "gpt-6-luna" });
    expect((await ran(thread.id, 5)).sent).toEqual({ model: "gpt-6-luna", effort: "" }); // no default effort: none
    // A message's own effort is still judged against the model.
    expect(await failure(gw.api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "fb-x", model: "gpt-5-mini", effort: "xhigh" }))).toContain(
      'not "xhigh"',
    );

    // The thread's default follows a new model.
    expect((await gw.api.updateThread({ threadId: thread.id, model: "gpt-5-mini" })).thread!.effort).toBe("medium");
    expect((await gw.api.updateThread({ threadId: thread.id, model: "grok-5" })).thread!.effort).toBe("");
    expect(await failure(gw.api.updateThread({ threadId: thread.id, model: "gpt-5-mini", effort: "xhigh" }))).toContain('not "xhigh"');

    // A model the catalog does not know (incomplete list, free-text id) keeps today's behaviour.
    await withModels([{ provider: Provider.CODEX, profileId: "native", models: [...(codex?.models ?? [])], detail: "the proxy did not answer" }]);
    await gw.api.sendMessage({ threadId: thread.id, text: "six", clientRequestId: "fb-6", model: "my-proxy-model", effort: "high" });
    expect((await ran(thread.id, 6)).sent).toEqual({ model: "my-proxy-model", effort: "high" });
    await withModels(before);
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

  test("permission mode: per-message override and thread default reach StartTurn; a steer keeps the running turn's mode", async () => {
    gw.worker.holdTurns = false;
    const modes = (threadId: string) =>
      query<{ id: string; status: string; permission_mode: string }>(
        "SELECT id, status, permission_mode FROM turns WHERE thread_id = $1::uuid ORDER BY ordinal",
        threadId,
      );
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "modes",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.READ_ONLY,
        initialMessage: "one",
        clientRequestId: "create-modes",
      })
    ).thread!;
    expect(thread.permissionMode).toBe(PermissionMode.READ_ONLY);
    const [first] = await eventually(() => modes(thread.id), (t) => t[0]?.status === "completed");
    expect(gw.worker.turnModes.get(first!.id)).toEqual({ turn: PermissionMode.READ_ONLY, thread: PermissionMode.READ_ONLY });
    expect(first!.permission_mode).toBe("READ_ONLY"); // recorded as what the turn ran with

    // One message in FULL_AUTO; the next one is back on the thread's default.
    const sent = await gw.api.sendMessage({ threadId: thread.id, text: "two", clientRequestId: "pm-2", permissionMode: PermissionMode.FULL_AUTO });
    expect(sent.turn?.permissionMode).toBe(PermissionMode.FULL_AUTO);
    await gw.api.sendMessage({ threadId: thread.id, text: "three", clientRequestId: "pm-3" });
    let all = await eventually(() => modes(thread.id), (t) => t.length === 3 && t[2]?.status === "completed");
    expect(all.map((t) => gw.worker.turnModes.get(t.id)?.turn)).toEqual([PermissionMode.READ_ONLY, PermissionMode.FULL_AUTO, PermissionMode.READ_ONLY]);
    expect(all.map((t) => t.permission_mode)).toEqual(["READ_ONLY", "FULL_AUTO", "READ_ONLY"]);
    expect(await failure(gw.api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "pm-x", permissionMode: 42 as PermissionMode }))).toContain(
      "unknown permission mode",
    );

    // A new thread default: unset fields stay, the model and effort are untouched; ThreadSpec carries it too.
    const updated = (await gw.api.updateThread({ threadId: thread.id, permissionMode: PermissionMode.ACCEPT_EDITS })).thread!;
    expect([updated.permissionMode, updated.model]).toEqual([PermissionMode.ACCEPT_EDITS, thread.model]);
    expect((await gw.api.updateThread({ threadId: thread.id, effort: "" })).thread!.permissionMode).toBe(PermissionMode.ACCEPT_EDITS);
    await gw.api.sendMessage({ threadId: thread.id, text: "four", clientRequestId: "pm-4" });
    all = await eventually(() => modes(thread.id), (t) => t.length === 4 && t[3]?.status === "completed");
    expect(gw.worker.turnModes.get(all[3]!.id)).toEqual({ turn: PermissionMode.ACCEPT_EDITS, thread: PermissionMode.ACCEPT_EDITS });

    // A steer joins the running turn and runs in its mode; its own override is for a fallback turn.
    gw.worker.steerMode = "accept";
    gw.worker.holdTurns = true;
    await gw.api.sendMessage({ threadId: thread.id, text: "five", clientRequestId: "pm-5", permissionMode: PermissionMode.READ_ONLY });
    const running = (await eventually(() => modes(thread.id), (t) => t[4]?.status === "running"))[4]!;
    const steer = await gw.api.sendMessage({
      threadId: thread.id,
      text: "and this",
      clientRequestId: "pm-6",
      delivery: ui.MessageDelivery.STEER,
      permissionMode: PermissionMode.FULL_AUTO,
    });
    expect(steer.steer?.turnId).toBe(running.id);
    await eventually(() => steers(thread.id), (s) => s[0]?.status === "delivered");
    gw.worker.holdTurns = false;
    gw.worker.finish(thread.id, running.id);
    all = await eventually(() => modes(thread.id), (t) => t[4]?.status === "completed");
    expect(all).toHaveLength(5);
    expect(all[4]!.permission_mode).toBe("READ_ONLY");

    gw.worker.steerMode = "not_running";
    gw.worker.holdTurns = true;
    await gw.api.sendMessage({ threadId: thread.id, text: "six", clientRequestId: "pm-7" });
    const sixth = (await eventually(() => modes(thread.id), (t) => t[5]?.status === "running"))[5]!;
    await gw.api.sendMessage({ threadId: thread.id, text: "late", clientRequestId: "pm-8", delivery: ui.MessageDelivery.STEER, permissionMode: PermissionMode.FULL_AUTO });
    await eventually(() => steers(thread.id), (s) => s[1]?.status === "queued");
    gw.worker.holdTurns = false;
    gw.worker.finish(thread.id, sixth.id);
    all = await eventually(() => modes(thread.id), (t) => t[6]?.status === "completed");
    expect(all.slice(5).map((t) => t.permission_mode)).toEqual(["ACCEPT_EDITS", "FULL_AUTO"]);
    gw.worker.steerMode = "accept";

    // The snapshot shows each turn's mode and the thread's default.
    const snapshot = (await watchUntil(gw.api, thread.id, (u) => u.length >= 1))[0]!;
    const view = snapshot.change.case === "snapshot" ? snapshot.change.value : undefined;
    expect(view?.thread?.permissionMode).toBe(PermissionMode.ACCEPT_EDITS);
    expect(view?.turns.map((t) => t.permissionMode)).toEqual([
      PermissionMode.READ_ONLY,
      PermissionMode.FULL_AUTO,
      PermissionMode.READ_ONLY,
      PermissionMode.ACCEPT_EDITS,
      PermissionMode.READ_ONLY,
      PermissionMode.ACCEPT_EDITS,
      PermissionMode.FULL_AUTO,
    ]);
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

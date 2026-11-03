import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { bots, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { BotModel, BotTurn, ModelInput } from "../../apps/gateway/src/bots/types.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string) => ({ text, calls: [] });
const hidden = (i: ModelInput) => i.instructions.includes("Prepare a concise but complete handoff");

describe.skipIf(!dockerAvailable)("bot model handoff: durable hidden configuration barrier", () => {
  let gw: TestGateway;
  let core: GatewayCore;
  let model: BotModel;
  let id: string;
  const fresh = () => new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: Bun.randomUUIDv7(), botModel: (i) => model(i) });
  const query = <A extends object>(text: string, values: unknown[] = []) => gw.runtime.runPromise(Effect.gen(function* () { return yield* (yield* SqlClient.SqlClient).unsafe<A>(text, values); }));
  const read = () => core.bots.run((s) => s.conversation(gw.userId, id));
  const jobs = () => query<{ id: string; status: string }>("SELECT id, status FROM bot_turns WHERE bot_id = $1 AND handoff_configuration IS NOT NULL", [id]);
  const notes = () => query<{ note: string; model: string; fallback_reason: string }>("SELECT note, model, fallback_reason FROM bot_handoff_notes WHERE bot_id = $1 ORDER BY created_at, turn_id", [id]);
  const idle = async () => {
    const pending = await eventually(() => query("SELECT id FROM bot_turns WHERE bot_id = $1 AND status IN ('queued','running','waiting')", [id]), (r) => r.length === 0, 10000);
    expect(pending).toHaveLength(0); return read();
  };
  const send = (text: string) => core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() }));
  const change = async (patch: Partial<bots.BotConfiguration>) => {
    const configuration = (await core.bots.get(id)).configuration!;
    return gw.api.updateBot({ botId: id, configuration: { ...configuration, ...patch } });
  };
  beforeAll(async () => {
    gw = await startTestGateway();
    for (const provider of [Provider.CODEX, Provider.GROK]) await gw.api.saveProviderInstance({ harness: provider, id: "handoff-test", label: `Source ${Provider[provider]}`, create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture", allWorkers: true });
    for (const harness of [Provider.CODEX, Provider.GROK]) await gw.api.setInstanceModels({ harness, id: "handoff-test", models: { custom: ["model-a", "model-b", "model-c"] } });
  }, 30000);
  beforeEach(async () => {
    model = async () => reply("Confirmed: user's project codename is Fern.");
    core = fresh(); core.bots.start();
    id = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: { name: `Handoff ${Bun.randomUUIDv7()}`, shape: "round", color: "#22aaff", provider: Provider.CODEX, providerInstance: "handoff-test", model: "model-a", effort: "low", instructions: "Use short Polish answers.", approvalPolicy: "safe" } })).bot!.id;
    await send("Remember the project codename Fern"); await idle();
    await gw.api.markBotRead({ botId: id, throughSeq: (await read()).messages.at(-1)!.seq });
  });
  afterEach(async () => { await core.bots.stop(); await gw.api.deleteBot({ botId: id }); });
  afterAll(async () => { await gw?.close(); });

  test("old configuration writes one invisible note; new provider gets the note and its actual identity", async () => {
    const baseline = await read(); const seen: ModelInput[] = [];
    model = async (i) => { seen.push(i); return reply(hidden(i) ? "Fern; answer briefly in Polish. Next: review the release." : "Current model-b, GROK; Fern."); };
    await change({ provider: Provider.GROK, model: "model-b", effort: "" });
    await idle();
    expect(await jobs()).toHaveLength(1);
    expect(await notes()).toEqual([expect.objectContaining({ model: "model-a", note: "Fern; answer briefly in Polish. Next: review the release.", fallback_reason: "" })]);
    const after = await read();
    expect(after.messages).toEqual(baseline.messages); expect(after.bot?.unreadCount).toBe(0);
    expect(after.working).toBe(false); expect(after.statusLine).toBe("");
    expect(seen[0]?.configuration).toMatchObject({ provider: Provider.CODEX, model: "model-a", effort: "low", providerInstance: "handoff-test" });
    expect(seen[0]?.tools).toEqual([]); expect(seen[0]?.messages.some((m) => m.text.includes("codename Fern"))).toBe(true);
    await send("Which model is answering, and what is my project called?"); await idle();
    expect(seen[1]?.configuration).toMatchObject({ provider: Provider.GROK, model: "model-b" });
    expect(seen[1]?.instructions).toContain("Handoff from your previous model (model-a)");
    expect(seen[1]?.instructions).toContain("Next: review the release");
    expect(seen[1]?.instructions).toContain('provider instance "Source GROK"');
    expect(seen[1]?.instructions).toContain("model id model-b");
    expect(seen[1]?.instructions).toContain("Earlier messages may have been written by other models");
  });

  test("messages wait for a running handoff and rapid A→B→C changes keep the original source", async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const seen: ModelInput[] = [];
    model = async (i) => { seen.push(i); if (hidden(i)) { entered.resolve(); await release.promise; return reply("Fern; continue the open release review."); } return reply("Continued"); };
    await change({ model: "model-b" }); await entered.promise;
    await change({ model: "model-c", effort: "" });
    await send("Continue now");
    await core.bots.tick();
    expect(seen).toHaveLength(1); expect(await jobs()).toHaveLength(1); expect(await notes()).toHaveLength(0);
    release.resolve(); await idle();
    expect(seen.map((i) => i.configuration.model)).toEqual(["model-a", "model-c"]);
    expect(seen[1]?.instructions).toContain("continue the open release review");
    expect(await notes()).toHaveLength(1);
  });

  test("handoff waits for the active old turn, then runs ahead of messages already queued before the change", async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const seen: ModelInput[] = [];
    model = async (i) => {
      seen.push(i);
      if (seen.length === 1) { entered.resolve(); await release.promise; return reply("The active turn agreed on Friday rollout."); }
      if (hidden(i)) { expect(i.messages.some((m) => m.text.includes("Friday rollout"))).toBe(true); return reply("Friday rollout is agreed."); }
      expect(i.instructions).toContain("Friday rollout is agreed"); return reply("Next message answered");
    };
    await send("Hold the active turn"); await entered.promise;
    await send("Already queued before changing model");
    await change({ model: "model-b" }); await core.bots.tick();
    expect(seen).toHaveLength(1);
    release.resolve(); await idle();
    expect(seen.map((i) => [i.configuration.model, hidden(i)])).toEqual([["model-a", false], ["model-a", true], ["model-b", false]]);
  });

  test("source receives tool results and hidden routine knowledge beyond a long visible history prefix", async () => {
    await gw.api.createProject({ name: "Tool result: ORCHID_RELEASE" });
    const seedTurn = (await query<BotTurn>("SELECT * FROM bot_turns WHERE bot_id = $1 LIMIT 1", [id]))[0]!;
    const routine = await core.bots.run((s) => s.createRoutine(gw.userId, seedTurn, Bun.randomUUIDv7(), { title: "Hidden release check", instructions: "Check projects and silently remember the release fact", cron: "*/15 * * * *", timezone: "UTC" }, new Date()));
    // A real checkpoint contains its visible history prefix; it must not crowd out the result.
    await query("UPDATE bot_messages SET text = repeat('Long visible conversation. ', 1000) WHERE bot_id = $1::uuid AND sender_id = $1::text", [id]);
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply("Internal learned fact: deploy orchids only at dawn.") : { text: "", calls: [{ id: "projects", name: "list_projects", arguments: {} }] };
    await core.bots.run((s) => s.deliverRoutines(gw.userId, timestampDate(routine.nextRunAt!))); await idle();
    const baseline = (await read()).messages;
    model = async (i) => {
      expect(i.instructions).toContain("ORCHID_RELEASE"); expect(i.instructions).toContain("deploy orchids only at dawn");
      expect(i.instructions).toContain("Hidden release check"); expect(i.tools).toEqual([]);
      return reply("Deploy orchids at dawn; continue the release check.");
    };
    await change({ model: "model-b" }); await idle();
    expect((await notes())[0]?.fallback_reason).toBe(""); expect((await read()).messages).toEqual(baseline);
  });

  test("source failure deterministically retains recent messages, standing instructions, routines and reminders", async () => {
    const seed = (await query<{ id: string }>("SELECT id FROM bot_turns WHERE bot_id = $1 LIMIT 1", [id]))[0]!.id;
    const seedTurn = (await query<BotTurn>("SELECT * FROM bot_turns WHERE id = $1", [seed]))[0]!;
    await core.bots.run((s) => s.createRoutine(gw.userId, seedTurn, Bun.randomUUIDv7(), { title: "Release watch", instructions: `Check release; notify only on blockers. ${"Context ".repeat(1500)}`, cron: "*/15 * * * *", timezone: "UTC" }, new Date()));
    const callId = Bun.randomUUIDv7();
    await query("INSERT INTO bot_tool_calls(id, turn_id, call_key, tool, arguments) VALUES ($1,$2,'reminder','{}','{}')", [callId, seed]);
    await query("INSERT INTO bot_wakeups(id,bot_id,prompt,run_at,hops) VALUES ($1,$2,'Review release tomorrow',now() + interval '1 day',1)", [callId, id]);
    model = async (i) => { if (hidden(i)) throw new Error("sensitive provider error must not be logged"); return reply("Continued"); };
    const baseline = (await read()).messages;
    await change({ model: "model-b" }); await idle();
    const note = (await notes())[0]!;
    expect(note.fallback_reason).toBe("source_unavailable_or_failed");
    for (const text of ["Fern", "short Polish", "Release watch", "notify only on blockers", "Review release tomorrow"]) expect(note.note).toContain(text);
    expect(note.note).not.toContain("sensitive provider error"); expect((await read()).messages).toEqual(baseline);
    await send("Continue"); await idle();
  });

  test("expired durable deadline releases queued messages without invoking the source model", async () => {
    await core.bots.stop();
    await change({ model: "model-b" });
    await query("UPDATE bot_turns SET handoff_deadline = now() - interval '1 second' WHERE bot_id = $1 AND handoff_configuration IS NOT NULL", [id]);
    const seen: ModelInput[] = []; model = async (i) => { seen.push(i); return reply("Continued"); };
    core = fresh(); await send("Continue after downtime"); core.bots.start(); await idle();
    expect(seen.map((i) => i.configuration.model)).toEqual(["model-b"]);
    expect((await notes())[0]?.fallback_reason).toBe("deadline_exceeded");
    expect(seen[0]?.instructions).toContain("Fern");
  });

  test("an unresponsive source cannot hold user messages beyond the persisted deadline or publish a late note", async () => {
    await core.bots.stop(); await change({ model: "model-b" });
    await query("UPDATE bot_turns SET handoff_deadline = now() + interval '1 second' WHERE bot_id = $1 AND handoff_configuration IS NOT NULL", [id]);
    const entered = Promise.withResolvers<void>(); const late = Promise.withResolvers<void>();
    let sourceSignal: AbortSignal | undefined;
    model = async (i) => {
      if (hidden(i)) { sourceSignal = i.signal; entered.resolve(); await late.promise; return reply("Too late"); }
      expect(i.instructions).toContain("Deterministic handoff"); return reply("User message proceeded");
    };
    core = fresh(); core.bots.start(); await entered.promise;
    await send("Do not lose this message");
    const final = await idle();
    expect(final.messages.at(-1)?.text).toBe("User message proceeded");
    expect(sourceSignal?.aborted).toBe(true);
    expect((await notes())[0]?.fallback_reason).toBe("deadline_exceeded");
    late.resolve(); await core.bots.tick();
    expect(await notes()).toHaveLength(1); expect((await notes())[0]?.note).not.toContain("Too late");
  });

  test("a removed old instance falls back without a source call", async () => {
    const old = "handoff-disposable";
    await gw.api.saveProviderInstance({ harness: Provider.CODEX, id: old, label: "Disposable", create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture", allWorkers: true });
    await gw.api.setInstanceModels({ harness: Provider.CODEX, id: old, models: { custom: ["model-a"] } });
    await change({ providerInstance: old }); await idle();
    await core.bots.stop(); await change({ providerInstance: "handoff-test", model: "model-b" });
    await gw.api.deleteProviderInstance({ harness: Provider.CODEX, id: old });
    let calls = 0;
    model = async () => { calls++; throw new Error("removed source must not be called"); };
    core = fresh(); core.bots.start(); await idle();
    expect(calls).toBe(0);
    expect((await notes()).at(-1)?.fallback_reason).toBe("source_unavailable_or_failed");
    expect((await notes()).at(-1)?.note).toContain("Fern");
  });

  test("restart recovers the checkpoint and commits exactly one note, then later handoffs accumulate it", async () => {
    await core.bots.stop(); await change({ model: "model-b" });
    const claims = await Promise.all([core.bots.run((s) => s.claim(gw.userId)), core.bots.run((s) => s.claim(gw.userId))]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const turn = claims.find((t) => t !== undefined)!;
    const history = await core.bots.run((s) => s.history(turn));
    await core.bots.run((s) => s.checkpoint(turn, [...history, { role: "assistant", text: "Fern; promise: review the release." }]));
    await core.bots.run((s) => s.release(turn));
    await query("UPDATE bot_turns SET handoff_deadline = now() - interval '1 second' WHERE id = $1", [turn.id]);
    core = fresh(); let calls = 0; model = async () => { calls++; return reply("unexpected"); };
    core.bots.start(); await idle(); await core.bots.tick();
    expect(calls).toBe(0); expect(await notes()).toEqual([expect.objectContaining({ note: "Fern; promise: review the release.", fallback_reason: "" })]);
    let second: ModelInput | undefined;
    model = async (i) => { second = i; return reply("Fern; release review still pending; also check rollout."); };
    await change({ model: "model-c" }); await idle();
    expect(second?.configuration.model).toBe("model-b");
    expect(second?.instructions).toContain("promise: review the release");
    expect(await notes()).toHaveLength(2);
    await send("Continue"); await idle();
    expect(second?.instructions).toContain("Handoff from your previous model (model-b)");
    expect(second?.instructions).toContain("also check rollout");
    expect(second?.instructions).not.toContain("Handoff from your previous model (model-a)");
  });

  test("approved update_self queues the old configuration; persona-only edits and empty bots do not", async () => {
    model = async (i) => hidden(i) ? reply("Fern; preserve the user's preferences") : i.messages.at(-1)?.role === "tool" ? reply("Settings updated") : { text: "", calls: [{ id: "edit", name: "update_self", arguments: { model: "model-b" } }] };
    await send("Change your model");
    const waiting = await eventually(read, (s) => s.approvals.some((a) => a.status === "pending"));
    expect(await jobs()).toHaveLength(0);
    await core.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: waiting.approvals.find((a) => a.status === "pending")!.id, approve: true }));
    await idle(); expect(await notes()).toEqual([expect.objectContaining({ model: "model-a" })]);
    await change({ instructions: "Use even shorter answers" }); await idle(); expect(await jobs()).toHaveLength(1);
    const empty = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: { ...(await core.bots.get(id)).configuration!, name: `Empty ${Bun.randomUUIDv7()}` } })).bot!;
    try {
      await gw.api.updateBot({ botId: empty.id, configuration: { ...empty.configuration!, model: "model-c" } });
      expect(await query("SELECT id FROM bot_turns WHERE bot_id = $1", [empty.id])).toHaveLength(0);
    } finally { await gw.api.deleteBot({ botId: empty.id }); }
  });
});

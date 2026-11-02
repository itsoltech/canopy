import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { bots, Provider, ProviderProfileKind } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayCore } from "@open-agents/gateway/core";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { PLATFORM_TOOLS } from "../../apps/gateway/src/bots/policy.ts";
import type { BotModel, ModelInput, ModelReply } from "../../apps/gateway/src/bots/types.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text = "Internal: nothing important") => ({ text, calls: [] });
const tool = (name: string, args: Record<string, unknown>): ModelReply => ({ text: "Internal progress", calls: [{ id: "requested", name, arguments: args }] });
const inputOf = (i: ModelInput) => i.messages.findLast((m) => m.role === "user")?.text ?? "";
const definition = { title: "Check important changes", instructions: "Check X; notify me only if Y is important. Otherwise remain silent.", cron: "*/15 * * * *", timezone: "Europe/Warsaw" };

describe.skipIf(!dockerAvailable)("bot routines: durable scheduling and hidden tool loop", () => {
  let gw: TestGateway;
  let core: GatewayCore;
  let clock: Date;
  let model: BotModel;
  let ids: string[] = [];
  const fresh = () => new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: Bun.randomUUIDv7(), botClock: () => clock, botModel: (i) => model(i) });
  const query = <A extends object>(text: string, values: unknown[] = []) => gw.runtime.runPromise(Effect.gen(function* () { return yield* (yield* SqlClient.SqlClient).unsafe<A>(text, values); }));
  const read = (id: string) => core.bots.run((s) => s.conversation(gw.userId, id));
  const idle = async (id: string) => {
    const pending = await eventually(() => query("SELECT id FROM bot_turns WHERE bot_id = $1 AND status IN ('queued','running','waiting')", [id]), (r) => r.length === 0, 10_000);
    expect(pending).toHaveLength(0);
    return read(id);
  };
  const add = async () => {
    const bot = (await gw.api.createBot({ clientRequestId: Bun.randomUUIDv7(), configuration: { name: `Routine ${Bun.randomUUIDv7()}`, shape: "round", color: "#22aaff", provider: Provider.CODEX, providerInstance: "routines-test", model: "gpt-6.1-sol", approvalPolicy: "always" } })).bot!;
    ids.push(bot.id); return bot.id;
  };
  const send = async (id: string, text: string) => { await core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() })); return idle(id); };
  const make = async (id: string, patch = {}) => {
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply("Routine is ready") : tool("create_routine", { ...definition, ...patch });
    const snapshot = await send(id, "Every 15 min check X and tell me only if Y");
    expect(snapshot.approvals).toHaveLength(0);
    expect(snapshot.routines).toHaveLength(1);
    return snapshot.routines[0]!;
  };
  const due = async (r: bots.BotRoutine) => { clock = timestampDate(r.nextRunAt!); await core.bots.tick(); };
  beforeAll(async () => {
    gw = await startTestGateway();
    await gw.api.saveProviderInstance({ harness: Provider.CODEX, id: "routines-test", label: "Routines test", create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture", allWorkers: true });
  }, 30_000);
  beforeEach(() => { clock = new Date("2030-01-07T08:01:00Z"); core = fresh(); ids = []; model = async () => reply(); });
  afterEach(async () => { await core.bots.stop(); for (const id of ids) await gw.api.deleteBot({ botId: id }); });
  afterAll(async () => { await gw?.close(); });

  test("a tool-created routine fires silently, retains context and audit, and changes the stream without a new last message", async () => {
    const id = await add(); const r = await make(id);
    expect(r.scheduleText).toContain("15 minutes");
    const before = await read(id);
    expect(before.bot?.unreadCount).toBe(1);
    await gw.api.markBotRead({ botId: id, throughSeq: before.messages.at(-1)!.seq });
    const baseline = await read(id);
    expect(baseline.bot?.unreadCount).toBe(0);
    const seen: ModelInput[] = [];
    model = async (i) => { seen.push(i); return reply("Invisible final answer"); };
    await due(r);
    const final = await idle(id);
    expect(final.messages).toEqual(baseline.messages);
    expect(final.bot?.lastMessage?.id).toBe(baseline.bot?.lastMessage?.id);
    expect(final.statusLine).toBe(""); expect(final.working).toBe(false);
    expect(final.bot?.unreadCount).toBe(0);
    expect(final.routines[0]?.runCount).toBe(1);
    expect(final.routines[0]?.lastOutcome).toBe("Nothing to report");
    expect(seen[0]?.instructions).toContain("HIDDEN BACKGROUND RUN");
    expect(seen[0]?.messages.some((m) => m.text.includes("Every 15 min"))).toBe(true);
    expect(inputOf(seen[0]!)).toContain(definition.instructions);
    const audit = await query<{ checkpoint: unknown }>("SELECT checkpoint FROM bot_turns WHERE bot_id = $1 AND routine_id = $2", [id, r.id]);
    expect(JSON.stringify(audit)).toContain("Invisible final answer");
    const abort = new AbortController();
    for await (const event of core.bots.watch(id, abort.signal)) { expect(event.routines[0]?.runCount).toBe(1); break; }
    abort.abort();
  });

  test("message_user is deliberate, visible exactly once after a checkpoint restart, even under always policy", async () => {
    const id = await add(); const r = await make(id);
    const baseline = (await read(id)).messages.length;
    await gw.api.markBotRead({ botId: id, throughSeq: (await read(id)).messages.at(-1)!.seq });
    clock = timestampDate(r.nextRunAt!);
    await core.bots.run((s) => s.deliverRoutines(gw.userId, clock));
    const turn = (await core.bots.run((s) => s.claim(gw.userId)))!;
    const spec = PLATFORM_TOOLS.find((t) => t.name === "message_user")!;
    const key = "persisted-message";
    const call = await core.bots.run((s) => s.planCall(turn, key, spec, { text: "Important Y happened" }));
    const history = await core.bots.run((s) => s.history(turn));
    await core.bots.run((s) => s.checkpoint(turn, [...history, { role: "assistant", text: "Hidden progress", calls: [{ id: key, name: spec.name, arguments: call.arguments }] }]));
    await gw.runtime.runPromise(BotStore.use((s) => s.action(turn, call, s.messageUser(turn, call))));
    await core.bots.run((s) => s.release(turn));
    await core.bots.stop(); core = fresh();
    model = async () => reply("Invisible completed");
    await core.bots.tick();
    const final = await idle(id);
    expect(final.messages).toHaveLength(baseline + 1);
    expect(final.messages.at(-1)?.text).toBe("Important Y happened");
    expect(final.messages.at(-1)?.recipientId).toBe("user");
    expect(final.approvals).toHaveLength(0);
    expect(final.routines[0]?.lastOutcome).toBe("Sent you a message");
    expect(final.bot?.unreadCount).toBe(1);
    const readResult = (await gw.api.markBotRead({ botId: id, throughSeq: final.messages.at(-1)!.seq })).bot!;
    expect(readResult.unreadCount).toBe(0);
    expect(readResult.lastMessage?.text).toBe("Important Y happened");
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply() : tool("message_user", { text: "Another important update" });
    await due(final.routines[0]!);
    const next = await idle(id);
    expect(next.messages).toHaveLength(baseline + 2);
    expect(next.messages.at(-1)?.text).toBe("Another important update");
    expect(next.approvals).toHaveLength(0);
    expect(next.bot?.unreadCount).toBe(1);
  });

  test("disabled/deleted routines cannot run, including an occurrence already queued", async () => {
    const id = await add(); let r = await make(id);
    model = async () => { throw new Error("must not run"); };
    clock = timestampDate(r.nextRunAt!);
    await core.bots.run((s) => s.deliverRoutines(gw.userId, clock));
    await gw.api.setBotRoutineEnabled({ botId: id, routineId: r.id, enabled: false });
    await core.bots.tick();
    expect((await idle(id)).routines[0]?.enabled).toBe(false);
    r = await core.bots.setRoutineEnabled(create(bots.SetBotRoutineEnabledRequestSchema, { botId: id, routineId: r.id, enabled: true }));
    clock = timestampDate(r.nextRunAt!);
    await core.bots.run((s) => s.deliverRoutines(gw.userId, clock));
    await gw.api.deleteBotRoutine({ botId: id, routineId: r.id });
    await core.bots.tick();
    expect((await idle(id)).routines).toHaveLength(0);
    expect(await query("SELECT id FROM bot_turns WHERE routine_id = $1 AND status = 'completed'", [r.id])).toHaveLength(0);
  });

  test("competing gateways and restart coalesce missed occurrences and never double-claim a scheduled run", async () => {
    const id = await add(); const r = await make(id);
    clock = new Date(timestampDate(r.nextRunAt!).getTime() + 24 * 60 * 60_000);
    await Promise.all([core.bots.run((s) => s.deliverRoutines(gw.userId, clock)), core.bots.run((s) => s.deliverRoutines(gw.userId, clock))]);
    await core.bots.stop(); core = fresh();
    let calls = 0; model = async () => { calls++; return reply(); };
    await core.bots.tick(); await idle(id); await core.bots.tick();
    const final = await read(id);
    expect(calls).toBe(1); expect(final.routines[0]?.runCount).toBe(1);
    expect(timestampDate(final.routines[0]!.nextRunAt!).getTime()).toBeGreaterThan(clock.getTime());
    expect(await query("SELECT id FROM bot_turns WHERE routine_id = $1", [r.id])).toHaveLength(1);
  });

  test("routine work queues behind a user turn, while real approvals remain visible and attributed", async () => {
    const id = await add(); const r = await make(id);
    const held = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    let foreground = true; let overlapped = false;
    model = async (i) => {
      if (inputOf(i) === "Hold this conversation") { entered.resolve(); await held.promise; foreground = false; return reply("Visible answer"); }
      if (foreground) overlapped = true;
      if (i.messages.at(-1)?.role === "tool") return reply();
      return tool("ask_user", { question: "A real decision is needed", options: ["Proceed", "Stop"] });
    };
    await core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: id, text: "Hold this conversation", clientRequestId: Bun.randomUUIDv7() }));
    await entered.promise; await due(r);
    expect(overlapped).toBe(false);
    const pending = await query("SELECT id FROM bot_turns WHERE routine_id = $1 AND status = 'queued'", [r.id]);
    expect(pending).toHaveLength(1);
    held.resolve();
    await eventually(() => read(id), (s) => s.messages.at(-1)?.text === "Visible answer");
    await core.bots.tick();
    const waiting = await eventually(() => read(id), (s) => s.approvals.some((a) => a.status === "pending"));
    expect(waiting.approvals[0]?.routineTitle).toBe(r.title);
    expect(waiting.messages.at(-1)?.text).toBe("Visible answer");
    await gw.api.answerBotApproval({ approvalId: waiting.approvals[0]!.id, approve: true, answer: "Proceed" });
    await core.bots.tick(); await idle(id);
  });

  test("owner and bot scoping applies to UI toggles/deletion and routine tools", async () => {
    const id = await add(); const r = await make(id); const other = await add();
    expect(await failure(gw.api.setBotRoutineEnabled({ botId: other, routineId: r.id, enabled: false }))).toContain("not found");
    expect(await failure(gw.api.deleteBotRoutine({ botId: other, routineId: r.id }))).toContain("not found");
    const stranger = new GatewayCore({ runtime: gw.runtime, instanceId: "stranger", userId: Bun.randomUUIDv7() });
    expect(await failure(stranger.bots.setRoutineEnabled(create(bots.SetBotRoutineEnabledRequestSchema, { botId: id, routineId: r.id, enabled: false })))).toContain("not found");
    expect(await failure(stranger.bots.deleteRoutine(create(bots.DeleteBotRoutineRequestSchema, { botId: id, routineId: r.id })))).toContain("not found");
    expect(await failure(stranger.bots.markRead(create(bots.MarkBotReadRequestSchema, { botId: id, throughSeq: 1n })))).toContain("not found");
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply(i.messages.at(-1)!.text) : tool("delete_routine", { routine_id: r.id });
    expect((await send(other, "Delete that routine")).messages.at(-1)?.text).toContain("not found");
    expect((await read(id)).routines[0]?.enabled).toBe(true);
  });

  test("a busy run coalesces later ticks, and disabling an active model fences out its late answer", async () => {
    const id = await add(); const r = await make(id);
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    model = async () => { entered.resolve(); await release.promise; return reply("Must stay invisible after disabling"); };
    await due(r); await entered.promise;
    clock = new Date(clock.getTime() + 24 * 60 * 60_000);
    await core.bots.tick();
    expect(await query("SELECT id FROM bot_turns WHERE routine_id = $1", [r.id])).toHaveLength(1);
    expect((await read(id)).working).toBe(false);
    await gw.api.setBotRoutineEnabled({ botId: id, routineId: r.id, enabled: false });
    release.resolve();
    await idle(id);
    expect((await read(id)).routines[0]?.lastOutcome).toBe("Stopped");
    expect(await query("SELECT id FROM bot_messages WHERE text LIKE '%Must stay invisible%' AND bot_id = $1", [id])).toHaveLength(0);
  });

  test("a reply from another bot returns to the routine as hidden work with its notification instructions", async () => {
    const id = await add(); const other = await add(); const r = await make(id);
    const bot = (await gw.api.getBot({ botId: id })).bot!;
    await gw.api.updateBot({ botId: id, configuration: { ...bot.configuration!, approvalPolicy: "safe" } });
    const otherName = (await gw.api.getBot({ botId: other })).bot!.configuration!.name;
    let followup: ModelInput | undefined;
    model = async (i) => {
      if (i.configuration.name === otherName) return reply("No important changes");
      if (inputOf(i).includes("Message from")) { followup = i; return reply("Silent follow-up final"); }
      return i.messages.at(-1)?.role === "tool" ? reply() : tool("send_bot_message", { bot_id: other, text: "Check if anything important happened" });
    };
    const baseline = (await read(id)).messages.length;
    await due(r); await idle(id);
    await core.bots.tick(); await idle(other);
    await core.bots.tick(); const final = await idle(id);
    expect(followup?.instructions).toContain("HIDDEN BACKGROUND RUN");
    expect(inputOf(followup!)).toContain(definition.instructions);
    expect(final.messages).toHaveLength(baseline + 1); // Only the deliberate “Messaged …” effect.
    expect(final.messages.at(-1)?.text).toStartWith("Messaged ");
    expect(final.messages.some((m) => m.text.includes("Silent follow-up") || m.text.includes("No important changes"))).toBe(false);
    expect(await query("SELECT id FROM bot_turns WHERE bot_id = $1 AND routine_id = $2", [id, r.id])).toHaveLength(2);
  });

  test("minimum interval, timezone, count and hops are enforced in the real tool path; edits preserve fields", async () => {
    const id = await add();
    for (const bad of [{ cron: "* * * * *" }, { cron: "0,1,30 * * * *" }, { timezone: "Invalid/Nowhere" }]) {
      model = async (i) => i.messages.at(-1)?.role === "tool" ? reply(i.messages.at(-1)!.text) : tool("create_routine", { ...definition, ...bad });
      const result = await send(id, "Set up a routine"); expect(result.routines).toHaveLength(0); expect(result.messages.at(-1)?.text).toContain("error");
    }
    let r = await make(id);
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply("Updated") : tool("update_routine", { routine_id: r.id, title: "Weekday check", cron: "0 9,16 * * 1-5", enabled: false });
    r = (await send(id, "Change the times and pause it")).routines[0]!;
    expect(r.title).toBe("Weekday check"); expect(r.enabled).toBe(false); expect(r.instructions).toBe(definition.instructions);
    expect(r.scheduleText).toContain("09:00"); expect(r.scheduleText).toContain("16:00");
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply("Created") : tool("create_routine", definition);
    for (let n = 1; n < 20; n++) await send(id, "Add another requested routine");
    const limited = await send(id, "Add a 21st routine"); expect(limited.routines).toHaveLength(20);
    expect(JSON.stringify(await query("SELECT result FROM bot_tool_calls WHERE result::text LIKE '%at most 20%'"))).toContain("at most 20");
    const other = await add();
    const turnId = await core.bots.run((s) => s.enqueue(gw.userId, other, "Exhausted chain", Bun.randomUUIDv7(), { hops: 8 }));
    await core.bots.tick(); await idle(other);
    expect(JSON.stringify(await query("SELECT c.result FROM bot_tool_calls c WHERE c.turn_id = $1", [turnId]))).toContain("hop limit");
  }, 30_000);
});

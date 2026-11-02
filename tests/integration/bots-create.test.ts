import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import { bots, ProfileModelsSchema, Provider, ProviderProfileKind } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayCore } from "@open-agents/gateway/core";
import { GatewayStore } from "@open-agents/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { botPlatform } from "../../apps/gateway/src/bots/platform.ts";
import { MAX_BOTS_PER_USER } from "../../apps/gateway/src/bots/store.ts";
import type { BotModel, ModelReply, StoredCall } from "../../apps/gateway/src/bots/types.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string): ModelReply => ({ text, calls: [] });
describe.skipIf(!dockerAvailable)("create_bot through the durable gateway loop", () => {
  let gw: TestGateway;
  let core: GatewayCore;
  let model: BotModel = async () => reply("Hello");
  const options = () => ({ runtime: gw.runtime, userId: gw.userId, instanceId: "create-test", botModel: (i: Parameters<BotModel>[0]) => model(i) });
  const config = (name: string) => create(bots.BotConfigurationSchema, { name, shape: "round", color: "#f97316", provider: Provider.CODEX, providerInstance: "create-test", model: "gpt-parent", effort: "high", approvalPolicy: "safe" });
  const add = async (name: string) => (await gw.api.createBot({ configuration: config(name), clientRequestId: Bun.randomUUIDv7() })).bot!;
  const read = (id: string) => core.bots.run((s) => s.conversation(gw.userId, id));
  const settled = (id: string) => eventually(() => read(id), (s) => !s.working, 10_000);
  const send = (id: string, text = "Create the requested bot") => core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() }));
  const propose = (args: Record<string, unknown>, tool = "create_bot") => {
    model = async (i) => i.messages.at(-1)?.role === "tool" ? reply(i.messages.at(-1)!.text) : { text: "", calls: [{ id: "create", name: tool, arguments: args }] };
  };
  const waiting = (id: string) => eventually(() => read(id), (s) => s.approvals.some((a) => a.status === "pending"), 10_000);
  const answer = (id: string, approve: boolean) => core.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: id, approve }));
  const query = <A extends object>(text: string, params: unknown[] = []) => gw.runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.unsafe<A>(text, params);
  }));

  beforeAll(async () => {
    gw = await startTestGateway({ botModel: (i) => model(i) });
    core = gw.core;
    for (const [provider, id] of [[Provider.CODEX, "create-test"], [Provider.CLAUDE, "create-other"]] as const) {
      await gw.api.saveProviderInstance({ harness: provider, id, label: id, create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:1", apiKey: "fixture", allWorkers: true });
      const catalog = create(ProfileModelsSchema, { provider, profileId: id, models: [{ id: "gpt-parent", efforts: ["low", "high"] }, { id: "child-model", efforts: ["low"] }] });
      const worker = Bun.randomUUIDv7();
      await query("INSERT INTO workers(id, name, credential_hash) VALUES ($1::uuid, 'creation catalog', 'unused')", [worker]);
      await query("INSERT INTO worker_model_catalogs(worker_id, config_version, profiles) VALUES ($1::uuid, 1, $2::jsonb)", [worker, JSON.stringify([toJson(ProfileModelsSchema, catalog)])]);
    }
    core.bots.start();
  }, 30_000);
  afterAll(async () => { await core?.bots.stop(); await gw?.close(); });

  test("preview is durable, approval creates exactly one owned bot with requested settings and an empty conversation", async () => {
    const parent = await add("Creator");
    const args = { name: "Haiku child", instructions: "Answer only in haiku.\nPreserve this second line: exactly.", shape: "flower", color: "#14B8A6", provider: "claude", provider_instance: "create-other", model: "child-model", effort: "low", approval_policy: "safe" };
    // A stricter parent may propose safe: the human explicitly approves that policy on the card.
    await gw.api.updateBot({ botId: parent.id, configuration: { ...parent.configuration!, approvalPolicy: "always" } });
    propose(args);
    await send(parent.id);
    const card = (await waiting(parent.id)).approvals[0]!;
    expect(card.proposedBot).toMatchObject({ name: args.name, instructions: args.instructions, shape: args.shape, color: "#14b8a6", provider: Provider.CLAUDE, providerInstance: args.provider_instance, model: args.model, effort: args.effort, approvalPolicy: "safe", mcpServerIds: [] });
    expect((await core.bots.list()).some((b) => b.configuration?.name === args.name)).toBe(false);
    await core.bots.stop();
    core = new GatewayCore(options());
    core.bots.start();
    expect((await read(parent.id)).approvals[0]?.proposedBot).toEqual(card.proposedBot);
    await answer(card.id, true);
    await answer(card.id, true);
    const result = JSON.parse((await settled(parent.id)).messages.at(-1)!.text) as { id: string; name: string };
    expect(result.name).toBe(args.name);
    const child = await core.bots.get(result.id);
    expect(child.configuration).toEqual(card.proposedBot!);
    expect(child.createdByBotId).toBe(parent.id);
    expect(child.createdByBotName).toBe("Creator");
    expect((await read(child.id)).messages).toHaveLength(0);
    expect((await query<{ owner_user_id: string }>("SELECT owner_user_id FROM bots WHERE id = $1::uuid", [child.id]))[0]?.owner_user_id).toBe(gw.userId);

    // Simulate the crash window after action/result commit but before the tool checkpoint was appended.
    await core.bots.stop();
    await query("DELETE FROM bot_messages WHERE turn_id = $1::uuid AND message_key = 'answer'", [card.turnId]);
    await query("UPDATE bot_turns SET status = 'queued', finished_at = NULL, lease_token = NULL, lease_until = NULL, checkpoint = (SELECT jsonb_agg(v ORDER BY n) FROM jsonb_array_elements(checkpoint) WITH ORDINALITY x(v,n) WHERE v ->> 'role' <> 'tool') WHERE id = $1::uuid", [card.turnId]);
    core = new GatewayCore(options());
    core.bots.start();
    expect(JSON.parse((await settled(parent.id)).messages.at(-1)!.text)).toEqual(result);
    expect((await core.bots.list()).filter((b) => b.configuration?.name === args.name)).toHaveLength(1);
    const otherUser = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("creation-other@test.local", "Other owner")));
    const foreign = new GatewayCore({ ...options(), userId: otherUser });
    await expect(foreign.bots.get(child.id)).rejects.toThrow(/not found/);
    expect(await foreign.bots.list()).toHaveLength(0);
  }, 25_000);

  test("name-only inherits defaults, keeps random appearance after settings change, decline creates nothing, and execution cannot bypass approval", async () => {
    const parent = await add("Default creator");
    propose({ name: "Default child" });
    await send(parent.id);
    const card = (await waiting(parent.id)).approvals[0]!;
    expect(card.proposedBot).toMatchObject({ provider: Provider.CODEX, providerInstance: "create-test", model: "gpt-parent", effort: "high", approvalPolicy: "safe" });
    expect(card.proposedBot?.shape).toMatch(/^(round|cloud|diamond|spark|clover|blob|flower|droplet|pill|triangle|square|star|hexagon|pumpkin)$/);
    expect(card.proposedBot?.color).toMatch(/^#[a-f0-9]{6}$/);
    const call = (await query<StoredCall>("SELECT * FROM bot_tool_calls WHERE id = $1::uuid", [card.id]))[0]!;
    // The turn is waiting, so claim it without granting approval to probe the storage guard.
    await core.bots.stop();
    await query("UPDATE bot_turns SET status = 'queued' WHERE id = $1::uuid", [card.turnId]);
    const turn = (await core.bots.run((s) => s.claim(gw.userId)))!;
    expect(await botPlatform(core, options(), turn, call)).toMatchObject({ error: "creating a bot requires user approval of its configuration" });
    await core.bots.run((s) => s.release(turn));
    await gw.api.updateBot({ botId: parent.id, configuration: { ...parent.configuration!, effort: "low", color: "#abcdef" } });
    core.bots.start();
    expect((await waiting(parent.id)).approvals[0]?.proposedBot).toEqual(card.proposedBot);
    await core.bots.stop();
    await answer(card.id, true);
    const approvedTurn = (await core.bots.run((s) => s.claim(gw.userId)))!;
    await expect(core.bots.run((s) => s.action(approvedTurn, call, s.createFromBot(gw.userId, approvedTurn, call).pipe(Effect.flatMap(() => Effect.fail(new Error("fixture crash before action result"))))))).rejects.toThrow();
    expect((await core.bots.list()).some((b) => b.configuration?.name === "Default child")).toBe(false);
    await core.bots.run((s) => s.release(approvedTurn));
    core.bots.start();
    const created = JSON.parse((await settled(parent.id)).messages.at(-1)!.text) as { id: string };
    expect((await core.bots.get(created.id)).configuration).toEqual(card.proposedBot!);
    propose({ name: "Declined child", instructions: "Do not create this." });
    await send(parent.id);
    const declined = (await waiting(parent.id)).approvals.find((a) => a.status === "pending")!;
    await answer(declined.id, false);
    expect((await settled(parent.id)).messages.at(-1)?.text).toContain("The user declined this action. Do not retry it.");
    expect((await core.bots.list()).some((b) => b.configuration?.name === "Declined child")).toBe(false);
  }, 20_000);

  test("invalid model/effort and Unicode/case duplicate names return readable errors using RPC validation", async () => {
    const parent = await add("Validation creator");
    const taken = await add("Café");
    for (const args of [{ name: "Bad model", model: "made-up" }, { name: "Bad effort", effort: "ultra" }, { name: " CAFe\u0301 " }, { name: "Bad shape", shape: "shell" }, { name: "Bad field", mcp_server_ids: [] }]) {
      propose(args);
      await send(parent.id);
      const state = await eventually(() => read(parent.id), (s) => !s.working || s.approvals.some((a) => a.status === "pending"));
      const card = state.approvals.find((a) => a.status === "pending");
      if (card) await answer(card.id, true);
      const error = JSON.parse((await settled(parent.id)).messages.at(-1)!.text) as { error: string };
      expect(error.error).toMatch(/model|effort|name|shape|unknown field/i);
      expect(error.error).not.toMatch(/SQL|127\.0|password/i);
    }
    expect((await core.bots.get(taken.id)).configuration?.name).toBe("Café");
    await expect(gw.api.createBot({ configuration: config("CAFe\u0301"), clientRequestId: Bun.randomUUIDv7() })).rejects.toThrow(/name/);
  }, 20_000);

  test("full auto creates the bot without a card, validated like the card", async () => {
    const parent = await add("Auto creator");
    await gw.api.updateBot({ botId: parent.id, configuration: { ...parent.configuration!, approvalPolicy: "full_auto" } });
    propose({ name: "Auto child", model: "missing-model" });
    await send(parent.id);
    expect((await settled(parent.id)).approvals).toHaveLength(0);
    expect((await core.bots.list()).some((b) => b.configuration?.name === "Auto child")).toBe(false);
    propose({ name: "Auto child" });
    await send(parent.id);
    expect((await settled(parent.id)).approvals).toHaveLength(0);
    const child = (await core.bots.list()).filter((b) => b.configuration?.name === "Auto child");
    expect(child).toHaveLength(1);
    expect(child[0]!.configuration).toMatchObject({ model: "gpt-parent", approvalPolicy: "full_auto" });
  }, 20_000);

  test("a created bot is reachable through send_bot_message, and creation obeys the automated hop limit", async () => {
    const parent = await add("Messaging creator");
    propose({ name: "Reachable child", instructions: "Always answer CHILD_REPLY." });
    await send(parent.id);
    await answer((await waiting(parent.id)).approvals[0]!.id, true);
    const child = JSON.parse((await settled(parent.id)).messages.at(-1)!.text) as { id: string };
    model = async (i) => i.configuration.name === "Reachable child" ? reply("CHILD_REPLY") : i.messages.at(-1)?.role === "tool" || i.messages.at(-1)?.text.includes("CHILD_REPLY") ? reply("Received") : { text: "", calls: [{ id: "send", name: "send_bot_message", arguments: { bot_id: child.id, text: "Say hello" } }] };
    await send(parent.id, "Contact the child");
    const contacted = await eventually(() => read(child.id), (s) => s.messages.some((m) => m.text === "CHILD_REPLY"));
    expect(contacted.messages[0]?.senderId).toBe(parent.id);
    expect(contacted.messages[0]?.exchangeId).not.toBe("");
    await settled(parent.id);
    await core.bots.stop();
    propose({ name: "Hop overflow" });
    const turnId = await send(parent.id);
    await query("UPDATE bot_turns SET hops = 8 WHERE id = $1::uuid", [turnId]);
    core.bots.start();
    expect((await settled(parent.id)).messages.at(-1)?.text).toContain("error");
    expect((await core.bots.list()).some((b) => b.configuration?.name === "Hop overflow")).toBe(false);
  }, 20_000);

  test("the owner cap serializes concurrent RPC/tool creation and idempotent retries still succeed at the cap", async () => {
    const parent = await add("Cap creator");
    const requestId = Bun.randomUUIDv7();
    const retried = (await gw.api.createBot({ configuration: config("Retry at cap"), clientRequestId: requestId })).bot!;
    const count = (await core.bots.list(true)).length;
    // Populate through the RPC, not a test-only limit override. Archived bots count too.
    for (let n = count; n < MAX_BOTS_PER_USER - 1; n++) await add(`Cap filler ${n}`);
    await gw.api.archiveBot({ botId: retried.id });
    propose({ name: "Tool at cap" });
    await send(parent.id);
    const card = (await waiting(parent.id)).approvals[0]!;
    await answer(card.id, true);
    const rpc = gw.api.createBot({ configuration: config("RPC at cap"), clientRequestId: Bun.randomUUIDv7() }).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error: String(error) }));
    const tool = JSON.parse((await settled(parent.id)).messages.at(-1)!.text) as { id?: string; error?: string };
    const rpcResult = await rpc;
    expect(Number(Boolean(tool.id)) + Number(rpcResult.ok)).toBe(1);
    expect((await core.bots.list(true)).length).toBe(MAX_BOTS_PER_USER);
    if (tool.error) expect(tool.error).toContain("bot limit reached (50 per user");
    if (!rpcResult.ok) expect("error" in rpcResult && rpcResult.error).toContain("bot limit reached");
    expect((await gw.api.createBot({ configuration: config("Retry at cap"), clientRequestId: requestId })).bot?.id).toBe(retried.id);
    propose({ name: "Over cap" });
    await send(parent.id);
    await answer((await waiting(parent.id)).approvals.find((a) => a.status === "pending")!.id, true);
    expect((await settled(parent.id)).messages.at(-1)?.text).toContain("bot limit reached");
  }, 30_000);
});

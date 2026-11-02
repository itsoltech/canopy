import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJson } from "@bufbuild/protobuf";
import { bots, ProfileModelsSchema, Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { GatewayCore } from "@open-agents/gateway/core";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { BotModel, ModelInput, ModelReply } from "../../apps/gateway/src/bots/types.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string): ModelReply => ({ text, calls: [] });
const edit = (args: Record<string, unknown>): ModelReply => ({ text: '', calls: [{ id: 'edit', name: 'update_self', arguments: args }] });

describe.skipIf(!dockerAvailable)('bot settings and archive through gateway', () => {
  let gw: TestGateway;
  let core: GatewayCore;
  let model: BotModel = async () => reply('Hello');
  const config = (name: string) => create(bots.BotConfigurationSchema, { name, shape: 'round', color: '#f97316', provider: Provider.CODEX, providerInstance: 'settings-test', model: 'gpt-settings', approvalPolicy: 'safe' });
  const add = async (name: string) => (await gw.api.createBot({ configuration: config(name), clientRequestId: Bun.randomUUIDv7() })).bot!;
  const read = (id: string) => core.bots.run((s) => s.conversation(gw.userId, id));
  const settled = (id: string) => eventually(() => read(id), (s) => !s.working, 10_000);
  const send = (id: string, text: string) => core.bots.send(create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() }));
  const useEdit = (args: Record<string, unknown>) => { model = async (i) => i.messages.at(-1)?.role === 'tool' ? reply(i.messages.at(-1)!.text) : edit(args); };
  beforeAll(async () => {
    gw = await startTestGateway({ botModel: (i) => model(i) });
    core = gw.core;
    await gw.api.saveProviderInstance({ harness: Provider.CODEX, id: 'settings-test', label: 'Settings test', create: true, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', allWorkers: true });
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const worker = Bun.randomUUIDv7();
      yield* sql`INSERT INTO workers(id, name, credential_hash) VALUES (${worker}::uuid, 'settings catalog', 'unused')`;
      const catalog = create(ProfileModelsSchema, { provider: Provider.CODEX, profileId: 'settings-test', models: [{ id: 'gpt-settings', efforts: ['low', 'high'] }, { id: 'gpt-next', efforts: ['low'] }] });
      yield* sql`INSERT INTO worker_model_catalogs(worker_id, config_version, profiles) VALUES (${worker}::uuid, 1, ${JSON.stringify([toJson(ProfileModelsSchema, catalog)])}::jsonb)`;
    }));
    core.bots.start();
  }, 30_000);
  afterAll(async () => { await core?.bots.stop(); await gw?.close(); });

  test('UpdateBot saves all editable fields, normalizes names and rejects invalid settings and duplicate names', async () => {
    const a = await add('Before settings');
    const b = await add('Taken settings');
    const server = (await gw.api.saveBotMcpServer({ name: 'Remote', url: 'http://127.0.0.1:1/mcp', transport: 'http', enabled: false, headers: { Authorization: 'secret fixture' } })).server!;
    const updated = create(bots.BotConfigurationSchema, { ...a.configuration!, name: ' After settings ', shape: 'flower', color: '#ABCDEF', instructions: 'Always answer in English.', model: 'gpt-next', effort: 'low', approvalPolicy: 'always', mcpServerIds: [server.id] });
    expect((await gw.api.updateBot({ botId: a.id, configuration: updated })).bot?.configuration).toMatchObject({ name: 'After settings', shape: 'flower', color: '#abcdef', instructions: updated.instructions, model: 'gpt-next', effort: 'low', approvalPolicy: 'always', mcpServerIds: [server.id] });
    for (const patch of [{ name: b.configuration!.name.toUpperCase() }, { shape: 'unknown' }, { color: 'red' }, { instructions: 'x'.repeat(32001) }, { model: 'made-up' }, { effort: 'ultra' }, { approvalPolicy: 'never' }, { mcpServerIds: [Bun.randomUUIDv7()] }]) {
      await expect(core.bots.update(create(bots.UpdateBotRequestSchema, { botId: a.id, configuration: { ...updated, ...patch } }))).rejects.toThrow();
    }
    const raced = await Promise.allSettled([core.bots.update(create(bots.UpdateBotRequestSchema, { botId: a.id, configuration: { ...updated, name: 'Same concurrent' } })), core.bots.update(create(bots.UpdateBotRequestSchema, { botId: b.id, configuration: { ...b.configuration!, name: 'same concurrent' } }))]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  }, 20_000);

  test('self-edit is durable and atomic with a plain system line and before/after; instructions apply next turn', async () => {
    const bot = await add('Main settings bot');
    useEdit({ name: 'Kropka settings', shape: 'clover', color: '#3B82F6', append_instructions: 'Always answer in English.' });
    await send(bot.id, 'from now on call yourself Kropka and answer in English');
    const saved = await settled(bot.id);
    expect(saved.bot?.configuration).toMatchObject({ name: 'Kropka settings', shape: 'clover', color: '#3b82f6', instructions: 'Always answer in English.' });
    expect(saved.approvals).toHaveLength(0);
    const event = saved.messages.find((m) => m.settingChanges.length)!;
    expect(event.text).toContain('Main settings bot changed its name to Kropka settings');
    expect(event.text).toContain('updated its instructions');
    expect(event.text).not.toContain('{');
    expect(event.settingChanges.find((c) => c.field === 'instructions')).toMatchObject({ before: '', after: 'Always answer in English.' });
    await core.bots.stop();
    core = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: 'settings-restarted', botModel: (i) => model(i) });
    core.bots.start();
    let seen: ModelInput | undefined;
    model = async (i) => { seen = i; return reply('I will answer in English.'); };
    await send(bot.id, 'next turn');
    expect((await settled(bot.id)).messages.at(-1)?.text).toBe('I will answer in English.');
    expect(seen?.instructions).toContain('Always answer in English.');
    expect((await read(bot.id)).messages.filter((m) => m.settingChanges.length)).toHaveLength(1);
    useEdit({ instructions: 'Be concise.' });
    await send(bot.id, 'replace instructions');
    expect((await settled(bot.id)).bot?.configuration?.instructions).toBe('Be concise.');
    useEdit({ append_instructions: 'Use plain words.' });
    await send(bot.id, 'append instructions');
    expect((await settled(bot.id)).bot?.configuration?.instructions).toBe('Be concise.\nUse plain words.');
  }, 20_000);

  test('self-edit validates UpdateBot constraints and cannot address another bot or change connections', async () => {
    const bot = await add('Valid self');
    const other = await add('Other self');
    for (const patch of [{ name: 'Other self' }, { shape: 'other-shape' }, { color: '#zzz' }, { instructions: 'x'.repeat(32001) }, { instructions: 'A', append_instructions: 'B' }, { bot_id: other.id, name: 'Hacked' }, { mcp_server_ids: [] }]) {
      useEdit(patch);
      await send(bot.id, 'invalid edit');
      const result = await settled(bot.id);
      expect(result.messages.at(-1)?.text).toContain('error');
      expect(result.messages.filter((m) => m.settingChanges.length)).toHaveLength(0);
      expect(result.bot?.configuration?.name).toBe('Valid self');
    }
    expect((await core.bots.get(other.id)).configuration?.name).toBe('Other self');
  }, 20_000);

  test('model, effort and policy changes always wait for approval, persist after approval, discard runs nothing', async () => {
    const bot = await add('Approval settings');
    await gw.api.setInstanceModels({ harness: Provider.CODEX, id: 'settings-test', models: { custom: ['gpt-custom'], hidden: [], favorites: [] } });
    model = async (i) => i.messages.at(-1)?.role === 'tool' ? reply(i.messages.at(-1)!.text) : { text: '', calls: [{ id: 'models', name: 'list_models', arguments: {} }] };
    await send(bot.id, 'which API models can you use?');
    const offered = JSON.parse((await settled(bot.id)).messages.at(-1)!.text) as { id: string; efforts: string[] }[];
    expect(offered.map((m) => m.id)).toEqual(expect.arrayContaining(['gpt-custom', 'gpt-next', 'gpt-settings']));
    expect(offered.find((m) => m.id === 'gpt-next')?.efforts).toEqual(['low']);
    for (const [patch, approve] of [[{ model: 'gpt-next', effort: 'low' }, false], [{ model: 'made-up' }, true], [{ model: 'gpt-next', effort: 'low' }, true], [{ effort: '' }, true], [{ approval_policy: 'always' }, true], [{ approval_policy: 'safe' }, true]] as const) {
      useEdit(patch);
      const before = (await core.bots.get(bot.id)).configuration!;
      await send(bot.id, 'change settings');
      const waiting = await eventually(() => read(bot.id), (s) => s.approvals.some((a) => a.status === 'pending'));
      expect(waiting.bot?.configuration).toEqual(before);
      const card = waiting.approvals.find((a) => a.status === 'pending')!;
      expect(card.prompt).toContain('Updating my settings');
      await core.bots.answer(create(bots.AnswerBotApprovalRequestSchema, { approvalId: card.id, approve }));
      const result = await settled(bot.id);
      if (!approve || 'model' in patch && patch.model === 'made-up') expect(result.bot?.configuration).toEqual(before);
      else if ('approval_policy' in patch) expect(result.bot?.configuration?.approvalPolicy).toBe(patch.approval_policy);
      else expect(result.bot?.configuration?.effort).toBe(patch.effort);
    }
  }, 20_000);

  test('archive interrupts inference, pauses wakeups, drops notifications, removes pins; unarchive resumes, delete hides', async () => {
    const bot = await add('Archive settings');
    await gw.api.updateUserSettings({ expectedVersion: 0n, sidebar: { pinnedBotIds: [bot.id] } });
    model = async (i) => i.messages.at(-1)?.role === 'tool' ? reply('Scheduled') : { text: '', calls: [{ id: 'wake', name: 'schedule_wakeup', arguments: { run_at: new Date(Date.now() + 60_000).toISOString(), prompt: 'Resumed reminder' } }] };
    await send(bot.id, 'schedule a reminder');
    await settled(bot.id);
    const project = (await gw.api.createProject({ name: 'Archive notification project' })).project!;
    const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: '/repo' })).workspace!;
    gw.worker.holdTurns = true;
    const thread = (await gw.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX, model: 'gpt-6.1-sol', initialMessage: 'held notification' })).thread!;
    await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => r.thread?.status === 'running');
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_turn_id, hops)
        SELECT c.id, ${bot.id}::uuid, ${thread.id}::uuid, (SELECT id FROM turns WHERE thread_id = ${thread.id}::uuid ORDER BY created_at DESC LIMIT 1), 1
        FROM bot_tool_calls c JOIN bot_turns t ON t.id = c.turn_id WHERE t.bot_id = ${bot.id}::uuid LIMIT 1`;
    }));
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    model = async (i) => { entered.resolve(); await new Promise<void>((resolve) => i.signal.addEventListener('abort', () => { stopped.resolve(); resolve(); }, { once: true })); i.signal.throwIfAborted(); return reply('Stale'); };
    await send(bot.id, 'in flight');
    await entered.promise;
    await gw.api.archiveBot({ botId: bot.id });
    // The RPC uses the original runtime; the restarted runtime observes the durable fence at heartbeat.
    await eventually(() => read(bot.id), (s) => !s.working);
    expect((await read(bot.id)).bot?.archived).toBe(true);
    expect((await gw.api.getSettings({})).user?.sidebar?.pinnedBotIds).not.toContain(bot.id);
    expect((await gw.api.listBots({})).bots.some((b) => b.id === bot.id)).toBe(false);
    expect((await gw.api.listBots({ includeArchived: true })).bots.some((b) => b.id === bot.id && b.archived)).toBe(true);
    const dropped = await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ delivered: boolean }>`SELECT delivered FROM bot_thread_watches WHERE bot_id = ${bot.id}::uuid`;
    }));
    expect(dropped.map((w) => w.delivered)).toEqual([true]);
    gw.worker.holdTurns = false;
    const turn = await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return (yield* sql<{ id: string }>`SELECT id FROM turns WHERE thread_id = ${thread.id}::uuid AND status = 'running'`)[0]!;
    }));
    gw.worker.finish(thread.id, turn.id, 'Finished while bot archived');
    await expect(send(bot.id, 'blocked')).rejects.toThrow(/archived/);
    await gw.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE bot_wakeups SET run_at = now() - interval '1 second' WHERE bot_id = ${bot.id}::uuid`;
    }));
    await core.bots.run((s) => s.deliver());
    expect((await read(bot.id)).messages.some((m) => m.text === 'Resumed reminder')).toBe(false);
    const sender = await add('Archived sender');
    model = async (i) => i.messages.at(-1)?.role === 'tool' ? reply(i.messages.at(-1)!.text) : { text: '', calls: [{ id: 'send', name: 'send_bot_message', arguments: { bot_id: bot.id, text: 'blocked bot message' } }] };
    await send(sender.id, 'message archived bot');
    expect((await settled(sender.id)).messages.at(-1)?.text).toContain('archived');
    await stopped.promise;
    model = async () => reply('Reminder resumed');
    await gw.api.unarchiveBot({ botId: bot.id });
    const resumed = await eventually(() => read(bot.id), (s) => s.messages.some((m) => m.text === 'Reminder resumed'));
    expect(resumed.bot?.archived).toBe(false);
    expect(resumed.messages.filter((m) => m.text === 'Resumed reminder')).toHaveLength(1);
    expect(resumed.messages.some((m) => m.text === 'Stale')).toBe(false);
    expect(resumed.messages.some((m) => m.text.includes('Finished while bot archived') || m.text.startsWith('Thread '))).toBe(false);
    await gw.api.archiveBot({ botId: bot.id });
    await gw.api.deleteBot({ botId: bot.id });
    await expect(core.bots.get(bot.id)).rejects.toThrow();
    expect((await gw.api.listBots({ includeArchived: true })).bots.some((b) => b.id === bot.id)).toBe(false);
  }, 20_000);
});

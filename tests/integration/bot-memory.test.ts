import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { CommandSchema, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { Schema } from "effect";
import { botContexts } from "./fixtures/bot-probe.ts";
import { memoryChannel, secondBotWorker } from "./support/bot-memory.ts";
import { eventually } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

const toolInput = (name: string, args: JsonObject) => `TOOL:${name}\nARGS:${JSON.stringify(args)}`;

const mcpResult = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
    }),
  ),
);

const toolObject = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject));

function result(text: string) {
  expect(text).toStartWith("TOOL_RESULT:");

  return toolObject(mcpResult(text.slice("TOOL_RESULT:".length)).result.content[0]!.text);
}

describe.skipIf(!dockerAvailable)("durable bot memory through the worker harness", () => {
  let f: HarnessBots;
  let clock = new Date();
  beforeAll(async () => {
    f = await harnessBots({ botClock: () => clock });
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  async function completed(turnId: string) {
    const rows = await eventually(
      () => f.query<{ status: string }>("SELECT status FROM bot_turns WHERE id=$1", [turnId]),
      (r) => ["completed", "failed", "interrupted"].includes(r[0]?.status ?? ""),
      15_000,
    );

    expect(rows[0]?.status).toBe("completed");
  }

  async function command(turnId: string) {
    const [row] = await f.query<{ payload: Uint8Array; worker_id: string }>(
      "SELECT payload,worker_id FROM worker_commands WHERE id=$1",
      [turnId],
    );

    if (!row) throw new Error("Missing worker command");
    const { kind } = fromBinary(CommandSchema, row.payload);

    if (kind.case !== "runBotTurn") throw new Error("Expected a bot turn command");

    return { ...kind.value, workerId: row.worker_id };
  }

  async function answer(turnId: string) {
    await completed(turnId);

    const [row] = await f.query<{ text: string }>(
      "SELECT text FROM bot_messages WHERE turn_id=$1 AND message_key='answer'",
      [turnId],
    );

    if (!row) throw new Error("Missing bot answer");

    return row.text;
  }

  async function save(botId: string, title: string, body: string) {
    const { turnId } = await f.tool(botId, "memory_save", { scope: "bot", title, body });
    const saved = result(await answer(turnId));
    expect(saved).toMatchObject({ title, scope: "bot", revision: 1 });

    const note = (await f.gw.api.listMemoryNotes({ scope: ui.MemoryNoteScope.BOT })).notes.find(
      (n) => n.id === saved["note_id"],
    );

    expect(note).toMatchObject({ botId, title, body, sourceTurnId: turnId });

    return note!;
  }

  const latestContext = () => botContexts(join(f.dir, "bots.jsonl.context")).at(-1)!;

  const lastSession = (botId: string) =>
    f.records().findLast((r) => r.event === "turn" && r.home.includes(`/bots/${botId}/`))!.session;

  test("edits and deletion reach the cold and resumed harness after a provider and worker change", async () => {
    const bot = await f.add(Provider.CODEX);
    await f.gw.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, files: false } });
    const note = await save(bot.id, "Dispatch ledger", "Use the original queue.");
    const other = await secondBotWorker(f);

    try {
      await f.gw.api.updateBot({
        botId: bot.id,
        configuration: {
          ...bot.configuration!,
          files: false,
          provider: Provider.CLAUDE,
          providerInstance: other.profileId,
          workerId: other.workerId,
        },
      });

      const firstEdit = await f.gw.api.updateMemoryNote({
        noteId: note.id,
        expectedRevision: note.revision,
        title: note.title,
        body: "Use the amber queue.",
        aliases: ["dispatch-ledger"],
      });

      const prompt = "PROBE_CONTEXT\nDispatch ledger";

      const probe = async () => {
        const { turnId } = await f.send(bot.id, prompt);
        expect(await answer(turnId)).toBe("FIXTURE_OK");
        const input = await command(turnId);
        expect(input).toMatchObject({ workerId: other.workerId, provider: Provider.CLAUDE, files: false });
        expect(input.input).toContain(prompt);

        return input;
      };

      const cold = await probe();
      expect(cold.memoryContext).toContain(firstEdit.body);

      for (const field of [cold.instructions, cold.historyJson, cold.input])
        expect(field).not.toContain(firstEdit.body);
      expect(latestContext().prompt).toContain(firstEdit.body);
      const session = lastSession(bot.id);

      const secondEdit = await f.gw.api.updateMemoryNote({
        noteId: note.id,
        expectedRevision: firstEdit.revision,
        title: note.title,
        body: "Use the cobalt queue.",
        aliases: firstEdit.aliases,
      });

      const warm = await probe();
      expect(warm.configurationKey).toBe(cold.configurationKey);
      expect(lastSession(bot.id)).toBe(session);
      expect(warm.memoryContext).toContain(secondEdit.body);
      expect(warm.memoryContext).not.toContain(firstEdit.body);
      expect(latestContext().prompt).toContain(secondEdit.body);
      expect(latestContext().prompt).not.toContain(firstEdit.body);

      const searchInput = toolInput("memory_search", { queries: ["dispatch-ledger"] });
      expect(result(await answer((await f.send(bot.id, searchInput)).turnId))).toMatchObject({
        notes: [{ note_id: note.id, revision: secondEdit.revision, body: secondEdit.body }],
      });

      await f.gw.api.deleteMemoryNote({ noteId: note.id, expectedRevision: secondEdit.revision });
      const cleared = await probe();
      expect(cleared.memoryContext).toBe("");
      expect(cleared.configurationKey).toBe(cold.configurationKey);
      expect(lastSession(bot.id)).toBe(session);
      expect(latestContext().prompt).not.toContain(secondEdit.body);
      expect(result(await answer((await f.send(bot.id, searchInput)).turnId))).toEqual({ notes: [] });
    } finally {
      await other.close();
    }
  }, 60_000);

  test("a scheduled owner routine recalls the bot's note through memory_search", async () => {
    const bot = await f.add(Provider.CODEX);
    const note = await save(bot.id, "Nightly offsets", "Report offsets starting at seventeen.");

    const { turnId } = await f.tool(bot.id, "create_routine", {
      title: "Check nightly offsets",
      instructions: toolInput("memory_search", { queries: ["Nightly offsets"] }),
      cron: "*/15 * * * *",
      timezone: "UTC",
    });

    await completed(turnId);
    const routine = (await f.read(bot.id)).routines[0]!;
    clock = timestampDate(routine.nextRunAt!);
    await f.gw.core.bots.tick();

    const jobs = await eventually(
      () => f.query<{ id: string }>("SELECT id FROM bot_turns WHERE routine_id=$1", [routine.id]),
      (rows) => rows.length > 0,
    );

    expect(jobs).toHaveLength(1);
    const job = jobs[0]!.id;
    await completed(job);
    expect((await command(job)).memoryContext).toContain(note.body);
    const calls = await f.query<{ result: JsonObject }>("SELECT result FROM bot_tool_calls WHERE turn_id=$1", [job]);
    expect(calls).toMatchObject([{ result: { notes: [{ note_id: note.id, body: note.body }] } }]);
  }, 30_000);

  test("Slack conversations see their own notes and cannot read or overwrite the bot's private note", async () => {
    const bot = await f.add(Provider.CODEX);
    const note = await save(bot.id, "Juniper", "Private billing reference.");
    const external = await memoryChannel(f, bot.id);
    const title = "Juniper timetable";
    const body = "The next tram arrives at noon.";

    const write = await external(
      "1000.1",
      toolInput("memory_save", { scope: "conversation", title, body, aliases: ["Juniper"] }),
    );

    const saved = result(await answer(write));
    expect(saved).toMatchObject({ scope: "conversation", title, revision: 1 });
    const conversationId = (await command(write)).conversationId;
    expect(conversationId).toBeTruthy();
    expect((await f.gw.api.listMemoryNotes({ scope: ui.MemoryNoteScope.CONVERSATION })).notes).toContainEqual(
      expect.objectContaining({ id: saved["note_id"], conversationId, botId: bot.id, body }),
    );
    const lookup = toolInput("memory_search", { queries: ["Juniper"] });
    const same = await external("1000.1", lookup);
    expect(result(await answer(same))).toMatchObject({ notes: [{ note_id: saved["note_id"], body }] });
    expect((await command(same)).memoryContext).toContain(body);
    expect((await command(same)).memoryContext).not.toContain(note.body);

    const sibling = await external("1000.2", lookup);
    expect(result(await answer(sibling))).toEqual({ notes: [] });
    expect((await command(sibling)).memoryContext).toBe("");

    const overwrite = await external(
      "1000.1",
      toolInput("memory_save", {
        scope: "bot",
        note_id: note.id,
        expected_revision: note.revision,
        title: note.title,
        body: "External edit",
      }),
    );

    expect(result(await answer(overwrite))).toHaveProperty("error");
    expect(result(await answer((await f.send(bot.id, lookup)).turnId))).toMatchObject({
      notes: [{ note_id: note.id, revision: note.revision, body: note.body }],
    });
  }, 45_000);

  test("a bot replying to another bot cannot recall its owner's private note", async () => {
    const target = await f.add(Provider.CODEX);
    const note = await save(target.id, "Indigo receipts", "Post the private ledger on Mondays.");
    const sender = await f.add(Provider.CODEX);

    const { turnId } = await f.tool(sender.id, "send_bot_message", {
      bot_id: target.id,
      text: toolInput("memory_search", { queries: [note.title] }),
    });

    const exchange = result(await answer(turnId));
    expect(exchange).toMatchObject({ status: "queued" });

    const requests = await f.query<{ id: string }>(
      "SELECT id FROM bot_turns WHERE bot_id=$1 AND reply_to_bot_id=$2 AND exchange_id=$3",
      [target.id, sender.id, String(exchange["exchange_id"])],
    );

    expect(requests).toHaveLength(1);
    const request = requests[0]!.id;
    const outbound = await answer(request);
    expect(outbound).toStartWith("TOOL_RESULT:");
    expect(outbound).not.toContain(note.body);
    const input = await command(request);
    expect(input.memoryContext).toBe("");
    expect(input.tools.map((tool) => tool.name)).not.toContain("memory_search");
    expect(input.historyJson).not.toContain(note.body);

    const follow = await eventually(
      () =>
        f.query<{ id: string }>("SELECT id FROM bot_turns WHERE bot_id=$1 AND exchange_id=$2", [
          sender.id,
          String(exchange["exchange_id"]),
        ]),
      (rows) => rows.length > 0,
    );

    await completed(follow[0]!.id);
  }, 30_000);
});

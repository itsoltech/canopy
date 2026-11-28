import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { Schema } from "effect";
import { botContexts } from "./fixtures/bot-probe.ts";
import { memoryChannel } from "./support/bot-memory.ts";
import { eventually } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

const toolResponse = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        content: Schema.Array(Schema.Struct({ text: Schema.fromJsonString(Schema.JsonObject) })),
      }),
    }),
  ),
);

const report = {
  name: "release-report",
  description: "Prepare the weekly release report.",
  instructions: "Group shipped changes by customer impact. Include the release date.",
};

const handover = {
  name: "shift-handover",
  description: "Prepare the shift handover.",
  instructions: "Include the next on-call engineer and the open incidents.",
};

const sampleOutput = "Customers can now filter orders by date.";

describe.skipIf(!dockerAvailable)("learned bot skills through the worker harness", () => {
  let f: HarnessBots;
  beforeAll(async () => {
    f = await harnessBots();
    await f.save(Provider.CODEX, "skill-preview", ProviderProfileKind.NATIVE, "native", false, [
      { name: "FIXTURE_GENERATION_RESPONSE", value: sampleOutput },
    ]);
    const version = (await f.gw.api.getOverview({})).workers.find((w) => w.id === f.workerId)!.configVersion;

    const canPreview = await eventually(async () => {
      const { workers } = await f.gw.api.listModels({ workerId: f.workerId });

      return workers.some(
        (w) =>
          w.configVersion === version &&
          w.profiles.some((p) => p.provider === Provider.CODEX && p.models.some((m) => m.id === "fixture-model")),
      );
    }, Boolean);

    expect(canPreview).toBe(true);
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  async function answer(turnId: string) {
    const [row] = await eventually(
      () =>
        f.query<{ status: string; text: string | null }>(
          `SELECT t.status,m.text FROM bot_turns t LEFT JOIN bot_messages m ON m.turn_id=t.id AND m.message_key='answer'
           WHERE t.id=$1 AND t.status IN ('completed','interrupted','failed')`,
          [turnId],
        ),
      (rows) => rows.length > 0,
      15_000,
    );

    expect(row?.status).toBe("completed");

    if (!row?.text) throw new Error("Missing bot answer");

    return row.text;
  }

  async function call(botId: string, name: string, args: JsonObject = {}) {
    const { turnId } = await f.tool(botId, name, args);
    const text = await answer(turnId);
    expect(text).toStartWith("TOOL_RESULT:");

    return toolResponse(text.slice("TOOL_RESULT:".length)).result.content[0]!.text;
  }

  test("a later turn finds and previews the current procedure, and stale edits and deletes preserve it", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    expect(await call(bot.id, "save_skill", report)).toMatchObject({ ...report, revision: 1 });
    expect(await call(bot.id, "save_skill", handover)).toMatchObject({ ...handover, revision: 1 });

    const listed = await call(bot.id, "list_skills");
    expect(listed["skills"]).toHaveLength(2);

    for (const { name, description } of [report, handover])
      expect(listed["skills"]).toContainEqual({ name, description, revision: 1 });

    const revised = { ...report, instructions: "List customer-visible changes and omit reverted changes." };
    expect(await call(bot.id, "save_skill", { ...revised, expected_revision: 1 })).toMatchObject({
      ...revised,
      revision: 2,
    });
    expect(await call(bot.id, "save_skill", { ...report, expected_revision: 1 })).toMatchObject({
      error: expect.stringMatching(/skill changed/i),
    });
    expect(await call(bot.id, "delete_skill", { name: report.name, expected_revision: 1 })).toMatchObject({
      error: expect.stringMatching(/skill changed/i),
    });

    expect(await call(bot.id, "read_skill", { name: report.name })).toMatchObject({ ...revised, revision: 2 });
    const privateMessage = "The internal project budget is 37 credits.";
    expect(await answer((await f.send(bot.id, privateMessage)).turnId)).toBe("FIXTURE_OK");
    const sampleInput = "Shipped the order date filter. Reverted the calendar redesign.";
    const beforePreview = f.inputs().length;
    expect(await call(bot.id, "preview_skill", { name: report.name, example_input: sampleInput })).toEqual({
      name: report.name,
      revision: 2,
      sample_output: sampleOutput,
    });

    // The tool starts a separate ephemeral Codex turn after the bot requests the preview.
    const preview = f
      .inputs()
      .slice(beforePreview)
      .at(-1)
      ?.parts.map((part) => part.text)
      .join("\n");

    expect(preview).toContain(sampleInput);
    expect(preview).toContain(revised.instructions);

    for (const privateText of [privateMessage, handover.instructions, report.instructions])
      expect(preview).not.toContain(privateText);

    expect(await call(bot.id, "delete_skill", { name: report.name, expected_revision: 2 })).toMatchObject({
      deleted: true,
    });
    expect(await call(bot.id, "list_skills")).toEqual({
      skills: [{ name: handover.name, description: handover.description, revision: 1 }],
    });
    expect(await call(bot.id, "read_skill", { name: handover.name })).toMatchObject({ ...handover, revision: 1 });
  }, 60_000);

  test("bots owned by the same person can learn distinct procedures under the same name", async () => {
    const first = await f.add(Provider.CODEX, f.workerId, "full_auto");
    const second = await f.add(Provider.CODEX, f.workerId, "full_auto");
    expect(await call(first.id, "save_skill", report)).toMatchObject({ ...report, revision: 1 });
    expect(await call(second.id, "list_skills")).toEqual({ skills: [] });
    expect(await call(second.id, "read_skill", { name: report.name })).toMatchObject({
      error: expect.stringMatching(/skill not found/i),
    });

    const separate = { ...report, instructions: "Use one line per platform." };
    expect(await call(second.id, "save_skill", separate)).toMatchObject({ ...separate, revision: 1 });
    expect(await call(first.id, "read_skill", { name: report.name })).toMatchObject({ ...report, revision: 1 });
  }, 30_000);

  test("the channel catalog omits private skills and the gateway rejects direct requests by tool name", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    expect(await call(bot.id, "save_skill", report)).toMatchObject({ ...report, revision: 1 });
    const channel = await memoryChannel(f, bot.id);

    const turnId = await channel(
      "1000.1",
      'PROBE_CONTEXT\nTOOL:ask_user\nARGS:{"question":"Which report do you need?"}',
    );

    const chat = await eventually(
      () => f.read(bot.id),
      (r) => r.approvals.some((a) => a.status === "pending"),
      10_000,
    );

    const question = chat.approvals.find((a) => a.status === "pending");

    if (!question) throw new Error("The external turn did not reach its question");

    try {
      const context = botContexts(join(f.dir, "bots.jsonl.context")).at(-1)!;

      for (const privateText of [report.name, report.description, report.instructions]) {
        expect(context.prompt).not.toContain(privateText);
        expect(context.instructions).not.toContain(privateText);
      }

      const requests = {
        list_skills: {},
        read_skill: { name: report.name },
        preview_skill: { name: report.name, example_input: "Report this week's release." },
        save_skill: { ...report, instructions: "Overwrite from the channel.", expected_revision: 1 },
        delete_skill: { name: report.name, expected_revision: 1 },
      };

      for (const [name, args] of Object.entries(requests)) {
        expect(context.names).not.toContain(name);

        // Keep the actual channel turn leased while submitting valid arguments directly to its gateway handler.
        const denied = await f.gw.core.bots.harnessTools.handle(
          create(AgentToolCallSchema, {
            callId: crypto.randomUUID(),
            botId: bot.id,
            threadId: bot.id,
            turnId,
            toolName: name,
            argumentsJson: JSON.stringify(args),
          }),
          f.workerId,
        );

        expect(denied.content).toContain("This tool is unavailable");
        expect(denied.content).not.toContain(report.instructions);
      }
    } finally {
      await f.gw.api.answerBotApproval({ approvalId: question.id, approve: true, answer: "The weekly report." });
      await answer(turnId);
    }

    expect(await call(bot.id, "read_skill", { name: report.name })).toMatchObject({ ...report, revision: 1 });
  }, 30_000);

  test("recovering an in-flight preview never starts a second generation", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    await f.query(
      "INSERT INTO bot_skills(bot_id,name,description,instructions,revision) VALUES ($1,'recovery','Preview recovery','Summarize the sample. HOLD:preview-recovery',1)",
      [bot.id],
    );
    const { turnId } = await f.tool(bot.id, "preview_skill", { name: "recovery", example_input: "Seven open items." });

    const generations = () =>
      f
        .inputs()
        .filter((input) =>
          input.parts.some(
            (part) => part.text?.includes("HOLD:preview-recovery") && part.text.includes("Seven open items."),
          ),
        );

    try {
      expect(
        await eventually(
          async () => generations().length,
          (count) => count > 0,
        ),
      ).toBe(1);
      expect(
        await f.query("SELECT status FROM bot_tool_calls WHERE turn_id=$1 AND tool->>'name'='preview_skill'", [turnId]),
      ).toEqual([{ status: "running" }]);
      // Simulate loss of the executing gateway lease before its waiting command can record a result.
      await f.query("UPDATE bot_turns SET lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1", [
        turnId,
        crypto.randomUUID(),
      ]);
      await f.restartGateway();
      await f.reconnect();
      f.gw.core.bots.start();
      await f.release("preview-recovery");

      const terminal = await eventually(
        () =>
          f.query<{ status: string }>(
            "SELECT status FROM bot_tool_calls WHERE turn_id=$1 AND tool->>'name'='preview_skill'",
            [turnId],
          ),
        (rows) => rows[0]?.status === "interrupted",
      );

      expect(terminal).toEqual([{ status: "interrupted" }]);
      await answer(turnId);
      expect(generations()).toHaveLength(1);
    } finally {
      await f.release("preview-recovery");
    }
  }, 30_000);
});

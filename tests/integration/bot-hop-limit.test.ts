import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, Provider, ui } from "@canopy/contracts";
import { DEFAULT_BUS_LIMITS, type JsonObject } from "@canopy/domain";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { botThreadAudience } from "../../apps/gateway/src/core/bot-thread-audience.ts";
import type { BotTurn } from "../../apps/gateway/src/bots/types.ts";
import { SqlClient } from "effect/sql";
import { eventually } from "./support/gateway.ts";
import { botsSuite, lastInput, reply, tool } from "./support/bots.ts";

describe.skipIf(!dockerAvailable)("bot message guard and approval boundaries", () => {
  const { suite, add, read, send, settled } = botsSuite();

  const query = <A extends object>(statement: string, values: string[] = []) =>
    suite.gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(statement, values)));

  const noEffects = async (callId: string) => {
    expect(await query("SELECT id FROM turns WHERE bot_call_id=$1::uuid", [callId])).toHaveLength(0);
    expect(await query("SELECT call_id FROM bot_thread_watches WHERE call_id=$1::uuid", [callId])).toHaveLength(0);
    expect(await query("SELECT id FROM bot_turns WHERE client_request_id=$1", [`bot:${callId}`])).toHaveLength(0);
  };

  const approve = async (botId: string) => {
    const conversation = await eventually(
      () => read(botId),
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    const approvalId = conversation.approvals.find((a) => a.status === "pending")!.id;
    await noEffects(approvalId);
    await suite.current.bots.answer(
      create(bots.AnswerBotApprovalRequestSchema, {
        approvalId,
        approve: true,
      }),
    );
  };

  const enqueue = (botId: string, hops: number) =>
    suite.current.bots.run((s) =>
      s.enqueue(suite.gw.userId, botId, "Continue automatically", crypto.randomUUID(), {
        hops,
        sender: "system",
        event: true,
      }),
    );

  const call = async (turnId: string) =>
    (
      await query<{ id: string; result: JsonObject }>("SELECT id,result FROM bot_tool_calls WHERE turn_id=$1::uuid", [
        turnId,
      ])
    )[0]!;

  for (const name of ["start_thread", "send_message", "send_bot_message"]) {
    test(`${name} permits long chains and refuses exhausted chains before approval`, async () => {
      const sender = await add(`${name} sender`, { approvalPolicy: "always" });
      const recipient = await add(`${name} recipient`);

      const messageArgs = async (turn: BotTurn): Promise<JsonObject> => {
        if (name === "start_thread")
          return {
            project_id: suite.projectId,
            workspace_id: suite.workspaceId,
            provider: "codex",
            provider_instance: "bots-test",
            model: "gpt-6.1-sol",
            prompt: "Continue the work",
          };

        if (name === "send_bot_message") return { bot_id: recipient.id, text: "Continue the work" };

        // A delegated turn can message a thread in its own audience. Each automatic chain has a distinct origin.
        const target = await suite.current.createThread(
          create(ui.CreateThreadRequestSchema, {
            projectId: suite.projectId,
            workspaceId: suite.workspaceId,
            provider: Provider.CODEX,
            providerProfileId: "bots-test",
            model: "gpt-6.1-sol",
          }),
          undefined,
          false,
          { memoryAudience: await botThreadAudience(suite.current, turn), startedByBot: sender.id },
        );

        return { thread_id: target.id, text: "Continue the work" };
      };

      suite.model = async (input) => {
        if (input.configuration.name === recipient.configuration!.name) return reply("Recipient finished");

        if (/^(Thread |Message from )/.test(lastInput(input))) return reply("Response received");

        return input.messages.at(-1)?.role === "tool"
          ? reply(input.messages.at(-1)!.text)
          : tool(name, await messageArgs(input.turn!));
      };

      for (const hops of [8, 100, DEFAULT_BUS_LIMITS.maxHops - 2]) {
        const responses = (await read(sender.id)).messages.filter((m) => m.text === "Response received").length;
        const turnId = await enqueue(sender.id, hops);
        await approve(sender.id);

        const conversation = await eventually(
          () => read(sender.id),
          (s) => !s.working && s.messages.filter((m) => m.text === "Response received").length > responses,
          10_000,
        );

        expect(conversation.approvals.every((a) => a.status === "approved")).toBe(true);
        const saved = await call(turnId);
        expect(saved.result["error"]).toBeUndefined();

        if (name === "send_bot_message") {
          const exchange = await query<{ hops: number }>(
            "SELECT hops FROM bot_turns WHERE exchange_id=$1::uuid ORDER BY hops",
            [saved.id],
          );

          expect(exchange.map((t) => t.hops)).toEqual([hops + 1, hops + 2]);
        } else {
          const watches = await eventually(
            () =>
              query<{ hops: number; delivered: boolean; target_hops: number }>(
                "SELECT w.hops,w.delivered,t.hops AS target_hops FROM bot_thread_watches w JOIN turns t ON t.id=w.target_turn_id WHERE w.call_id=$1::uuid",
                [saved.id],
              ),
            (rows) => rows[0]?.delivered === true,
          );

          expect(watches[0]).toEqual({ hops: hops + 2, delivered: true, target_hops: hops + 1 });
        }
      }

      for (const hops of [DEFAULT_BUS_LIMITS.maxHops - 1, DEFAULT_BUS_LIMITS.maxHops]) {
        const turnId = await enqueue(sender.id, hops);
        await settled(sender.id);
        const saved = await call(turnId);
        expect(saved.result).toEqual({
          error: `This automated conversation reached its limit (${DEFAULT_BUS_LIMITS.maxHops} steps). Send a new message to continue.`,
        });
        expect(await query("SELECT id FROM bot_approvals WHERE turn_id=$1::uuid", [turnId])).toHaveLength(0);
        await noEffects(saved.id);
      }

      const responses = (await read(sender.id)).messages.filter((m) => m.text === "Response received").length;
      const humanTurn = await send(sender.id, "Continue");
      await approve(sender.id);
      await eventually(
        () => read(sender.id),
        (s) => !s.working && s.messages.filter((m) => m.text === "Response received").length > responses,
      );
      expect(
        (await query<{ hops: number }>("SELECT hops FROM bot_turns WHERE id=$1::uuid", [humanTurn]))[0]?.hops,
      ).toBe(0);
      expect((await call(humanTurn)).result["error"]).toBeUndefined();
    }, 30_000);
  }

  test("malformed attachment ids fail before approval without sending", async () => {
    const sender = await add("Invalid attachment sender", { approvalPolicy: "always" });
    suite.model = async (input) =>
      input.messages.at(-1)?.role === "tool"
        ? reply(input.messages.at(-1)!.text)
        : tool("send_message", {
            thread_id: crypto.randomUUID(),
            text: "Read the file",
            attachment_ids: ["not-a-file-id"],
          });

    const turnId = await send(sender.id, "Send the file");
    const conversation = await settled(sender.id);
    expect(conversation.approvals).toHaveLength(0);
    const saved = await call(turnId);
    expect(saved.result).toEqual({
      error: "Invalid attachment ids. Use list_attachments to choose files from this conversation.",
    });
    await noEffects(saved.id);
  });
});

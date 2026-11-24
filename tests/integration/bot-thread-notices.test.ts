import { describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { SqlClient } from "effect/sql";
import { coreIngest } from "../../apps/gateway/src/core/core-workers.ts";
import { failAfterCommentary } from "./support/agent-report.ts";
import { botsSuite, lastInput, reply } from "./support/bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("local bot thread notices", () => {
  const { suite, add, read } = botsSuite();

  const query = <T extends object>(text: string, values: string[]) =>
    suite.gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<T>(text, values)));

  async function expectStatus(turnId: string, status: string) {
    const rows = await eventually(
      () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1", [turnId]),
      (rows) => rows[0]?.status === status,
    );

    expect(rows).toEqual([{ status }]);
  }

  async function createThread(title: string) {
    const { thread } = await suite.gw.api.createThread({
      projectId: suite.projectId,
      workspaceId: suite.workspaceId,
      provider: Provider.CODEX,
      title,
      initialMessage: "Initial work",
    });

    const [initial] = await query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1", [thread!.id]);
    await expectStatus(initial!.id, "completed");

    return thread!;
  }

  test("one completion report for multiple steers, with separate reports for distinct turns", async () => {
    const bot = await add("Coordinator");
    const { bots, link } = suite.current;
    const { userId, runtime, workerId } = suite.gw;
    const worker = suite.currentWorker;
    const thread = await createThread("Check the report");
    const result = "The check passed.";
    const deliver = (core = suite.current) => core.bots.run((s) => s.deliver(userId));

    const reports = () =>
      query<{ input: string }>("SELECT input FROM bot_turns WHERE bot_id=$1 AND client_request_id LIKE 'thread:%'", [
        bot.id,
      ]);

    await bots.stop();
    worker.holdTurns = true;

    try {
      await bots.run((s) => s.enqueue(userId, bot.id, "Check the report", Bun.randomUUIDv7()));
      const source = (await bots.run((s) => s.claim(userId)))!;
      expect(source.bot_id).toBe(bot.id);

      const send = async (text: string, delivery: "queue" | "steer") => {
        const args = { thread_id: thread.id, text, delivery };

        const call = await bots.run((s) =>
          s.planCall(
            source,
            Bun.randomUUIDv7(),
            { name: "send_message", description: "", source: "platform", parameters: {} },
            args,
          ),
        );

        return suite.current.sendBotThreadMessage(source, call, thread.id, text, delivery);
      };

      const first = await send("Start checking", "queue");
      await expectStatus(first.turn_id, "running");

      for (const text of ["Check the title", "Check the references", "Check the summary"]) {
        const steer = await send(text, "steer");
        expect(steer).toMatchObject({ delivery: "steer", turn_id: first.turn_id });
      }

      const steers = () =>
        query<{ status: string }>("SELECT status FROM turn_steers WHERE turn_id=$1 ORDER BY id", [first.turn_id]);

      expect(
        await eventually(steers, (rows) => rows.filter((row) => row.status === "delivered").length === 3),
      ).toHaveLength(3);

      const second = await send("Check the report again", "queue");
      expect(second.turn_id).not.toBe(first.turn_id);
      await bots.run((s) => s.finish(source, "completed", ""));

      const completion = worker.finish(thread.id, first.turn_id, result);
      await expectStatus(first.turn_id, "completed");
      const restarted = new GatewayCore({ runtime, userId, instanceId: Bun.randomUUIDv7() });
      await Promise.all([deliver(), deliver(restarted)]);
      expect(await reports()).toEqual([{ input: expect.stringContaining(result) }]);

      // Replay the same journal event after its first delivery, as on reconnect.
      expect(await coreIngest(suite.current, link.connections.get(workerId)!, [completion])).toBeUndefined();
      await deliver(restarted);
      expect(await reports()).toHaveLength(1);

      await expectStatus(second.turn_id, "running");
      worker.finish(thread.id, second.turn_id, result);
      await expectStatus(second.turn_id, "completed");
      await deliver(restarted);

      const queued = await reports();
      expect(queued).toHaveLength(2);
      expect(queued[0]?.input).toBe(queued[1]?.input);

      const handled: string[] = [];
      suite.model = async (input) => {
        handled.push(lastInput(input));

        return reply("Report received.");
      };

      bots.start();
      await eventually(
        () => read(bot.id),
        ({ working }) => !working,
      );
      expect(handled).toEqual(queued.map(({ input }) => input));
    } finally {
      worker.holdTurns = false;
      await bots.remove(bot.id);
    }
  }, 15_000);

  for (const kind of ["completion", "question", "failure"] as const) {
    test(`a long title in a ${kind} notice leaves other completion notices deliverable`, async () => {
      const bot = await add(`Watch ${kind}`);
      const { bots } = suite.current;
      const { userId } = suite.gw;
      const worker = suite.currentWorker;
      await bots.stop();

      // The cutoff falls between the emoji's UTF-16 surrogates.
      const prefix = "x".repeat(198);
      const title = prefix + "😀" + "x".repeat(kind === "question" ? 99_700 : 21_000);
      const long = await createThread(title);
      const normal = await createThread("Normal thread");
      expect(long.title).toBe(title);
      worker.holdTurns = true;

      try {
        await bots.run((s) => s.enqueue(userId, bot.id, "Send follow-ups", crypto.randomUUID()));
        const source = (await bots.run((s) => s.claim(userId)))!;

        expect(source.bot_id).toBe(bot.id);

        const send = async (threadId: string) => {
          const args = { thread_id: threadId, text: "Follow up", delivery: "queue" };

          const call = await bots.run((s) =>
            s.planCall(
              source,
              threadId,
              { name: "send_message", description: "", source: "platform", parameters: {} },
              args,
            ),
          );

          const sent = await suite.current.sendBotThreadMessage(source, call, threadId, args.text, args.delivery);
          await expectStatus(sent.turn_id, "running");

          return { callId: call.id, turnId: sent.turn_id };
        };

        const first = await send(long.id);
        const second = await send(normal.id);
        await bots.run((s) => s.finish(source, "completed", ""));

        const requestId = Bun.randomUUIDv7();

        if (kind === "question") {
          const result = await worker.callTool({
            threadId: long.id,
            turnId: first.turnId,
            tool: "ask_user",
            callId: requestId,
            args: {
              wait: false,
              questions: [{ id: "detail", header: "Detail", question: "Which branch should I use?", kind: "text" }],
            },
          });

          expect(result.isError).toBe(false);
        } else if (kind === "failure") {
          failAfterCommentary(
            worker,
            long.id,
            first.turnId,
            "Stream disconnected",
            "Partial result " + "y".repeat(85_000),
          );
          await expectStatus(first.turnId, "failed");
        } else {
          worker.finish(long.id, first.turnId, "Long result " + "y".repeat(85_000));
          await expectStatus(first.turnId, "completed");
        }

        worker.finish(normal.id, second.turnId, "Normal result");
        await expectStatus(second.turnId, "completed");
        await bots.run((s) => s.deliver(userId));
        await bots.run((s) => s.deliver(userId));

        const firstRequest =
          kind === "question" ? `thread-question:${first.callId}:${requestId}` : `thread:${first.callId}`;

        const firstResult = await query<{ input: string }>("SELECT input FROM bot_turns WHERE client_request_id=$1", [
          firstRequest,
        ]);

        const secondResult = await query<{ input: string }>("SELECT input FROM bot_turns WHERE client_request_id=$1", [
          `thread:${second.callId}`,
        ]);

        expect(firstResult).toEqual([{ input: expect.stringContaining(`${prefix}…`) }]);

        if (kind === "completion") {
          const report = firstResult[0]?.input.split("\n", 2)[1];

          expect(report?.startsWith("Long result ")).toBe(true);
          expect(report?.length).toBe(80_000);
        } else if (kind === "failure") {
          const report = firstResult[0]!.input.split("\n").slice(1).join("\n");
          expect(report).toStartWith("Turn failed: Stream disconnected\n\nPartial result ");
          expect(report).toHaveLength(80_000);
        } else expect(firstResult[0]?.input).toContain(requestId);
        expect(secondResult).toEqual([{ input: expect.stringContaining("Normal result") }]);
        const events = (await read(bot.id)).messages.filter((m) => m.kind === "event").map((m) => m.text);

        const notice =
          kind === "failure"
            ? `Turn failed: Stream disconnected (“${prefix}…”)`
            : `“${prefix}…” ${kind === "completion" ? "finished" : "needs input"}`;

        expect(events.toSorted()).toEqual([notice, "“Normal thread” finished"].toSorted());

        if (kind === "question") {
          worker.finish(long.id, first.turnId, "Result after asking");
          await expectStatus(first.turnId, "completed");
        }
      } finally {
        worker.holdTurns = false;
        await bots.remove(bot.id);
      }
    }, 15_000);
  }
});

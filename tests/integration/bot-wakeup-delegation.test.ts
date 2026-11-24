import { describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { ModelToolCall } from "../../apps/gateway/src/bots/types.ts";
import { botsSuite, lastInput, reply } from "./support/bots.ts";
import { eventually } from "./support/gateway.ts";

const decodeResults = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)));
const denied = { error: "Choose a thread delegated from this conversation, or start a new thread here." };

const call = (name: string, args: JsonObject = {}): ModelToolCall => ({
  id: Bun.randomUUIDv7(),
  name,
  arguments: args,
});

const reminder = (prompt: string) =>
  call("schedule_wakeup", { prompt, run_at: new Date(Date.now() + 60_000 * 60).toISOString() });

describe.skipIf(!dockerAvailable)("thread delegation across bot wakeups", () => {
  const { suite, add, read, send, restart } = botsSuite();

  test("chained wakeups retain prior delegations after a restart and independent wakeups stay isolated", async () => {
    const bot = await add("Reminder bot", { approvalPolicy: "full_auto" });
    const other = await add("Other bot", { approvalPolicy: "full_auto" });
    const scripts = new Map<string, ModelToolCall[]>();
    suite.model = async (input) => {
      const prompt = lastInput(input);
      const steps = scripts.get(prompt);

      if (!steps) return reply("Acknowledged");
      const results = input.messages.filter((m) => m.role === "tool");
      const next = steps[results.length];

      return next
        ? { text: "", calls: [next] }
        : reply(`Finished ${prompt}\n[${results.map((m) => m.text).join(",")}]`);
    };

    async function results(botId: string, prompt: string) {
      const marker = `Finished ${prompt}\n`;

      const conversation = await eventually(
        () => read(botId),
        (chat) => chat.messages.some((m) => m.senderId === botId && m.text.startsWith(marker)),
        10_000,
      );

      const answer = conversation.messages.find((m) => m.senderId === botId && m.text.startsWith(marker))!;
      expect(answer).toBeDefined();

      return decodeResults(answer.text.slice(marker.length));
    }

    async function wake(botId: string, prompt: string) {
      const rows = await suite.gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql`UPDATE bot_wakeups SET run_at=now()-interval '1 second'
          WHERE bot_id=${botId}::uuid AND prompt=${prompt} AND NOT delivered RETURNING id`,
        ),
      );

      expect(rows).toHaveLength(1);
      await suite.current.bots.tick();

      return results(botId, prompt);
    }

    const start = (title: string) =>
      call("start_thread", {
        title,
        project_id: suite.projectId,
        workspace_id: suite.workspaceId,
        provider: "codex",
        provider_instance: "bots-test",
        prompt: "Check the task",
      });

    scripts.set("Set reminders", [reminder("First check"), reminder("Independent check")]);
    scripts.set("First check", [start("First delegation"), reminder("Second check"), reminder("Sibling check")]);
    await send(bot.id, "Set reminders");
    await results(bot.id, "Set reminders");
    await wake(bot.id, "First check");

    const threads = () => suite.current.listThreads(suite.projectId);
    const first = (await threads()).find((t) => t.title === "First delegation")!;
    expect(first).toBeDefined();
    const get = (threadId: string) => call("get_thread", { thread_id: threadId });
    const list = () => call("list_threads", { project_id: suite.projectId });
    const sendTo = (threadId: string, text: string) => call("send_message", { thread_id: threadId, text });
    const unknown = Bun.randomUUIDv7();
    scripts.set("Independent check", [list(), get(first.id), get(unknown), sendTo(first.id, "Unrelated check")]);
    expect(await wake(bot.id, "Independent check")).toEqual([[], denied, denied, denied]);

    const finished = await eventually(
      () => suite.current.getThread(first.id),
      (t) => t.status === "idle" && t.lastTurnStatus === "completed",
    );

    expect(finished).toMatchObject({ status: "idle", lastTurnStatus: "completed" });

    await restart();
    const message = "Continue the first delegation";
    scripts.set("Second check", [
      list(),
      get(first.id),
      call("read_thread", { thread_id: first.id }),
      sendTo(first.id, message),
      start("Second delegation"),
      reminder("Third check"),
    ]);
    const secondResults = await wake(bot.id, "Second check");
    expect(secondResults[0]).toMatchObject([{ id: first.id }]);
    expect(secondResults[1]).toMatchObject({ id: first.id });
    expect(secondResults[2]).toMatchObject({ turns: [{ from_thread_id: first.id }] });
    expect(secondResults[3]).toMatchObject({ thread_id: first.id, delivery: "queue" });

    const delivered = await eventually(
      () => Promise.resolve(suite.currentWorker.inputs.get(first.id) ?? []),
      (inputs) => inputs.some((input) => input.includes(message)),
    );

    expect(delivered).toEqual(expect.arrayContaining([expect.stringContaining(message)]));

    const second = (await threads()).find((t) => t.title === "Second delegation")!;
    expect(second).toBeDefined();
    scripts.set("Third check", [list(), get(first.id), get(second.id)]);
    const thirdResults = await wake(bot.id, "Third check");
    expect(thirdResults[0]).toMatchObject([{ id: first.id }, { id: second.id }]);
    expect(thirdResults[1]).toMatchObject({ id: first.id });
    expect(thirdResults[2]).toMatchObject({ id: second.id });

    scripts.set("Sibling check", [list(), get(second.id)]);
    const siblingResults = await wake(bot.id, "Sibling check");
    expect(siblingResults[0]).toMatchObject([{ id: first.id }]);
    expect(siblingResults[1]).toEqual(denied);

    scripts.set("Set other reminder", [reminder("Other check")]);
    scripts.set("Other check", [list(), get(first.id), get(unknown)]);
    await send(other.id, "Set other reminder");
    await results(other.id, "Set other reminder");
    expect(await wake(other.id, "Other check")).toEqual([[], denied, denied]);
  }, 30_000);
});

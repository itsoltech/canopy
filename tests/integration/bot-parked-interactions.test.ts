import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { JsonObject } from "@canopy/domain";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { bots, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { BotModel, ModelInput, ModelReply } from "../../apps/gateway/src/bots/types.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string): ModelReply => ({ text, calls: [] });

const tool = (name: string, args: JsonObject): ModelReply => ({
  text: "",
  calls: [{ id: "requested", name, arguments: args }],
});

const inputOf = (i: ModelInput) => i.messages.findLast((m) => m.role === "user")?.text ?? "";

const definition = {
  title: "Watch releases",
  instructions: "Check releases and ask me before acting.",
  cron: "*/15 * * * *",
  timezone: "UTC",
};

describe.skipIf(!dockerAvailable)("bot parked interactions: background runs never block the bot", () => {
  let gw: TestGateway;
  let core: GatewayCore;
  let clock: Date;
  let model: BotModel;
  let ids: string[] = [];

  const query = <A extends object>(text: string, values: unknown[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SqlClient.SqlClient).unsafe<A>(text, values);
      }),
    );

  const read = (id: string) => core.bots.run((s) => s.conversation(gw.userId, id));

  const idle = async (id: string) => {
    await eventually(
      async () => {
        await core.bots.tick();

        return query("SELECT id FROM bot_turns WHERE bot_id = $1 AND status IN ('queued','running','waiting')", [id]);
      },
      (r) => r.length === 0,
      10_000,
    );

    return read(id);
  };

  const add = async () => {
    const bot = (
      await gw.api.createBot({
        clientRequestId: Bun.randomUUIDv7(),
        configuration: {
          name: `Parked ${Bun.randomUUIDv7()}`,
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "parked-test",
          model: "gpt-6.1-sol",
          approvalPolicy: "always",
        },
      })
    ).bot!;

    ids.push(bot.id);

    return bot.id;
  };

  const send = async (id: string, text: string) => {
    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() }),
    );

    return idle(id);
  };

  const routine = async (id: string) => {
    model = async (i) =>
      i.messages.at(-1)?.role === "tool" ? reply("Routine is ready") : tool("create_routine", definition);

    return (await send(id, "Watch releases every 15 minutes")).routines[0]!;
  };

  /** One scheduled run whose model asks with `first`, then records `note` as its final answer. */
  const parkWith = async (id: string, name: string, args: JsonObject, note: string) => {
    const r = await routine(id);
    const seen: ModelInput[] = [];

    model = async (i) => {
      seen.push(i);

      if (inputOf(i).includes("Continuation of a parked")) return reply("Continued");

      return i.messages.at(-1)?.role === "tool" ? reply(note) : tool(name, args);
    };

    clock = timestampDate(r.nextRunAt!);
    const snapshot = await idle(id);

    return { r, seen, snapshot, card: snapshot.approvals.find((a) => a.parked)! };
  };

  const continuations = (id: string) =>
    query<{ id: string; input: string; routine_id: string; status: string; resume_approval_id: string | null }>(
      "SELECT id, input, routine_id, status, resume_approval_id FROM bot_turns WHERE bot_id = $1 AND client_request_id LIKE 'parked:%'",
      [id],
    );

  beforeAll(async () => {
    gw = await startTestGateway();
    await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "parked-test",
      label: "Parked test",
      create: true,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      allWorkers: true,
    });
    await eventually(
      () => gw.core.bots.run((s) => s.harnessModels(gw.userId, Provider.CODEX, "parked-test")),
      (models) => models.some((m) => m.id === "gpt-6.1-sol"),
    );
  }, 30_000);
  beforeEach(() => {
    clock = new Date("2030-01-07T08:01:00Z");
    ids = [];
    model = async () => reply("Nothing");
    core = new GatewayCore({
      runtime: gw.runtime,
      userId: gw.userId,
      instanceId: Bun.randomUUIDv7(),
      botClock: () => clock,
      botModel: (i) => model(i),
    });
  });
  afterEach(async () => {
    await core.bots.stop();

    for (const id of ids) await gw.api.deleteBot({ botId: id });
  });
  afterAll(async () => {
    await gw?.close();
  });

  test("a parked question ends the run, keeps the chat free and its answer starts a continuation", async () => {
    const id = await add();
    const { r, card, snapshot } = await parkWith(id, "ask_user", { question: "Ship 2.1?" }, "Asked about 2.1");

    expect(card.kind).toBe("question");
    expect(card.status).toBe("pending");
    expect(card.routineTitle).toBe(r.title);
    expect(snapshot.statusLine).toBe("");

    const parkedRun = await query<{ status: string; checkpoint: unknown }>(
      "SELECT status, checkpoint FROM bot_turns WHERE routine_id = $1 AND client_request_id LIKE 'routine:%'",
      [r.id],
    );

    expect(parkedRun.map((t) => t.status)).toEqual(["completed"]);
    expect(JSON.stringify(parkedRun[0]!.checkpoint)).toContain('\\"status\\":\\"parked\\"');

    // The owner's private message runs while the card is still open.
    model = async () => reply("Private answer");
    const chat = await send(id, "Hello while the card is open");
    expect(chat.messages.at(-1)?.text).toBe("Private answer");
    expect(chat.approvals.find((a) => a.id === card.id)?.status).toBe("pending");

    const seen: ModelInput[] = [];
    model = async (i) => {
      seen.push(i);

      return reply("Continued");
    };

    await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "Yes, ship it" });
    // A retried decision returns the stored one and queues nothing new.
    await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "Yes, ship it" });
    await idle(id);

    const next = await continuations(id);
    expect(next).toHaveLength(1);
    expect(next[0]!.routine_id).toBe(r.id);
    expect(next[0]!.status).toBe("completed");
    expect(next[0]!.resume_approval_id).toBeNull();
    expect(inputOf(seen[0]!)).toContain("The owner answered: Yes, ship it");
    expect(inputOf(seen[0]!)).toContain("Asked about 2.1");
    expect(seen[0]!.instructions).toContain("HIDDEN BACKGROUND RUN");
  });

  test("an approved parked action runs once, in its continuation, and its result reaches the model", async () => {
    const id = await add();
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    const { card, seen } = await parkWith(id, "schedule_wakeup", { prompt: "Check 2.1", run_at: runAt }, "Proposed");

    expect(card.kind).toBe("approval");
    const wakeups = () => query("SELECT id FROM bot_wakeups WHERE bot_id = $1", [id]);
    expect(await wakeups()).toHaveLength(0);
    expect(seen.some((i) => inputOf(i).includes("Continuation"))).toBe(false);

    const after: ModelInput[] = [];
    model = async (i) => {
      after.push(i);

      return reply("Continued");
    };

    await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "" });
    await idle(id);
    await core.bots.tick();

    expect(await wakeups()).toHaveLength(1);
    const [next] = await continuations(id);
    expect(next!.resume_approval_id).toBe(card.id);
    expect(next!.input.match(/Result of the approved action/g)).toHaveLength(1);
    expect(inputOf(after[0]!)).toContain("The owner approved it");
    expect(inputOf(after[0]!)).toContain("Result of the approved action");
  });

  test("a declined parked action never runs; its continuation reports the decision", async () => {
    const id = await add();
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    const { card } = await parkWith(id, "schedule_wakeup", { prompt: "Check 2.1", run_at: runAt }, "Proposed");

    await gw.api.answerBotApproval({ approvalId: card.id, approve: false, answer: "" });
    await idle(id);

    expect(await query("SELECT id FROM bot_wakeups WHERE bot_id = $1", [id])).toHaveLength(0);
    const [next] = await continuations(id);
    expect(next!.input).toContain("The owner declined it");
    expect(next!.resume_approval_id).toBeNull();
  });

  test("an expired parked card reports back once; a disabled routine discards its cards", async () => {
    const id = await add();
    const { r, card } = await parkWith(id, "ask_user", { question: "Ship 2.1?" }, "Asked");

    // However large the card, its continuation fits the queue.
    await query(
      "UPDATE bot_approvals SET prompt = repeat('x', 100000), expires_at = now() - interval '1 minute' WHERE id = $1",
      [card.id],
    );
    await idle(id);
    await idle(id);

    const expired = await read(id);
    expect(expired.approvals.find((a) => a.id === card.id)?.status).toBe("expired");
    const next = await continuations(id);
    expect(next).toHaveLength(1);
    expect(next[0]!.input).toContain("expired");
    expect(next[0]!.input.length).toBeLessThan(10_000);

    // A second parked card, then the routine is turned off: no continuation can start.
    model = async (i) =>
      i.messages.at(-1)?.role === "tool" ? reply("Asked") : tool("ask_user", { question: "Again?" });
    clock = timestampDate((await read(id)).routines[0]!.nextRunAt!);
    const second = (await idle(id)).approvals.find((a) => a.parked && a.status === "pending")!;

    await gw.api.setBotRoutineEnabled({ botId: id, routineId: r.id, enabled: false });
    expect((await read(id)).approvals.find((a) => a.id === second.id)?.status).toBe("discarded");
    // A late decision returns the discarded card and starts nothing.
    expect(await failure(gw.api.answerBotApproval({ approvalId: second.id, approve: true, answer: "Late" }))).toBe("");
    expect(await continuations(id)).toHaveLength(1);
  });

  test("an approved parked bot creation keeps the configuration the owner approved", async () => {
    const id = await add();
    const { card } = await parkWith(id, "create_bot", { name: "Release helper" }, "Proposed a helper");

    expect(card.proposedBot?.name).toBe("Release helper");
    await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "" });
    await idle(id);

    const created = await query<{ id: string }>(
      "SELECT id FROM bots WHERE created_by_bot_id = $1 AND deleted_at IS NULL",
      [id],
    );

    ids.push(...created.map((b) => b.id));
    expect(created).toHaveLength(1);
    const [next] = await continuations(id);
    expect(next!.input).toContain("Release helper");
    expect(next!.input).not.toContain("requires user approval");
  });

  test("an approved parked change to an owner thread acts with the asking run's access", async () => {
    const id = await add();
    const project = (await gw.api.createProject({ name: `Parked ${Bun.randomUUIDv7()}` })).project!.id;
    const thread = Bun.randomUUIDv7();
    await query(
      `INSERT INTO threads(id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, status, title)
       VALUES($1::uuid, $1::uuid, $2::uuid, $3::uuid, 'main', 'gateway', 'anthropic', 'idle', 'Release build')`,
      [thread, project, gw.userId],
    );
    const { card } = await parkWith(id, "rename_thread", { thread_id: thread, title: "Release 2.1" }, "Proposed");

    expect(card.kind).toBe("approval");
    await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "" });
    await idle(id);

    const [renamed] = await query<{ title: string }>("SELECT title FROM threads WHERE id = $1::uuid", [thread]);
    expect(renamed!.title).toBe("Release 2.1");
    const [next] = await continuations(id);
    expect(next!.input).not.toContain("delegated from this conversation");
  });

  test("a decision taken before the run ends still gives the continuation that run's final answer", async () => {
    const id = await add();
    const r = await routine(id);
    model = async (i) => {
      if (inputOf(i).includes("Continuation of a parked")) return reply("Continued");

      if (i.messages.at(-1)?.role !== "tool") return tool("ask_user", { question: "Ship 2.1?" });
      const [card] = await query<{ id: string }>("SELECT id FROM bot_approvals WHERE bot_id = $1 AND parked", [id]);
      await gw.api.answerBotApproval({ approvalId: card!.id, approve: true, answer: "Yes" });

      return reply("Waiting for the owner about 2.1");
    };

    clock = timestampDate(r.nextRunAt!);
    await idle(id);

    const [next] = await continuations(id);
    expect(next!.status).toBe("completed");
    expect(next!.input).toContain("The owner answered: Yes");
    expect(next!.input).toContain("Your final answer from that run:\nWaiting for the owner about 2.1");
  });

  test("a reminder from the private chat parks its question, and the chat stays free", async () => {
    const id = await add();
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply("Reminder set")
        : tool("schedule_wakeup", { prompt: "Ask about 2.1", run_at: runAt });
    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, { botId: id, text: "Remind me", clientRequestId: Bun.randomUUIDv7() }),
    );

    const setup = await eventually(
      async () => {
        await core.bots.tick();

        return read(id);
      },
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    const reminderCard = setup.approvals.find((a) => a.status === "pending")!;
    expect(reminderCard.parked).toBe(false);
    await gw.api.answerBotApproval({ approvalId: reminderCard.id, approve: true, answer: "" });
    await idle(id);

    model = async (i) => {
      if (inputOf(i).includes("Continuation of a parked")) return reply("Continued");

      return i.messages.at(-1)?.role === "tool" ? reply("Asked") : tool("ask_user", { question: "Ship 2.1?" });
    };

    await query("UPDATE bot_wakeups SET run_at = now() - interval '1 minute' WHERE bot_id = $1", [id]);
    const woken = await idle(id);
    const card = woken.approvals.find((a) => a.kind === "question")!;
    expect(card.parked).toBe(true);

    model = async () => reply("Private answer");
    expect((await send(id, "Still there?")).messages.at(-1)?.text).toBe("Private answer");

    // A thread delegated to the reminder's run stays readable from its continuation.
    const [woke] = await query<{ id: string }>(
      "SELECT id FROM bot_turns WHERE bot_id = $1 AND client_request_id LIKE 'wakeup:%'",
      [id],
    );

    const project = (await gw.api.createProject({ name: `Parked ${id}` })).project!.id;
    const delegated = crypto.randomUUID();
    await query(
      `INSERT INTO threads(id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, status, title, memory_audience)
       VALUES($1::uuid, $1::uuid, $2::uuid, $3::uuid, 'main', 'gateway', 'anthropic', 'running', 'Delegated', $4)`,
      [delegated, project, gw.userId, `turn:${id}:${woke!.id}`],
    );
    const results: string[] = [];
    model = async (i) => {
      if (i.messages.at(-1)?.role !== "tool") return tool("read_thread", { thread_id: delegated });
      results.push(i.messages.at(-1)!.text);

      return reply("Continued");
    };

    await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "Yes" });
    await idle(id);
    const [next] = await continuations(id);
    expect(next!.status).toBe("completed");
    expect(next!.input).toContain("The owner answered: Yes");
    expect(results[0]).not.toContain("error");
  });
});

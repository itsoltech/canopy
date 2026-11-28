import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, isMessage } from "@bufbuild/protobuf";
import { ExportThreadImageSchema, InteractionKind, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { botEntries } from "@canopy/domain/bot-chat";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import sharp from "sharp";
import { MessengerStore, type OutboundResult } from "../../apps/gateway/src/messengers/store.ts";
import { conversationFiles } from "../../apps/gateway/src/core/bot-files.ts";
import { botPlatform } from "../../apps/gateway/src/bots/platform.ts";
import { coreState } from "../../apps/gateway/src/core/core-context.ts";
import { botImageInput } from "../../apps/gateway/src/core/bot-images.ts";
import { withSlackBotInput } from "../../apps/gateway/src/core/bot-slack-input.ts";
import { areaTool } from "../../apps/gateway/src/bots/tools/index.ts";
import type { BotTurn } from "../../apps/gateway/src/bots/types.ts";
import { failAfterCommentary } from "./support/agent-report.ts";
import { botsSuite } from "./support/bots.ts";
import { eventually } from "./support/gateway.ts";
import { mp4 } from "./support/video-fixtures.ts";

describe.skipIf(!dockerAvailable)("messenger work callback origin", () => {
  const { suite, add, read } = botsSuite({
    worker: {
      hello: { capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY, "bot_workspace_v1", "bot_files_v1", "bot_images_v1"] },
    },
  });

  const ids: string[] = [];

  const query = <A extends object>(text: string, values: string[] = []) =>
    suite.gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, values)));

  const messenger = <A, E>(use: (s: MessengerStore["Service"]) => Effect.Effect<A, E>) =>
    suite.gw.runtime.runPromise(MessengerStore.use(use));

  beforeEach(async () => {
    await suite.current.bots.stop();
    suite.currentWorker.holdTurns = true;
  });
  afterEach(async () => {
    suite.currentWorker.holdTurns = false;
    suite.currentWorker.handlers.delete("exportThreadImage");

    for (const id of ids.splice(0)) await suite.current.bots.remove(id);
  });

  async function external(existing?: string) {
    const botId = existing ?? (await add("Messenger origin")).id;
    ids.push(botId);

    const account = await messenger((s) =>
      s.saveAccount(suite.gw.userId, {
        name: "Origin workspace",
        externalId: crypto.randomUUID(),
        appToken: "xapp-fixture",
        botToken: "xoxb-fixture",
      }),
    );

    const route = await messenger((s) =>
      s.saveRoute(suite.gw.userId, {
        botId,
        accountId: account.id,
        channelIds: ["CPRODUCT"],
        userIds: ["UREPORTER"],
        directMessages: false,
        mentions: true,
        observe: false,
        delivery: "reply",
        instructions: "Investigate reported issues.",
      }),
    );

    const now = new Date();
    const lease = (await messenger((s) => s.claimAccount(suite.gw.userId, account.id, "origin-test", now)))!;
    await messenger((s) =>
      s.ingest(
        suite.gw.userId,
        {
          id: crypto.randomUUID(),
          accountId: account.id,
          channelId: "CPRODUCT",
          threadId: "100.1",
          messageId: "100.2",
          authorId: "UREPORTER",
          text: "Investigate the login issue",
          timestamp: "100.2",
          mention: true,
          direct: false,
        },
        lease,
        now,
      ),
    );
    await messenger((s) => s.dispatch(suite.gw.userId, new Date(now.getTime() + 3000)));
    const turn = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;

    expect(turn.conversation_id).toBeTruthy();

    return { botId, turn, route, lease };
  }

  async function delegated(turn: BotTurn) {
    const call = await suite.current.bots.run((s) =>
      s.planCall(
        turn,
        "delegate",
        {
          name: "start_thread",
          description: "Delegate a repair",
          source: "platform",
          parameters: {},
        },
        { project_name: "PRIVATE_EXTERNAL_ARGUMENT" },
      ),
    );

    if (turn.conversation_id) {
      const active = await read(turn.bot_id);
      expect(active.statusLine).toContain("Starting a thread");
      expect(active.statusLine).toContain("Slack");
      expect(active.working).toBe(false);
      expect(active.statusLine).not.toContain("PRIVATE_EXTERNAL_ARGUMENT");
    }

    const started = await suite.current.startBotThread(
      turn,
      call,
      create(ui.CreateThreadRequestSchema, {
        projectId: suite.projectId,
        workspaceId: suite.workspaceId,
        provider: Provider.CODEX,
        title: "Login fix",
        initialMessage: "Investigate login",
        clientRequestId: call.id,
      }),
    );

    await suite.current.bots.run((s) => s.finish(turn, "completed", "Investigating"));
    expect(await eventually(async () => suite.currentWorker.inputs.has(started.thread_id), Boolean)).toBe(true);

    return { threadId: started.thread_id, turnId: started.turn_id!, call };
  }

  async function expectStatus(turnId: string, status: "running" | "completed" | "failed") {
    expect(
      await eventually(
        () => query<{ status: string }>("SELECT status FROM turns WHERE id=$1::uuid", [turnId]),
        (r) => r[0]?.status === status,
      ),
    ).toEqual([{ status }]);
  }

  async function finishTarget(threadId: string, turnId: string) {
    suite.currentWorker.finish(threadId, turnId, "Login repair is ready");
    await expectStatus(turnId, "completed");
  }

  function exportFiles(files: ReadonlyMap<string, Uint8Array>) {
    suite.currentWorker.handlers.set("exportThreadImage", (request, reply) => {
      if (!isMessage(request, ExportThreadImageSchema)) return reply(false);

      if (request.operation === "release") return reply(true, { threadImageExport: {} });
      const data = files.get(request.path);

      if (!data) return reply(false, { errorMessage: "The selected file is unavailable." });
      reply(true, {
        threadImageExport: {
          name: request.path,
          sizeBytes: BigInt(data.length),
          sha256: createHash("sha256").update(data).digest("hex"),
          data: request.operation === "probe" ? new Uint8Array() : data.subarray(Number(request.offset)),
        },
      });
    });
  }

  async function relayFile(turn: BotTurn, id: string) {
    const { current: core } = suite;
    const tool = areaTool.get("send_attachment")!.spec;

    const call = await core.bots.run((s) =>
      s.planCall(turn, crypto.randomUUID(), tool, { attachment_id: id, caption: "Shared file" }),
    );

    return botPlatform(core, core[coreState].options, turn, call);
  }

  test("a delegated thread sends selected workspace files as a private bot message", async () => {
    const botId = (await add("Private artifacts")).id;
    ids.push(botId);
    const { bots } = suite.current;
    const { userId } = suite.gw;
    await bots.run((s) => s.enqueue(userId, botId, "Prepare a demo", crypto.randomUUID()));
    const work = await delegated((await bots.run((s) => s.claim(userId)))!);
    await expectStatus(work.turnId, "running");

    const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#4499aa" } })
      .png()
      .toBuffer();

    const text = new TextEncoder().encode("Representative fixture notes");
    const binary = Uint8Array.of(0, 2, 4, 6, 8, 255);

    const files = new Map<string, Uint8Array>([
      ["result.png", png],
      ["demo.mp4", mp4],
      ["notes.txt", text],
      ["data.dat", binary],
    ]);

    exportFiles(files);

    const message = (paths: string[], callId = crypto.randomUUID()) =>
      suite.currentWorker.callTool({
        ...work,
        tool: "message_delegating_bot",
        args: { text: "The demo files", attachment_paths: paths },
        callId,
      });

    const denied = await message(["result.png", "unavailable.txt"]);
    expect(denied).toMatchObject({ isError: true, content: "The selected file is unavailable." });
    expect(await bots.run((s) => s.claim(userId))).toBeUndefined();

    const callId = crypto.randomUUID();
    const sent = await message([...files.keys()], callId);
    expect(sent.isError, sent.content).toBe(false);
    expect((await message([...files.keys()], callId)).content).toBe(sent.content);
    const callback = (await bots.run((s) => s.claim(userId)))!;

    const entry = botEntries(await read(botId)).find(
      (entry) => entry.kind === "message" && entry.message.text === "The demo files",
    );

    const attachments = entry?.kind === "message" ? entry.message.attachments! : [];
    expect(attachments.map((a) => [a.name, a.kind, a.mimeType])).toEqual([
      ["result.png", "image", "image/png"],
      ["demo.mp4", "video", "video/mp4"],
      ["notes.txt", "file", "text/plain"],
      ["data.dat", "file", "application/octet-stream"],
    ]);
    expect(attachments[0]).toMatchObject({ width: 24, height: 16, hasThumbnail: true });
    expect(attachments[1]?.durationMs).toBe(2000);
    expect((await suite.gw.api.getAttachment({ attachmentId: attachments[3]!.id })).data).toEqual(binary);

    expect(await relayFile(callback, attachments[2]!.id)).toMatchObject({ delivered: true });
    const outgoing = (await read(botId)).messages.find((m) => m.text === "Shared file")!.attachments[0]!;
    expect(outgoing.id).not.toBe(attachments[2]!.id);
    expect((await suite.gw.api.getAttachment({ attachmentId: outgoing.id })).data).toEqual(text);
    await bots.run((s) => s.finish(callback, "completed", ""));

    await finishTarget(work.threadId, work.turnId);
    await bots.run((s) => s.deliver(userId));
    const report = (await bots.run((s) => s.claim(userId)))!;
    expect(report.input).toContain("Login repair is ready");
    expect((await read(botId)).messages.at(-1)).toMatchObject({ kind: "event", attachments: [] });
    await bots.run((s) => s.finish(report, "completed", ""));
  });

  test("a Slack callback passes its file to bot input and only that conversation can share it", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    await expectStatus(work.turnId, "running");
    const { current: core, gw } = suite;
    const { bots } = core;
    exportFiles(new Map([["report.txt", new TextEncoder().encode("A synthetic report")]]));

    const sent = await suite.currentWorker.callTool({
      threadId: work.threadId,
      turnId: work.turnId,
      tool: "message_delegating_bot",
      args: { text: "The requested report", attachment_paths: ["report.txt"] },
    });

    expect(sent.isError, sent.content).toBe(false);

    const callback = (await bots.run((s) => s.claim(gw.userId)))!;
    expect(callback.conversation_id).toBe(f.turn.conversation_id);
    const messages = await bots.run((s) => s.history(callback, true, false));

    const input = await withSlackBotInput(
      core,
      {
        messages,
        configuration: (await read(f.botId)).bot!.configuration!,
        instructions: "",
        tools: [],
        signal: new AbortController().signal,
      },
      gw.workerId,
      callback,
    );

    const workerInput = await botImageInput(core, f.botId, gw.workerId, input);
    expect(workerInput.input).not.toContain("attachments were unavailable");
    expect(workerInput.attachments.map((a) => a.name)).toEqual(["report.txt"]);
    const id = workerInput.attachments[0]!.attachmentId;
    expect(await relayFile(callback, id)).toMatchObject({ queued_for_reply: 1 });
    await bots.run((s) => s.finish(callback, "completed", "The report is attached"));

    const reply = (await messenger((s) => s.outbound(gw.userId, f.lease, new Date()))).find(
      (o) => o.text === "The report is attached",
    )!;

    expect(reply.threadId).toBe("100.1");
    expect(await messenger((s) => s.outboundFiles(gw.userId, reply.id))).toMatchObject([{ name: "report.txt" }]);

    await bots.run((s) => s.enqueue(gw.userId, f.botId, "Share another file", crypto.randomUUID()));
    const privateTurn = (await bots.run((s) => s.claim(gw.userId)))!;
    expect(await relayFile(privateTurn, id)).toEqual({
      error: "This file is unavailable in the current conversation.",
    });
    expect((await read(f.botId)).messages.every((m) => !m.attachments.length)).toBe(true);
    await bots.run((s) => s.finish(privateTurn, "completed", ""));
    await finishTarget(work.threadId, work.turnId);
  });

  test("a delegated thread reports once into the originating external conversation", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    await finishTarget(work.threadId, work.turnId);
    await suite.current.bots.run((s) => s.deliver(suite.gw.userId));
    await suite.current.bots.run((s) => s.deliver(suite.gw.userId));

    const callbacks = await query<BotTurn>("SELECT * FROM bot_turns WHERE client_request_id=$1", [
      `thread:${work.call.id}`,
    ]);

    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]!.conversation_id).toBe(f.turn.conversation_id);
    expect(callbacks[0]!.input).toContain("Login repair is ready");
    const followup = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;
    await suite.current.bots.run((s) => s.finish(followup, "completed", "The repair is ready for review"));
    const outbound = await messenger((s) => s.outbound(suite.gw.userId, f.lease, new Date()));

    expect(outbound.map((o) => o.threadId)).toEqual(["100.1", "100.1"]);
    const pending = await read(f.botId);
    expect(pending.messages.filter((m) => m.senderId !== "activity")).toHaveLength(0);
    expect(pending.messages.some((m) => m.text.startsWith("Replied on Slack"))).toBe(false);

    const [sent, unknown] = outbound;

    const settle = (id: string, result: OutboundResult) =>
      messenger((s) => s.settleOutbound(suite.gw.userId, f.lease, id, result, new Date()));

    await settle(sent!.id, { sent: true });
    await settle(sent!.id, { sent: true });
    await settle(unknown!.id, { sent: false, uncertain: true });
    await settle(unknown!.id, { sent: true });

    const final = await read(f.botId);
    const replies = final.messages.filter((m) => m.senderId === "activity" && m.text.startsWith("Replied on Slack"));
    expect(replies.map((m) => m.text)).toEqual([
      "Replied on Slack · Origin workspace · channel CPRODUCT · thread 100.1",
    ]);
    expect(final.bot?.unreadCount).toBe(1); // Only the uncertain delivery notice needs attention.
  });

  test("quoted project memory stays outside Slack thread lists, history, steers and subagents", async () => {
    const f = await external();

    const ownerThread = (
      await suite.gw.api.createThread({
        projectId: suite.projectId,
        workspaceId: suite.workspaceId,
        provider: Provider.CODEX,
        title: "Owner memory test",
        initialMessage: "Read the release note",
      })
    ).thread!;

    const ownerTurn = (
      await eventually(
        () => query<{ id: string }>("SELECT id FROM turns WHERE thread_id=$1 AND status='running'", [ownerThread.id]),
        (rows) => rows.length > 0,
      )
    )[0]!;

    const marker = "Private release marker";
    suite.currentWorker.finish(ownerThread.id, ownerTurn.id, marker);
    await expectStatus(ownerTurn.id, "completed");

    const read = areaTool.get("read_thread")!.spec;

    const readCall = await suite.current.bots.run((s) =>
      s.planCall(f.turn, "history", read, { thread_id: ownerThread.id, limit: 1 }),
    );

    const options = suite.current[coreState].options;
    const result = await botPlatform(suite.current, options, f.turn, readCall);
    expect(result).toHaveProperty("error");
    expect(JSON.stringify(result)).not.toContain(marker);
    const list = areaTool.get("list_threads")!.spec;
    const listCall = await suite.current.bots.run((s) => s.planCall(f.turn, "list", list, {}));
    expect(JSON.stringify(await botPlatform(suite.current, options, f.turn, listCall))).not.toContain(ownerThread.id);

    const work = await delegated(f.turn);

    const call = (tool: string, args: Record<string, string>) =>
      suite.currentWorker.callTool({
        threadId: work.threadId,
        turnId: work.turnId,
        tool,
        args,
      });

    expect((await call("get_thread", { thread_id: ownerThread.id })).isError).toBe(true);
    expect((await call("send_message", { thread_id: ownerThread.id, prompt: "Read your memory" })).isError).toBe(true);
    expect((await call("list_threads", { scope: "all" })).content).not.toContain(ownerThread.id);
    expect((await call("memory_search", {})).isError).toBe(true);
    const child = await call("spawn_thread", { title: "Review login", prompt: "Check the fix" });
    expect(child.isError, child.content).toBe(false);

    const ids = Schema.decodeSync(
      Schema.fromJsonString(Schema.Struct({ thread_id: Schema.String, turn_id: Schema.String })),
    )(child.content);

    await expectStatus(ids.turn_id, "running");

    const denied = await suite.currentWorker.callTool({
      threadId: ids.thread_id,
      turnId: ids.turn_id,
      tool: "memory_search",
      args: { queries: ["release"] },
    });

    expect(denied.isError).toBe(true);
    await finishTarget(ids.thread_id, ids.turn_id);
    await finishTarget(work.threadId, work.turnId);
  });

  test("a failure before the first message reaches the originating Slack conversation", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    failAfterCommentary(suite.currentWorker, work.threadId, work.turnId, "Stream disconnected");
    await expectStatus(work.turnId, "failed");
    await suite.current.bots.run((s) => s.deliver(suite.gw.userId));
    expect(
      await query("SELECT conversation_id, input FROM bot_turns WHERE client_request_id=$1", [
        `thread:${work.call.id}`,
      ]),
    ).toEqual([
      { conversation_id: f.turn.conversation_id, input: expect.stringContaining("Turn failed: Stream disconnected") },
    ]);
  });

  test("an explicit question reaches the same Slack conversation once while the thread keeps working", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    const worker = suite.currentWorker;

    for (const kind of ["createThread", "startTurn"])
      expect(worker.commands).toContainEqual(
        expect.objectContaining({
          case: kind,
          value: expect.objectContaining({
            thread: expect.objectContaining({ threadId: work.threadId, hasDelegatingBot: true }),
          }),
        }),
      );
    const text = "Which system and proxy version should I test?";

    const call = {
      threadId: work.threadId,
      turnId: work.turnId,
      tool: "message_delegating_bot",
      args: { text },
      callId: crypto.randomUUID(),
    };

    const sent = await worker.callTool(call);
    expect(sent.isError).toBe(false);
    expect((await worker.callTool(call)).content).toBe(sent.content);
    const question = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;
    expect(question.bot_id).toBe(f.botId);
    expect(question.conversation_id).toBe(f.turn.conversation_id);
    expect(question.input).toContain(text);
    await suite.current.bots.run((s) => s.finish(question, "completed", text));
    expect(await suite.current.bots.run((s) => s.claim(suite.gw.userId))).toBeUndefined();

    await finishTarget(work.threadId, work.turnId);
    await suite.current.bots.run((s) => s.deliver(suite.gw.userId));
    const final = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;
    expect(final.conversation_id).toBe(question.conversation_id);
    expect(final.input).toContain("Login repair is ready");
    expect(final.input).not.toContain(text);
    await suite.current.bots.run((s) => s.finish(final, "completed", "The repair is ready for review"));
    expect((await read(f.botId)).messages.filter((m) => m.senderId !== "activity")).toEqual([]);
  });

  test("an owner follow-up can message the creator after the Slack report was delivered", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    const { bots } = suite.current;
    const { userId } = suite.gw;
    await finishTarget(work.threadId, work.turnId);
    await bots.run((s) => s.deliver(userId));
    const report = (await bots.run((s) => s.claim(userId)))!;
    expect(report.conversation_id).toBe(f.turn.conversation_id);
    await bots.run((s) => s.finish(report, "completed", ""));

    const { turn } = await suite.gw.api.sendMessage({
      threadId: work.threadId,
      text: "Verify this with the private deployment details",
      clientRequestId: crypto.randomUUID(),
    });

    await expectStatus(turn!.id, "running");
    const text = "The private deployment has been verified.";

    const call = {
      threadId: work.threadId,
      turnId: turn!.id,
      tool: "message_delegating_bot",
      args: { text },
      callId: crypto.randomUUID(),
    };

    const sent = await suite.currentWorker.callTool(call);
    expect(sent.isError, sent.content).toBe(false);
    expect((await suite.currentWorker.callTool(call)).resultJson).toBe(sent.resultJson);
    const callback = (await bots.run((s) => s.claim(userId)))!;
    expect(callback.bot_id).toBe(f.botId);
    expect(callback.conversation_id).toBeNull();
    expect(callback.input).toContain(text);
    await bots.run((s) => s.finish(callback, "completed", "Received privately"));
    await finishTarget(work.threadId, turn!.id);
    await bots.run((s) => s.deliver(userId));
    expect(await bots.run((s) => s.claim(userId))).toBeUndefined();
  });

  test.each(["completed", "failed"])("private and Slack input suppress questions and %s reports", async (status) => {
    const f = await external();
    const work = await delegated(f.turn);
    const { bots } = suite.current;
    const { userId } = suite.gw;

    const { steer } = await suite.gw.api.sendMessage({
      threadId: work.threadId,
      text: "Also check the private report",
      delivery: ui.MessageDelivery.STEER,
      clientRequestId: Bun.randomUUIDv7(),
    });

    expect(steer?.turnId).toBe(work.turnId);

    const rows = await eventually(
      () => query<{ status: string }>("SELECT status FROM turn_steers WHERE id=$1", [steer!.id]),
      (rows) => rows[0]?.status === "delivered",
    );

    expect(rows[0]?.status).toBe("delivered");

    const result = await suite.currentWorker.callTool({
      threadId: work.threadId,
      turnId: work.turnId,
      tool: "message_delegating_bot",
      args: { text: "Which report should I use?" },
    });

    expect(result.isError).toBe(true);
    const requestId = crypto.randomUUID();
    suite.currentWorker.ask({
      threadId: work.threadId,
      turnId: work.turnId,
      requestId,
      kind: InteractionKind.QUESTION,
      requestJson: '{"question":"Private review?"}',
    });
    expect(
      await eventually(
        () => query("SELECT id FROM interaction_requests WHERE id=$1", [requestId]),
        (r) => !!r.length,
      ),
    ).toHaveLength(1);
    await bots.run((s) => s.deliver(userId));
    expect(await query("SELECT call_id FROM bot_thread_question_deliveries WHERE request_id=$1", [requestId])).toEqual(
      [],
    );
    expect(await bots.run((s) => s.claim(userId))).toBeUndefined();

    if (status === "failed") {
      failAfterCommentary(suite.currentWorker, work.threadId, work.turnId, "Private review error", "Partial review");
      await expectStatus(work.turnId, "failed");
    } else await finishTarget(work.threadId, work.turnId);
    await bots.run((s) => s.deliver(userId));
    expect(await query("SELECT id FROM bot_turns WHERE client_request_id=$1", [`thread:${work.call.id}`])).toEqual([]);
    expect(
      await query("SELECT id FROM bot_messages WHERE bot_id=$1 AND sender_id=$2 AND kind='event'", [
        f.botId,
        work.threadId,
      ]),
    ).toEqual([]);
    expect(await query("SELECT delivered FROM bot_thread_watches WHERE call_id=$1", [work.call.id])).toEqual([
      { delivered: true },
    ]);
  });

  for (const change of ["notify", "delete", "channel"] as const) {
    test(`a ${change} route change fences the remaining claimed reply`, async () => {
      const f = await external();
      const { userId } = suite.gw;
      const work = await delegated(f.turn);
      await finishTarget(work.threadId, work.turnId);
      await suite.current.bots.run((s) => s.deliver(userId));
      const followup = (await suite.current.bots.run((s) => s.claim(userId)))!;
      await suite.current.bots.run((s) => s.finish(followup, "completed", "Reviewed"));
      const rows = await messenger((s) => s.outbound(userId, f.lease, new Date()));
      expect(rows).toHaveLength(2);
      const sent: string[] = [];

      const send = (id: string) =>
        messenger((s) =>
          s.sendClaimed(userId, f.lease, id, new Date(), async () => {
            sent.push(id);

            return { sent: true };
          }),
        );

      const first = await send(rows[0]!.id);
      expect(await first?.completion).toEqual({ sent: true });
      await messenger((s) => s.settleOutbound(userId, f.lease, rows[0]!.id, { sent: true }, new Date()));

      if (change === "delete") await messenger((s) => s.deleteRoute(userId, f.route.id));
      else
        await messenger((s) =>
          s.saveRoute(userId, {
            ...f.route,
            ...(change === "notify" ? { delivery: "notify" } : { channelIds: ["COTHER"] }),
          }),
        );
      expect(await send(rows[1]!.id)).toBeUndefined();
      expect(sent).toEqual([rows[0]!.id]);
      expect(await query("SELECT status FROM messenger_outbound WHERE id=$1", [rows[1]!.id])).toEqual([
        { status: "failed" },
      ]);
    });
  }

  test("Slack cannot queue or steer work in an owner-created project thread", async () => {
    const f = await external();

    const thread = (
      await suite.gw.api.createThread({
        projectId: suite.projectId,
        workspaceId: suite.workspaceId,
        provider: Provider.CODEX,
        title: "Owner's investigation",
      })
    ).thread!;

    const args = { thread_id: thread.id, text: "Check the login logs", delivery: "queue" };

    const call = await suite.current.bots.run((s) =>
      s.planCall(f.turn, "send", { name: "send_message", source: "platform", parameters: {}, description: "" }, args),
    );

    for (const delivery of ["queue", "steer"])
      await expect(suite.current.sendBotThreadMessage(f.turn, call, thread.id, args.text, delivery)).rejects.toThrow(
        "Choose a thread",
      );
    expect(await query("SELECT id FROM turns WHERE thread_id=$1", [thread.id])).toEqual([]);
    await suite.current.bots.run((s) => s.finish(f.turn, "completed", ""));
  });

  test("a failed Slack turn reports its source to the owner without publishing the external error", async () => {
    const f = await external();
    await suite.current.bots.run((s) => s.finish(f.turn, "failed", "PRIVATE_PROVIDER_ERROR"));
    expect(await messenger((s) => s.outbound(suite.gw.userId, f.lease, new Date()))).toEqual([]);

    const chat = await read(f.botId);
    expect(chat.bot?.unreadCount).toBe(0);
    expect(chat.messages.map((m) => m.text)).toEqual([
      "Received a Slack message · Origin workspace · channel CPRODUCT · thread 100.1",
      "Could not finish the Slack request · Origin workspace · channel CPRODUCT · thread 100.1",
    ]);
    expect(chat.messages.every((m) => m.senderId === "activity" && m.kind === "event")).toBe(true);
  });

  test("revoking a subscription suppresses later thread reports without falling into private chat", async () => {
    const f = await external();
    const work = await delegated(f.turn);
    await messenger((s) => s.deleteRoute(suite.gw.userId, f.route.id));

    const denied = await suite.currentWorker.callTool({
      threadId: work.threadId,
      turnId: work.turnId,
      tool: "message_delegating_bot",
      args: { text: "Question after revocation" },
    });

    expect(denied.isError).toBe(true);
    expect(await suite.current.bots.run((s) => s.claim(suite.gw.userId))).toBeUndefined();
    await finishTarget(work.threadId, work.turnId);
    await suite.current.bots.run((s) => s.deliver(suite.gw.userId));

    expect(await query("SELECT id FROM bot_turns WHERE client_request_id=$1", [`thread:${work.call.id}`])).toEqual([]);
    expect((await read(f.botId)).messages.filter((m) => m.senderId !== "activity")).toHaveLength(0);
    expect(await suite.current.bots.run((s) => s.originEnabled(f.turn))).toBe(false);
  });

  test("external thread tools cannot forward guessed private conversation attachment ids", async () => {
    const botId = (await add("Private attachment origin")).id;

    const file = (
      await suite.gw.api.uploadAttachment({
        botId,
        name: "private.md",
        data: new TextEncoder().encode("Private conversation material"),
      })
    ).attachment!;

    await suite.current.bots.run((s) =>
      s.enqueue(suite.gw.userId, botId, "Keep this private", crypto.randomUUID(), {
        attachmentIds: [file.id],
      }),
    );
    const privateTurn = (await suite.current.bots.run((s) => s.claim(suite.gw.userId)))!;
    expect((await conversationFiles(suite.current, privateTurn, [file.id]))[0]?.id).toBe(file.id);
    await suite.current.bots.run((s) => s.finish(privateTurn, "completed", "Saved"));
    const f = await external(botId);

    expect(await conversationFiles(suite.current, f.turn)).toEqual([]);
    await expect(conversationFiles(suite.current, f.turn, [file.id])).rejects.toThrow("A file is unavailable");
    await suite.current.bots.run((s) => s.finish(f.turn, "completed", "No private attachment"));
  });
});

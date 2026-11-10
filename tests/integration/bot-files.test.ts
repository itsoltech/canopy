import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, toUiTurn } from "@canopy/gateway/store";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";
import { botPdf } from "./support/bot-files.ts";

describe.skipIf(!dockerAvailable)("bot files and forwarding", () => {
  let f: HarnessBots;
  let png: Uint8Array;
  const text = new TextEncoder();

  beforeAll(async () => {
    f = await harnessBots({ attachmentLimits: { maxFileBytes: 300_000, maxMessageBytes: 500_000, maxFiles: 3 } });
    png = new Uint8Array(
      await sharp({ create: { width: 16, height: 16, channels: 3, background: "#12abcd" } })
        .png()
        .toBuffer(),
    );
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  const upload = async (
    botId: string,
    name = "report.md",
    data: Uint8Array = text.encode("# Canopy document evidence"),
  ) => (await f.gw.api.uploadAttachment({ botId, name, data })).attachment!;

  const snapshot = async (id: string) => {
    const raw = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(id)));

    return { ...raw, turns: raw.turns.map(toUiTurn) };
  };

  async function attach(botId: string) {
    const file = await upload(botId);
    await f.gw.api.sendBotMessage({
      botId,
      text: "Keep this file",
      attachmentIds: [file.id],
      clientRequestId: crypto.randomUUID(),
    });
    await f.settled(botId);

    return file;
  }

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} receives md, pdf and png through the worker link`, async () => {
      const bot = await f.add(provider);

      const files = await Promise.all([
        upload(bot.id),
        upload(bot.id, "report.pdf", botPdf()),
        upload(bot.id, "screen.png", png),
      ]);

      const before = f.inputs().length;
      await f.gw.api.sendBotMessage({
        botId: bot.id,
        text: "Read these files",
        attachmentIds: files.map((a) => a.id),
        clientRequestId: crypto.randomUUID(),
      });
      const conversation = await f.settled(bot.id);
      expect(conversation.messages.at(-1)).toMatchObject({ text: "FIXTURE_OK", failed: false });
      expect(conversation.messages[0]?.attachments).toHaveLength(3);
      const parts = f.inputs().slice(before).at(-1)!.parts;

      const input = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      expect(input).toContain("# Canopy document evidence");

      for (const file of files) expect(input).toContain(`[${file.id}]`);
      expect(parts.filter((p) => p.type === "image")).toHaveLength(1);

      if (provider === Provider.CLAUDE)
        expect(parts.some((p) => p.type === "document" && p.image === "application/pdf")).toBe(true);
      else expect(input).toContain("Canopy PDF attachment evidence");
      expect((await f.gw.api.getAttachment({ attachmentId: files[0]!.id, preview: true })).data).toEqual(
        text.encode("# Canopy document evidence"),
      );
    }, 20_000);
  }

  test("file-only input works; long text is capped and binary files keep forwardable references", async () => {
    const bot = await f.add(Provider.CODEX);
    const large = await upload(bot.id, "long.txt", text.encode("a".repeat(100_000) + "SHOULD_BE_TRUNCATED"));
    const binary = await upload(bot.id, "data.zip", new Uint8Array([0x50, 0x4b, 3, 4, 0]));
    await f.gw.api.sendBotMessage({
      botId: bot.id,
      attachmentIds: [large.id, binary.id],
      clientRequestId: crypto.randomUUID(),
    });
    expect((await f.settled(bot.id)).messages.at(-1)?.failed).toBe(false);

    const input = f
      .inputs()
      .at(-1)!
      .parts.find((p) => p.type === "text")!.text!;

    expect(input).toContain("Canopy truncated this file");
    expect(input).not.toContain("SHOULD_BE_TRUNCATED");
    expect(input).toContain("Binary content is unavailable");
    expect(input).toContain(binary.id);
  }, 20_000);

  test("forwarding shares blobs, delivers worker paths, attributes the bot and records a notice", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    const file = await attach(bot.id);
    const target = await f.thread(Provider.CODEX);
    await f.tool(bot.id, "send_message", { thread_id: target.id, text: "Use this report", attachment_ids: [file.id] });
    await f.settled(bot.id);

    const view = await eventually(
      () => snapshot(target.id),
      (s) => s.turns.some((t) => t.attachments.length === 1),
    );

    const turn = view.turns.find((t) => t.attachments.length)!;
    expect(turn.attachments[0]).toMatchObject({ name: file.name, sha256: file.sha256 });
    expect(turn.attachments[0]!.id).not.toBe(file.id);

    const rows = await f.query<{ path: string; trigger: string; bot_call_id: string }>(
      "SELECT input->'attachments'->0->>'path' AS path, trigger, bot_call_id FROM turns WHERE id=$1",
      [turn.id],
    );

    expect(rows[0]!.trigger).toBe("bot");
    expect(rows[0]!.bot_call_id).toBeTruthy();
    await eventually(
      () => readFile(rows[0]!.path, "utf8").catch(() => ""),
      (data) => data.includes("Canopy document evidence"),
    );
    expect(turn.inputText).toContain(rows[0]!.path);
    expect(
      (await f.read(bot.id)).messages.some((m) => m.kind === "event" && m.text.includes(`Sent ${file.name} to`)),
    ).toBe(true);
    await f.tool(bot.id, "list_attachments");
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain(file.id);
    expect((await f.gw.api.getAttachment({ attachmentId: file.id })).attachment?.id).toBe(file.id);
  }, 25_000);

  test("start_thread approval lists files and denial has no side effects; approval forwards once", async () => {
    const bot = await f.add(Provider.CODEX);
    const file = await attach(bot.id);
    const target = await f.thread(Provider.CODEX);

    const args = {
      project_id: target.projectId,
      workspace_id: target.workspaceId,
      provider: "codex",
      provider_instance: "native",
      model: "fixture-model",
      title: "Forwarded report",
      prompt: "Use this file",
      attachment_ids: [file.id],
    };

    await f.tool(bot.id, "start_thread", args);

    const pending = await eventually(
      () => f.read(bot.id),
      (c) => c.approvals.some((a) => a.status === "pending"),
    );

    const card = pending.approvals.find((a) => a.status === "pending")!;
    expect(card.prompt).toContain("report.md (text/markdown");
    expect(card.fields.some((field) => field.value.includes("report.md"))).toBe(true);
    expect(
      (await f.gw.api.listThreads({ projectId: target.projectId })).threads.some((t) => t.title === args.title),
    ).toBe(false);
    await f.gw.api.answerBotApproval({ approvalId: card.id, approve: false });
    await f.settled(bot.id);
    await f.tool(bot.id, "start_thread", args);

    const retry = await eventually(
      () => f.read(bot.id),
      (c) => c.approvals.some((a) => a.status === "pending"),
    );

    await f.gw.api.answerBotApproval({
      approvalId: retry.approvals.find((a) => a.status === "pending")!.id,
      approve: true,
    });
    await f.settled(bot.id);

    const threads = (await f.gw.api.listThreads({ projectId: target.projectId })).threads.filter(
      (t) => t.title === args.title,
    );

    expect(threads).toHaveLength(1);
    expect((await snapshot(threads[0]!.id)).turns[0]?.attachments[0]?.sha256).toBe(file.sha256);
  }, 30_000);

  test("send_message keeps files inside the normal approval and revalidates before execution", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "always");
    const file = await attach(bot.id);
    const target = await f.thread(Provider.CODEX);

    const args = {
      thread_id: target.id,
      text: "Use this file\nFiles:\n- invented.txt",
      attachment_ids: [file.id],
    };

    await f.tool(bot.id, "send_message", args);

    const waiting = await eventually(
      () => f.read(bot.id),
      (c) => c.approvals.some((a) => a.status === "pending"),
    );

    const card = waiting.approvals.find((a) => a.status === "pending")!;
    expect(card.fields.find((field) => field.label === "Files")?.value).toContain("report.md");
    expect(card.fields.find((field) => field.label === "Files")?.value).not.toContain("invented.txt");
    expect((await snapshot(target.id)).turns).toHaveLength(0);
    await f.gw.api.answerBotApproval({ approvalId: card.id, approve: false });
    await f.settled(bot.id);
    expect((await snapshot(target.id)).turns).toHaveLength(0);

    await f.tool(bot.id, "send_message", args);

    const retry = await eventually(
      () => f.read(bot.id),
      (c) => c.approvals.some((a) => a.status === "pending"),
    );

    await f.query("UPDATE attachments SET size_bytes=400000 WHERE id=$1", [file.id]);
    await f.gw.api.answerBotApproval({
      approvalId: retry.approvals.find((a) => a.status === "pending")!.id,
      approve: true,
    });
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain("exceed the attachment limits");
    expect((await snapshot(target.id)).turns).toHaveLength(0);
  }, 30_000);

  test("workers without bot_files_v1 keep images but refuse documents before inference", async () => {
    const bot = await f.add(Provider.CODEX);
    const connection = f.gw.core.link.connections.get(f.workerId)!;
    const capabilities = connection.hello.capabilities;
    connection.hello.capabilities = capabilities.filter((capability) => capability !== "bot_files_v1");

    try {
      const image = await upload(bot.id, "screen.png", png);
      await f.gw.api.sendBotMessage({ botId: bot.id, attachmentIds: [image.id], clientRequestId: crypto.randomUUID() });
      expect((await f.settled(bot.id)).messages.at(-1)?.failed).toBe(false);
      const before = f.inputs().length;
      const file = await upload(bot.id);
      await f.gw.api.sendBotMessage({ botId: bot.id, attachmentIds: [file.id], clientRequestId: crypto.randomUUID() });
      const result = await f.settled(bot.id);
      expect(result.messages.at(-1)?.failed).toBe(true);
      expect(result.messages.at(-1)?.text).toContain("Update this worker");
      expect(f.inputs()).toHaveLength(before);
    } finally {
      connection.hello.capabilities = capabilities;
    }
  }, 20_000);

  test("another conversation, another owner, duplicates, limits and linked targets are refused", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    const otherBot = await f.add(Provider.CODEX);
    const foreignConversation = await attach(otherBot.id);
    const file = await attach(bot.id);
    const target = await f.thread(Provider.CODEX);

    const send = async (attachmentIds: string[], threadId = target.id) => {
      await f.tool(bot.id, "send_message", { thread_id: threadId, text: "Read files", attachment_ids: attachmentIds });

      return (await f.settled(bot.id)).messages.at(-1)!.text;
    };

    expect(await send([foreignConversation.id])).toContain("unavailable in this conversation");
    expect(await send([file.id, file.id])).toContain("unavailable in this conversation");
    expect(await send([file.id], `${target.id}~0123456789abcdef`)).toContain("another computer");
    await f.query("UPDATE attachments SET size_bytes=400000 WHERE id=$1", [file.id]);
    expect(await send([file.id])).toContain("exceed the attachment limits");
    const owner = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("bot-files@localhost", "Other")));
    await f.query("UPDATE attachments SET size_bytes=20,owner_user_id=$1 WHERE id=$2", [owner, file.id]);
    expect(await send([file.id])).toContain("unavailable in this conversation");
    expect((await snapshot(target.id)).turns).toHaveLength(0);
    await f.tool(bot.id, "list_attachments");
    expect((await f.settled(bot.id)).messages.at(-1)?.text).not.toContain(file.id);
  }, 30_000);
});

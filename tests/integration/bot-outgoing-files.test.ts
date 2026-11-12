import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, AttachmentStore } from "@canopy/gateway/store";
import { GatewayCore } from "@canopy/gateway/core";
import { connectBotDownload } from "../../apps/worker/src/bots/download.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot downloads and outgoing attachments", () => {
  let f: HarnessBots;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/redirect") return Response.redirect("http://private.fixture/file", 302);

        return new Response("# Downloaded note", { headers: { "Content-Type": "text/markdown" } });
      },
    });
    f = await harnessBots(
      {},
      {
        botDownloads: {
          resolve: async (host) => [{ address: host === "private.fixture" ? "10.0.0.1" : "93.184.216.34", family: 4 }],
          connect: (url, _address, signal) =>
            connectBotDownload(new URL(url.pathname, server.url), { address: "127.0.0.1", family: 4 }, signal),
        },
      },
    );
  }, 30_000);
  afterAll(async () => {
    await f?.close();
    await server?.stop(true);
  });

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} creates and delivers a downloadable owner-scoped attachment`, async () => {
      const bot = await f.add(provider, f.workerId, "full_auto");
      await f.tool(bot.id, "write_file", { path: "note.md", text: "# A prepared note" });
      await f.settled(bot.id);
      const handle = f.gw.core.bots.harnessTools.handle.bind(f.gw.core.bots.harnessTools);
      const replayResults: string[] = [];

      const replay = spyOn(f.gw.core.bots.harnessTools, "handle").mockImplementation(async (call, workerId) => {
        const first = await handle(call, workerId);

        if (call.toolName === "send_attachment")
          replayResults.push(first.resultJson, (await handle(call, workerId)).resultJson);

        return first;
      });

      let conversation;

      try {
        await f.tool(bot.id, "send_attachment", { path: "note.md", caption: "Your note" });
        conversation = await f.settled(bot.id);
      } finally {
        replay.mockRestore();
      }

      expect(replayResults).toHaveLength(2);
      expect(JSON.parse(replayResults[0]!)).toEqual(JSON.parse(replayResults[1]!));
      const message = conversation.messages.find((m) => m.text === "Your note")!;
      expect(message.senderId).toBe(bot.id);
      expect(message.attachments).toHaveLength(1);
      const file = message.attachments[0]!;
      expect(file).toMatchObject({ name: "note.md", mimeType: "text/markdown", sizeBytes: 17n });
      expect(new TextDecoder().decode((await f.gw.api.getAttachment({ attachmentId: file.id })).data)).toBe(
        "# A prepared note",
      );

      const audit = await f.query<{ action: string }>("SELECT action FROM audit_log WHERE target_id=$1::uuid", [
        bot.id,
      ]);

      expect(audit.map((a) => a.action)).toEqual(["bot.send_attachment"]);

      const other = await f.gw.runtime.runPromise(
        GatewayStore.use((s) => s.ensureUser(`${bot.id}@localhost`, "Other")),
      );

      await expect(f.gw.runtime.runPromise(AttachmentStore.use((s) => s.owned(other, file.id)))).rejects.toThrow();
      const foreign = new GatewayCore({ runtime: f.gw.runtime, userId: other, instanceId: crypto.randomUUID() });
      await expect(foreign.getAttachment(file.id, false)).rejects.toThrow();

      const turn = (
        await f.query<{ id: string }>(
          "SELECT id FROM bot_turns WHERE bot_id=$1::uuid ORDER BY created_at DESC LIMIT 1",
          [bot.id],
        )
      )[0]!;

      const stale = await f.gw.core.bots.harnessTools.handle(
        create(AgentToolCallSchema, {
          callId: crypto.randomUUID(),
          threadId: bot.id,
          botId: bot.id,
          turnId: turn.id,
          toolName: "send_attachment",
          argumentsJson: '{"path":"note.md"}',
        }),
        f.workerId,
      );

      expect(stale.isError).toBe(true);
      expect((await f.read(bot.id)).messages.filter((m) => m.attachments.length)).toHaveLength(1);
    });
  }

  test("worker files and a delivered attachment survive gateway and worker restarts", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    await f.tool(bot.id, "write_file", { path: "persistent.txt", text: "Survives restart" });
    await f.settled(bot.id);
    await f.restartWorker();
    await f.tool(bot.id, "send_attachment", { path: "persistent.txt", caption: "Saved" });
    const before = await f.settled(bot.id);
    const attachment = before.messages.find((message) => message.text === "Saved")!.attachments[0]!;
    await f.restartGateway();
    await f.reconnect();
    f.gw.core.bots.start();
    expect(new TextDecoder().decode((await f.gw.api.getAttachment({ attachmentId: attachment.id })).data)).toBe(
      "Survives restart",
    );
    expect((await f.read(bot.id)).messages.filter((message) => message.attachments.length)).toHaveLength(1);
  }, 30_000);

  test("download uses worker storage and private redirects cannot reach attachment delivery", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    await f.tool(bot.id, "download_file", { url: "http://download.fixture/note.md" });
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain("text/markdown");
    await f.tool(bot.id, "send_attachment", { path: "note.md", caption: "Downloaded" });
    expect((await f.settled(bot.id)).messages.find((m) => m.text === "Downloaded")?.attachments[0]?.name).toBe(
      "note.md",
    );
    await f.tool(bot.id, "download_file", { url: "http://download.fixture/redirect", filename: "private.txt" });
    expect((await f.settled(bot.id)).messages.at(-1)?.text).toContain("not public");
    await f.tool(bot.id, "send_attachment", { path: "private.txt" });
    expect((await f.settled(bot.id)).messages.filter((m) => m.attachments.length)).toHaveLength(1);
  });

  test("attachment approval denial and execution-time Files revocation prevent delivery", async () => {
    const bot = await f.add(Provider.CODEX, f.workerId, "full_auto");
    await f.tool(bot.id, "write_file", { path: "note.txt", text: "Private note" });
    await f.settled(bot.id);
    await f.gw.api.updateBot({ botId: bot.id, configuration: { ...bot.configuration!, approvalPolicy: "always" } });
    await f.tool(bot.id, "send_attachment", { path: "note.txt" });

    const waiting = await eventually(
      () => f.read(bot.id),
      (c) => c.approvals.some((a) => a.status === "pending"),
    );

    await f.gw.api.answerBotApproval({
      approvalId: waiting.approvals.find((a) => a.status === "pending")!.id,
      approve: false,
    });
    expect((await f.settled(bot.id)).messages.some((m) => m.attachments.length)).toBe(false);
    await f.tool(bot.id, "send_attachment", { path: "note.txt" });

    const again = await eventually(
      () => f.read(bot.id),
      (c) => c.approvals.some((a) => a.status === "pending"),
    );

    await f.gw.api.updateBot({
      botId: bot.id,
      configuration: { ...bot.configuration!, approvalPolicy: "always", files: false },
    });
    await f.gw.api.answerBotApproval({
      approvalId: again.approvals.find((a) => a.status === "pending")!.id,
      approve: true,
    });
    expect((await f.settled(bot.id)).messages.some((m) => m.attachments.length)).toBe(false);
  }, 30_000);
});

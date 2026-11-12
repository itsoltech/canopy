import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { bots, CommandSchema, MentionKind, Provider } from "@canopy/contracts";
import { BotComposerSync } from "@canopy/domain/bot-draft";
import { dockerAvailable } from "@canopy/db/testing";
import { AttachmentStore, GatewayStore } from "@canopy/gateway/store";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import sharp from "sharp";
import { failure } from "./support/gateway.ts";
import { harnessBots, type HarnessBots } from "./support/harness-bots.ts";

describe.skipIf(!dockerAvailable)("bot composer drafts and images", () => {
  let f: HarnessBots;
  const limits = { maxFileBytes: 200_000, maxMessageBytes: 300_000, maxFiles: 3 };
  let png: Uint8Array;

  beforeAll(async () => {
    png = new Uint8Array(
      await sharp({ create: { width: 24, height: 16, channels: 3, background: "#12abcd" } })
        .png()
        .toBuffer(),
    );
    f = await harnessBots({ attachmentLimits: limits });
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  const upload = async (botId: string) =>
    (await f.gw.api.uploadAttachment({ botId, name: "photo.png", data: png })).attachment!;

  const composer = (botId: string) =>
    new BotComposerSync(
      botId,
      {
        load: () => f.gw.api.getBotDraft({ botId }),
        save: (draft, expectedRevision) => f.gw.api.saveBotDraft({ botId, draft, expectedRevision }),
      },
      () => crypto.randomUUID(),
    );

  const deliver = (botId: string, draft: bots.BotComposerDraft) =>
    f.gw.api.sendBotMessage({
      botId,
      text: draft.text,
      mentions: draft.mentions,
      quotes: draft.quotes,
      attachmentIds: draft.attachments.map((a) => a.id),
      clientRequestId: draft.clientRequestId,
      draftRevision: draft.revision,
    });

  test("structured drafts survive a gateway restart and stale saves cannot replace them", async () => {
    const bot = await f.add(Provider.CODEX);
    const image = await upload(bot.id);
    const text = "Please check [photo.png]";

    const saved = await f.gw.api.saveBotDraft({
      botId: bot.id,
      expectedRevision: 0n,
      draft: {
        text,
        clientRequestId: "durable-draft",
        attachments: [image],
        mentions: [{ kind: MentionKind.ATTACHMENT, name: image.id, label: image.name, start: 13, end: text.length }],
        quotes: [
          {
            text: "Original message",
            sourceKind: "agent_message",
            sourceItemId: crypto.randomUUID(),
            sourceThreadId: bot.id,
            comment: "Keep the source",
          },
        ],
      },
    });

    await f.restartGateway();
    await f.reconnect();
    f.gw.core.bots.start();
    expect(await f.gw.api.getBotDraft({ botId: bot.id })).toEqual(saved);
    expect(await f.gw.api.saveBotDraft({ botId: bot.id, expectedRevision: 0n, draft: saved })).toEqual(saved);
    expect(
      await failure(f.gw.api.saveBotDraft({ botId: bot.id, expectedRevision: 0n, draft: { text: "stale" } })),
    ).toContain("changed on another device");
    expect(await f.gw.api.getBotDraft({ botId: bot.id })).toEqual(saved);
  }, 30_000);

  test("failed sends preserve drafts; accepted sends clear only their revision and retry once", async () => {
    const bot = await f.add(Provider.CODEX);
    const image = await upload(bot.id);

    const saved = await f.gw.api.saveBotDraft({
      botId: bot.id,
      draft: { text: "Check it", attachments: [image], clientRequestId: "send-once" },
    });

    expect(
      await failure(
        f.gw.api.sendBotMessage({
          botId: bot.id,
          clientRequestId: "bad",
          attachmentIds: [crypto.randomUUID()],
          draftRevision: saved.revision,
        }),
      ),
    ).toContain("unavailable");
    expect(await f.gw.api.getBotDraft({ botId: bot.id })).toEqual(saved);

    const request = {
      botId: bot.id,
      text: saved.text,
      clientRequestId: saved.clientRequestId,
      attachmentIds: [image.id],
      draftRevision: saved.revision,
    };

    const accepted = await f.gw.api.sendBotMessage(request);
    expect(await f.gw.api.sendBotMessage(request)).toEqual(accepted);
    const cleared = await f.gw.api.getBotDraft({ botId: bot.id });
    expect([cleared.text, cleared.attachments]).toEqual(["", []]);
    await f.settled(bot.id);
    expect((await f.read(bot.id)).messages.filter((m) => m.senderId === "user")).toHaveLength(1);

    const newer = await f.gw.api.saveBotDraft({
      botId: bot.id,
      expectedRevision: cleared.revision,
      draft: { text: "Newer device edit" },
    });

    await f.gw.api.sendBotMessage({
      botId: bot.id,
      text: "Old snapshot",
      clientRequestId: "older-send",
      draftRevision: cleared.revision,
    });
    expect(await f.gw.api.getBotDraft({ botId: bot.id })).toEqual(newer);
    await f.settled(bot.id);
  }, 20_000);

  test("a draft read started before send cannot restore acknowledged text, quotes or files", async () => {
    const bot = await f.add(Provider.CODEX);
    const image = await upload(bot.id);
    const release = Promise.withResolvers<void>();
    const captured = Promise.withResolvers<void>();
    let hold = false;

    const sync = new BotComposerSync(
      bot.id,
      {
        load: async () => {
          const draft = await f.gw.api.getBotDraft({ botId: bot.id });

          if (hold) {
            hold = false;
            captured.resolve();
            await release.promise;
          }

          return draft;
        },
        save: (draft, expectedRevision) => f.gw.api.saveBotDraft({ botId: bot.id, draft, expectedRevision }),
      },
      () => crypto.randomUUID(),
    );

    await sync.load();
    sync.update(
      create(bots.BotComposerDraftSchema, {
        text: "Check this image",
        attachments: [image],
        quotes: [{ text: "Earlier request", sourceKind: "agent_message" }],
      }),
    );
    const outgoing = await sync.outgoing();
    hold = true;
    const stale = sync.load();
    await captured.promise;

    try {
      await deliver(bot.id, outgoing);
      const sent = sync.sent(outgoing);
      release.resolve();
      await Promise.all([stale, sent]);
      expect([sync.value.text, sync.value.quotes, sync.value.attachments]).toEqual(["", [], []]);
      expect(sync.value).toEqual(await f.gw.api.getBotDraft({ botId: bot.id }));
      sync.update(create(bots.BotComposerDraftSchema, { text: "Text only after acknowledgement" }));
      const next = await sync.outgoing();
      expect(next.attachments).toEqual([]);
      await deliver(bot.id, next);
      await sync.sent(next);
      const view = await f.settled(bot.id);
      expect(view.messages.filter((m) => m.senderId === "user").map((m) => m.attachments.length)).toEqual([1, 0]);
    } finally {
      release.resolve();
      await stale;
    }
  }, 20_000);

  test("drafts, uploads, binding and worker blob reads are owner-scoped and limited", async () => {
    const bot = await f.add(Provider.CODEX);

    const other = await f.gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("bot-composer@localhost", "Other")),
    );

    await expect(f.gw.runtime.runPromise(BotStore.use((s) => s.draft(other, bot.id)))).rejects.toThrow();
    await expect(
      f.gw.runtime.runPromise(
        BotStore.use((s) =>
          s.saveDraft(other, create(bots.SaveBotDraftRequestSchema, { botId: bot.id, draft: { text: "foreign" } })),
        ),
      ),
    ).rejects.toThrow();
    expect(
      await failure(f.gw.api.uploadAttachment({ botId: crypto.randomUUID(), name: "photo.png", data: png })),
    ).toContain("not found");
    expect(
      await failure(
        f.gw.api.uploadAttachment({ botId: bot.id, name: "program.exe", data: new Uint8Array([0x4d, 0x5a, 0]) }),
      ),
    ).toContain("program");
    const huge = new Uint8Array(limits.maxFileBytes + 1);
    huge.set(png);
    expect(await failure(f.gw.api.uploadAttachment({ botId: bot.id, name: "huge.png", data: huge }))).toContain(
      "up to",
    );
    const images = await Promise.all([0, 1, 2, 3].map(() => upload(bot.id)));

    const send = (ids: string[]) =>
      f.gw.api.sendBotMessage({
        botId: bot.id,
        text: "Check",
        attachmentIds: ids,
        clientRequestId: crypto.randomUUID(),
      });

    expect(await failure(send(images.map((a) => a.id)))).toContain("up to 3");
    await f.query("UPDATE attachments SET owner_user_id=$1 WHERE id=$2", [other, images[0]!.id]);
    expect(await failure(send([images[0]!.id]))).toContain("unavailable");
    await expect(
      f.gw.runtime.runPromise(
        AttachmentStore.use((s) => s.workerBotBlob(f.workerId, bot.id, crypto.randomUUID(), images[1]!.sha256)),
      ),
    ).rejects.toThrow();
    await f.query("UPDATE attachments SET size_bytes=250000 WHERE id=$1", [images[1]!.id]);
    expect(await failure(send([images[1]!.id]))).toContain("size limit");
    await f.query("UPDATE attachments SET size_bytes=180000 WHERE id=ANY($1::uuid[])", [
      `{${images[1]!.id},${images[2]!.id}}`,
    ]);
    expect(await failure(send([images[1]!.id, images[2]!.id]))).toContain("message size limit");
  }, 20_000);

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} receives two images once, then only each new message's files`, async () => {
      const bot = await f.add(provider);
      const images = await Promise.all([upload(bot.id), upload(bot.id)]);
      const image = images[0]!;
      const sync = composer(bot.id);
      await sync.load();
      sync.update(
        create(bots.BotComposerDraftSchema, {
          text: "Describe these two images",
          attachments: images,
        }),
      );
      const outgoing = await sync.outgoing();
      const before = f.inputs().length;
      await deliver(bot.id, outgoing);
      await sync.sent(outgoing);
      expect(sync.value.attachments).toEqual([]);
      const conversation = await f.settled(bot.id);
      expect(conversation.messages.at(-1)?.text).toBe("FIXTURE_OK");
      expect(conversation.messages[0]?.attachments[0]).toMatchObject({
        id: image.id,
        kind: "image",
        hasThumbnail: true,
      });
      const parts = f.inputs().slice(before).at(-1)!.parts;
      expect(parts.filter((p) => p.type === "image")).toHaveLength(2);
      expect(parts.find((p) => p.type === "text")?.text).toContain("Canopy attached files");
      expect(parts.find((p) => p.type === "text")?.text).toContain(image.name);
      expect((await f.gw.api.getAttachment({ attachmentId: image.id, thumbnail: true })).mimeType).toBe("image/webp");

      const firstSession = f
        .records()
        .filter((r) => r.event === "turn")
        .at(-1)!.session;

      for (let followup = 0; followup < 3; followup += 1) {
        if (followup === 1) {
          // Changing instructions rebuilds the official harness session for every provider.
          await f.gw.api.updateBot({
            botId: bot.id,
            configuration: {
              ...bot.configuration!,
              instructions: "Continue with the current message's attachments only.",
            },
          });
        }

        const text = `Text-only follow-up ${followup}`;
        sync.update(create(bots.BotComposerDraftSchema, { text }));
        const next = await sync.outgoing();
        expect(next.attachments).toEqual([]);
        await deliver(bot.id, next);
        await sync.sent(next);
        expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
        const received = f.inputs().at(-1)!.parts;
        expect(received.filter((p) => p.type === "image")).toHaveLength(0);
        const prompt = received.find((p) => p.type === "text")!.text!;
        const current = prompt.split("\n\nCurrent input:\n").at(-1)!;
        expect(current).toContain(text);
        expect(current).not.toContain("Canopy attached files");

        for (const file of images) expect(current).not.toContain(file.id);

        const session = f
          .records()
          .filter((r) => r.event === "turn")
          .at(-1)!.session;

        if (followup === 0) expect(session).toBe(firstSession);

        if (followup === 1) {
          expect(session).not.toBe(firstSession);
          expect(prompt).toContain(`Files from an earlier message [${conversation.messages[0]!.id}] at `);
          expect(prompt).toContain("references only; not attached to the current input");

          for (const file of images) expect(prompt).toContain(file.id);
        }
      }

      const users = (await f.read(bot.id)).messages.filter((m) => m.senderId === "user");
      expect(users.map((m) => m.attachments.length)).toEqual([2, 0, 0, 0]);
      expect(
        f
          .inputs()
          .slice(before)
          .map((r) => r.parts.filter((p) => p.type === "image").length),
      ).toEqual([2, 0, 0, 0]);

      const fresh = await upload(bot.id);
      sync.update(create(bots.BotComposerDraftSchema, { text: "One new image", attachments: [fresh] }));
      const next = await sync.outgoing();
      await deliver(bot.id, next);
      await sync.sent(next);
      await f.settled(bot.id);
      expect(
        f
          .inputs()
          .at(-1)!
          .parts.filter((p) => p.type === "image"),
      ).toHaveLength(1);

      const commands = await f.query<{ payload: Uint8Array }>(
        "SELECT c.payload FROM worker_commands c JOIN bot_harness_turns h ON h.command_id=c.id JOIN bot_turns t ON t.id=h.turn_id WHERE h.bot_id=$1 ORDER BY t.created_at,t.id",
        [bot.id],
      );

      const inputs = commands.map((row) => {
        const command = fromBinary(CommandSchema, row.payload);

        if (command.kind.case !== "runBotTurn") throw new Error("Expected a bot turn");

        return command.kind.value;
      });

      expect(inputs.map((input) => input.attachments.map((a) => a.attachmentId))).toEqual([
        images.map((a) => a.id),
        [],
        [],
        [],
        [fresh.id],
      ]);
      expect(inputs.every((input) => input.historyAttachments.length === 0)).toBe(true);

      await expect(
        f.gw.runtime.runPromise(
          AttachmentStore.use((s) => s.workerBotBlob(f.workerId, bot.id, crypto.randomUUID(), image.sha256)),
        ),
      ).rejects.toThrow();
    }, 30_000);
  }

  test("a rebuilt harness keeps all historical file references without replaying their bytes", async () => {
    const bot = await f.add(Provider.CODEX);

    for (let batch = 0; batch < 4; batch += 1) {
      const images = await Promise.all([upload(bot.id), upload(bot.id), upload(bot.id)]);
      await f.gw.api.sendBotMessage({
        botId: bot.id,
        text: `Batch ${batch}`,
        attachmentIds: images.map((a) => a.id),
        clientRequestId: crypto.randomUUID(),
      });
      await f.settled(bot.id);
    }

    const turn = f
      .records()
      .filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))
      .at(-1)!;

    rmSync(join(turn.home, "sessions", `${turn.session}.json`));
    await f.send(bot.id, "Recall the images");
    await f.settled(bot.id);
    const parts = f.inputs().at(-1)!.parts;
    expect(parts.filter((p) => p.type === "image")).toHaveLength(0);
    const prompt = parts.find((p) => p.type === "text")?.text ?? "";
    expect(prompt).toContain("references only; not attached to the current input");

    for (const message of (await f.read(bot.id)).messages)
      for (const attachment of message.attachments) expect(prompt).toContain(attachment.id);
  }, 30_000);
});

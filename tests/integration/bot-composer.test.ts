import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { bots, MentionKind, Provider } from "@canopy/contracts";
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

  test("drafts, uploads, binding and worker blob reads are owner-scoped and image-limited", async () => {
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
        f.gw.api.uploadAttachment({ botId: bot.id, name: "fake.png", data: new TextEncoder().encode("not an image") }),
      ),
    ).toContain("PNG");
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
    test(`${Provider[provider]} receives native image input through the real worker link`, async () => {
      const bot = await f.add(provider);
      const image = await upload(bot.id);
      const before = f.inputs().length;
      await f.gw.api.sendBotMessage({
        botId: bot.id,
        text: "Describe this image",
        attachmentIds: [image.id],
        clientRequestId: crypto.randomUUID(),
      });
      const conversation = await f.settled(bot.id);
      expect(conversation.messages.at(-1)?.text).toBe("FIXTURE_OK");
      expect(conversation.messages[0]?.attachments[0]).toMatchObject({
        id: image.id,
        kind: "image",
        hasThumbnail: true,
      });
      const parts = f.inputs().slice(before).at(-1)!.parts;
      expect(parts.some((p) => p.type === "image")).toBe(true);
      expect(parts.find((p) => p.type === "text")?.text).toContain("Canopy attached images");
      expect(parts.find((p) => p.type === "text")?.text).toContain(image.name);
      expect((await f.gw.api.getAttachment({ attachmentId: image.id, thumbnail: true })).mimeType).toBe("image/webp");

      if (provider === Provider.CODEX) {
        const turn = f
          .records()
          .filter((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`))
          .at(-1)!;

        rmSync(join(turn.home, "sessions", `${turn.session}.json`));
        await f.send(bot.id, "Remember that image");
        expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
        expect(
          f
            .inputs()
            .at(-1)
            ?.parts.filter((p) => p.type === "image"),
        ).toHaveLength(1);
        await f.send(bot.id, "Continue");
        await f.settled(bot.id);
        expect(
          f
            .inputs()
            .at(-1)
            ?.parts.filter((p) => p.type === "image"),
        ).toHaveLength(0);
      }

      await expect(
        f.gw.runtime.runPromise(
          AttachmentStore.use((s) => s.workerBotBlob(f.workerId, bot.id, crypto.randomUUID(), image.sha256)),
        ),
      ).rejects.toThrow();
    }, 20_000);
  }

  test("a rebuilt harness bounds historical images and explains omitted images", async () => {
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
    expect(parts.filter((p) => p.type === "image")).toHaveLength(9);
    expect(parts.find((p) => p.type === "text")?.text).toContain("omitted earlier images");
  }, 30_000);
});

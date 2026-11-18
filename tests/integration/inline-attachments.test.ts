/**
 * Files placed in the text, through a real WorkerHost to each harness's scripted CLI (docs/protocol.md, "Załączniki w
 * tekście"): Claude content blocks, Codex input items and Grok ACP prompt blocks carry text and images in the user's
 * order; a placed non-image file stays its numbered marker, the note names its path under the same number.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJson, toJsonString } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { citationPlaceholder } from "@canopy/domain";
import sharp from "sharp";
import { parseThreadForm } from "../../apps/web/src/lib/features/threads/server/thread-form.ts";
import { eventually, watchUntil } from "./support/gateway.ts";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";

const badge = (text: string, id: string, name: string) => {
  const start = text.indexOf(`[${name}]`);

  return create(MentionSchema, {
    kind: MentionKind.ATTACHMENT,
    name: id,
    label: name,
    start,
    end: start + name.length + 2,
  });
};

describe.skipIf(!dockerAvailable)("files placed in the text reach each harness in the user's order", () => {
  let f: InstanceFixture;
  let png: Uint8Array;

  beforeAll(async () => {
    f = await startInstanceFixture();
    png = new Uint8Array(
      await sharp({ create: { width: 16, height: 8, channels: 3, background: "#3366cc" } })
        .png()
        .toBuffer(),
    );
  }, 60_000);

  afterAll(async () => {
    await f?.close();
  });

  test("a multiline new thread form keeps inline attachment and quote positions through multipart", async () => {
    await f.save(Provider.CODEX, "codex-multipart");
    const overview = await f.gw.api.getOverview({});

    const workspace = overview.projects
      .flatMap((project) => project.workspaces)
      .find((w) => w.workerId === f.workerId)!;

    const image = (await f.gw.api.uploadAttachment({ name: "inline.png", data: png })).attachment!;
    const quoteText = "Previous answer";
    const citation = citationPlaceholder(quoteText);
    const message = `Look at this 🖼️\n[inline.png]\n> Context from the previous discussion\n${citation}`;
    const mention = badge(message, image.id, image.name);

    const quote = create(ui.QuoteSchema, {
      text: quoteText,
      sourceKind: "text_selection",
      start: message.indexOf(citation),
      end: message.length,
    });

    // A browser writes CRLF in multipart text fields. The saved form carries the editor's LF offsets in JSON.
    const form = new FormData();
    form.set("message", message.replaceAll("\n", "\r\n"));
    form.set("mentions", JSON.stringify([toJson(MentionSchema, mention)]));
    const content = create(ui.ComposerDraftContentSchema, { text: message, mentions: [mention], quotes: [quote] });
    form.set("composerContent", toJsonString(ui.ComposerDraftContentSchema, content));
    form.set("workspaceId", workspace.id);
    form.set("provider", "CODEX");
    form.set("attachmentId", image.id);
    const received = await new Response(form).formData();
    const request = parseThreadForm(received, "thread", { projectId: workspace.projectId });

    if ("status" in request) throw new Error(request.data.error);
    const events = await Array.fromAsync(f.gw.api.createThreadWithProgress(request));
    expect(events.at(-1)).toMatchObject({ step: "start_thread", status: "completed" });
    const threadId = events.at(-1)!.thread!.id;
    const [update] = await watchUntil(f.gw.api, threadId, (rows) => rows[0]?.change.case === "snapshot");
    const turn = update?.change.case === "snapshot" ? update.change.value.turns[0] : undefined;

    expect(turn?.messageText).toBe(message);
    expect(turn?.mentions[0]).toMatchObject({ name: image.id, start: mention.start, end: mention.end });
    expect(turn?.quotes[0]).toMatchObject({ text: quote.text, start: quote.start, end: quote.end });
  });

  for (const harness of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    const name = Provider[harness]!.toLowerCase();

    test(`${Provider[harness]}: text, the image after its marker, the file as its marker`, async () => {
      await f.save(harness, `${name}-inline`);
      const thread = await f.thread(harness);

      const notes = (await f.gw.api.uploadAttachment({ name: "plik.txt", data: new TextEncoder().encode("hi") }))
        .attachment!;

      const image = (await f.gw.api.uploadAttachment({ name: "obrazek.png", data: png })).attachment!;
      const message = `hey ${name}, the file: [plik.txt] and the image: [obrazek.png], analyse them`;

      const turn = (
        await f.gw.api.sendMessage({
          threadId: thread.id,
          text: message,
          clientRequestId: crypto.randomUUID(),
          attachmentIds: [image.id, notes.id],
          mentions: [badge(message, notes.id, "plik.txt"), badge(message, image.id, "obrazek.png")],
        })
      ).turn!;

      expect((await f.finished(thread.id, turn.id)).status).toBe("completed");

      const input = await eventually(
        async () => f.inputs().find((r) => r.harness === name && r.parts.some((p) => p.text?.includes(`hey ${name}`))),
        (r) => r !== undefined,
      );

      const parts = input!.parts.filter((p) => p.type === "text" || p.type === "image" || p.type === "localImage");
      const texts = parts.filter((p) => p.type === "text").map((p) => p.text ?? "");
      // The first part: the note (and Grok's instructions) and the text up to the image's marker.
      expect(texts[0]).toContain("Attachment 1: ");
      expect(texts[0]).toContain("/plik.txt (text/plain, 2 B)");
      expect(texts[0]).toEndWith(
        `hey ${name}, the file: [Attachment 1: plik.txt] and the image: [Attachment 2: obrazek.png]`,
      );
      // Then the image itself, then the rest of the text.
      expect(parts[1]!.type).toBe(harness === Provider.CODEX ? "localImage" : "image");
      expect(parts[1]!.image).toBe(
        harness === Provider.CODEX ? "obrazek.png" : harness === Provider.CLAUDE ? "image/jpeg" : "image/png",
      );
      expect(parts[2]).toMatchObject({ type: "text", text: ", analyse them" });
      expect(parts).toHaveLength(3);
    });
  }

  test("a message without positions reaches the harness as it always did", async () => {
    await f.save(Provider.CODEX, "codex-plain");
    const thread = await f.thread(Provider.CODEX);
    const image = (await f.gw.api.uploadAttachment({ name: "plain.png", data: png })).attachment!;

    const turn = (
      await f.gw.api.sendMessage({
        threadId: thread.id,
        text: "plain message",
        clientRequestId: crypto.randomUUID(),
        attachmentIds: [image.id],
      })
    ).turn!;

    expect((await f.finished(thread.id, turn.id)).status).toBe("completed");

    const input = await eventually(
      async () => f.inputs().find((r) => r.parts.some((p) => p.text?.endsWith("plain message"))),
      (r) => r !== undefined,
    );

    expect(input!.parts.map((p) => p.type)).toEqual(["text"]);
    expect(input!.parts[0]!.text).not.toContain("Attachment 1");
    expect(input!.parts[0]!.text).toContain("/plain.png (image/png");
  });
});

/**
 * Files placed in the text, through a real WorkerHost to each harness's scripted CLI (docs/protocol.md, "Załączniki w
 * tekście"): Claude content blocks, Codex input items and Grok ACP prompt blocks carry text and images in the user's
 * order; a placed non-image file stays its numbered marker, the note names its path under the same number.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import sharp from "sharp";
import { eventually } from "./support/gateway.ts";
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

import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { InputAttachmentSchema, RunBotTurnSchema } from "@canopy/contracts";
import { attachmentPath } from "@canopy/domain";
import { tempDirs } from "@canopy/testing";
import { AttachmentFiles } from "../attachments/files.ts";
import { botImages } from "./images.ts";

const temp = tempDirs();

test("an older gateway's historical files are neither fetched nor added to a bot input", async () => {
  const files = new AttachmentFiles(temp("canopy-bot-current-files-"));
  const botId = crypto.randomUUID();
  const data = new TextEncoder().encode("CURRENT_FILE_CONTENT");
  const attachment = (name: string, bytes: Uint8Array) => {
    const attachmentId = crypto.randomUUID();

    return create(InputAttachmentSchema, {
      attachmentId,
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: BigInt(bytes.length),
      kind: "file",
      mimeType: "text/plain",
      path: attachmentPath(files.root, process.platform, botId, attachmentId, name),
    });
  };

  const current = attachment("current.txt", data);
  const earlier = attachment("earlier.txt", new TextEncoder().encode("EARLIER_FILE_CONTENT"));
  const input = create(RunBotTurnSchema, {
    botId,
    turnId: crypto.randomUUID(),
    input: "Read my current file",
    historyJson: "[]",
    attachments: [current],
    historyAttachments: [earlier],
  });
  const fetch = async (sha: string) => {
    if (sha !== current.sha256) throw new Error("Historical content must not be fetched");

    return data;
  };

  for (const resumed of [false, true]) {
    const content = await botImages(input, resumed, files, fetch);
    expect(content.text).toContain("CURRENT_FILE_CONTENT");
    expect(content.text).not.toContain("EARLIER_FILE_CONTENT");
    expect(content.text).not.toContain(earlier.attachmentId);
    expect(content.images).toEqual([]);
    expect(content.documents).toEqual([]);
    expect(existsSync(earlier.path)).toBe(false);
  }
});

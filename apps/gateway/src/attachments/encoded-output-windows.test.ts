import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import sharp from "sharp";
import { windowsEncodedOutput } from "./encoded-output-windows.ts";
import { AttachmentRejected } from "./rejected.ts";

const png = () => sharp({ create: { width: 32, height: 24, channels: 3, background: "#4488cc" } }).png();
const rejected = () => new AttachmentRejected("The encoded image exceeds its byte limit.");

describe.skipIf(process.platform !== "win32")("Windows image reply encoding", () => {
  test("encodes an ordinary screenshot through the Windows file target", async () => {
    const path = join(tempDir("canopy-image-output-"), "zrzut-écran");
    const { data, info } = await windowsEncodedOutput(png(), path, 4096, rejected);

    expect(info).toMatchObject({ format: "png", width: 32, height: 24 });
    expect(await sharp(data).metadata()).toMatchObject({ format: "png", width: 32, height: 24 });
  });

  test("keeps the encoder file within its byte limit when rejecting an oversized result", async () => {
    const path = join(tempDir("canopy-image-output-"), "encoded");
    const maxBytes = 16;

    expect((await png().toBuffer()).byteLength).toBeGreaterThan(maxBytes);
    await expect(windowsEncodedOutput(png(), path, maxBytes, rejected)).rejects.toBeInstanceOf(AttachmentRejected);
    expect(statSync(path, { throwIfNoEntry: false })?.size ?? 0).toBeLessThanOrEqual(maxBytes);
  });
});

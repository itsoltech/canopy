import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sharp } from "sharp";
import { AttachmentRejected } from "./rejected.ts";
import { unixEncodedOutput } from "./encoded-output-unix.ts";
import { windowsEncodedOutput } from "./encoded-output-windows.ts";

/** Sharp's stream API buffers the entire native result too. Use the encoder's file target with an OS-bound sink. */
export async function boundedImageOutput(image: Sharp, maxBytes: number, name: string) {
  const directory = await mkdtemp(join(tmpdir(), "canopy-image-encode-"));
  const path = join(directory, "encoded");

  const rejected = () =>
    new AttachmentRejected(`${name} exceeds the image limit after processing. Choose a smaller image.`);

  try {
    return process.platform === "win32"
      ? await windowsEncodedOutput(image, path, maxBytes, rejected)
      : await unixEncodedOutput(image, path, maxBytes, rejected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

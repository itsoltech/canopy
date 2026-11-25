import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jpegFrame, readPreviewImage } from "./frames.ts";
import type { PreviewRuntime } from "./runtime.ts";
import { screenshotDirectory } from "./screenshot-storage.ts";

const size = z.number().positive().max(8192).optional();

const screenshot = z.object({
  width: size,
  height: size,
  logicalWidth: size,
  logicalHeight: size,
  scale_factor: z.number().positive().max(16).default(1),
});

/** CLI capture shared by the manual viewers and the portable exact-window fallback. */
export class PreviewCaptureFile {
  #dir = "";

  constructor(readonly runtime: PreviewRuntime) {}

  async take(scopeArgs: readonly string[], window: { width: number; height: number } | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    this.#dir ||= screenshotDirectory(this.runtime.env);
    const path = join(this.#dir, "frame.png");
    rmSync(path, { force: true });

    try {
      const info = screenshot.parse(await this.runtime.command(["screenshot", ...scopeArgs, path], { signal }));
      signal.throwIfAborted();
      const width = window?.width ?? info.logicalWidth ?? (info.width ? info.width / info.scale_factor : 0);
      const height = window?.height ?? info.logicalHeight ?? (info.height ? info.height / info.scale_factor : 0);

      if (!width || !height) throw new Error("The screenshot did not report logical input dimensions");

      const image = await jpegFrame(
        readPreviewImage(path),
        window && {
          windowWidth: window.width,
          windowHeight: window.height,
          scaleFactor: info.scale_factor,
        },
      );

      signal.throwIfAborted();

      return { ...image, viewportWidth: Math.round(width), viewportHeight: Math.round(height) };
    } finally {
      rmSync(path, { force: true });
    }
  }

  close(): void {
    if (this.#dir) rmSync(this.#dir, { recursive: true, force: true });
  }
}

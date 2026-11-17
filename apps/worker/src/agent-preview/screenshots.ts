import { rmSync } from "node:fs";
import { join } from "node:path";
import { AgentTool, type AgentPreviewInput } from "@canopy/contracts";
import { z } from "zod";
import { DesktopCatalog, deviceCatalog } from "./catalog.ts";
import { DesktopInput } from "./desktop-input.ts";
import { DeviceInput } from "./device-input.ts";
import { jpegFrame, readPreviewImage } from "./frames.ts";
import { screenshotDirectory } from "./screenshot-storage.ts";
import type { PreviewBackend, PreviewContext, PreviewUpdate } from "./types.ts";

const screenshot = z.object({
  width: z.number().positive().max(8192).optional(),
  height: z.number().positive().max(8192).optional(),
  logicalWidth: z.number().positive().max(8192).optional(),
  logicalHeight: z.number().positive().max(8192).optional(),
  scale_factor: z.number().positive().max(16).default(1),
});

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });

    if (signal.aborted) finish();
  });
}

class ScreenshotPreview implements PreviewBackend {
  readonly #context: PreviewContext;
  readonly #desktop: DesktopCatalog | undefined;
  readonly #desktopInput: DesktopInput | undefined;
  readonly #deviceInput: DeviceInput | undefined;
  #dir = "";
  #loop: Promise<void> | undefined;
  #closed = false;
  #selected = false;
  #catalogAt = 0;
  #metadata: PreviewUpdate = { mode: "screenshots" };

  constructor(context: PreviewContext) {
    this.#context = context;

    if (context.runtime.scope.tool === AgentTool.DESKTOP) {
      this.#desktop = new DesktopCatalog(context.runtime);
      this.#desktopInput = new DesktopInput(context.runtime, this.#desktop);
    } else this.#deviceInput = new DeviceInput(context.runtime);
  }

  async start(): Promise<void> {
    await this.#catalog();
    this.#context.signal.throwIfAborted();
    this.#loop = this.#captureLoop();
    void this.#loop.catch(() => undefined);
  }

  async #catalog(): Promise<void> {
    if (this.#desktop) {
      this.#metadata = { mode: "screenshots", ...(await this.#desktop.refresh()) };
      this.#selected = this.#desktop.selected;
    } else {
      const { selected, ...metadata } = await deviceCatalog(this.#context.runtime);
      this.#selected = selected;
      this.#metadata = { mode: "screenshots", ...metadata };
    }

    this.#catalogAt = Date.now();
    this.#context.emit({ ...this.#metadata, state: "ready" });
  }

  async #captureLoop(): Promise<void> {
    const { signal, runtime } = this.#context;
    let failures = 0;

    while (!this.#closed && !signal.aborted) {
      try {
        if (Date.now() - this.#catalogAt > 5_000) await this.#catalog();

        if (this.#selected && this.#context.active()) {
          await this.#capture();
          failures = 0;
        }
      } catch (error) {
        if (signal.aborted || this.#closed) break;
        failures++;
        this.#context.emit({
          state: "error",
          mode: "screenshots",
          detail: runtime.redact(error instanceof Error ? error.message : "Preview capture failed"),
        });

        if (failures >= 3) break;
      }

      await delay(500, signal);
    }
  }

  async #capture(): Promise<void> {
    const { runtime, signal } = this.#context;
    this.#dir ||= screenshotDirectory(runtime.env);
    const path = join(this.#dir, "frame.png");
    rmSync(path, { force: true });

    const args = this.#desktop
      ? ["screenshot", ...this.#desktop.scopeArgs(), path]
      : ["screenshot", "--no-stabilize", "--", path];

    let info: z.infer<typeof screenshot>;
    let source: Uint8Array;

    try {
      info = screenshot.parse(await runtime.command(args));
      source = readPreviewImage(path);
    } finally {
      rmSync(path, { force: true });
    }

    const image = await jpegFrame(source);
    signal.throwIfAborted();
    const size = this.#desktop?.logicalSize();
    const width = size?.width ?? info.logicalWidth ?? (info.width ? info.width / info.scale_factor : 0);
    const height = size?.height ?? info.logicalHeight ?? (info.height ? info.height / info.scale_factor : 0);

    if (!width || !height) throw new Error("The screenshot did not report logical input dimensions");

    if (this.#deviceInput) {
      this.#deviceInput.width = width;
      this.#deviceInput.height = height;
    }

    this.#context.emit({
      ...this.#metadata,
      ...image,
      state: "frame",
      viewportWidth: Math.round(width),
      viewportHeight: Math.round(height),
    });
  }

  async input(inputs: readonly AgentPreviewInput[], owner: string): Promise<void> {
    if (!this.#selected) throw new Error("Select a preview target before sending input");

    for (const input of inputs) {
      this.#context.signal.throwIfAborted();

      if (this.#desktopInput) await this.#desktopInput.input(input, owner);
      else await this.#deviceInput?.input(input, owner);
    }
  }

  async release(owner: string): Promise<void> {
    this.#desktopInput?.release(owner);
    this.#deviceInput?.release(owner);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#loop?.catch(() => undefined);

    if (this.#dir) rmSync(this.#dir, { recursive: true, force: true });
  }
}

export const screenshotPreview = (context: PreviewContext): PreviewBackend => new ScreenshotPreview(context);

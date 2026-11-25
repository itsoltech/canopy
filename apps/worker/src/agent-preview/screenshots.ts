import { create } from "@bufbuild/protobuf";
import { AgentPreviewCursorSchema, AgentTool, type AgentPreviewInput } from "@canopy/contracts";
import { DesktopCatalog, deviceCatalog } from "./catalog.ts";
import { DesktopInput } from "./desktop-input.ts";
import { DeviceInput } from "./device-input.ts";
import { PreviewCaptureFile } from "./capture-file.ts";
import type { PreviewBackend, PreviewContext, PreviewUpdate } from "./types.ts";

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
  readonly #file: PreviewCaptureFile;
  #loop: Promise<void> | undefined;
  #closed = false;
  #selected = false;
  #catalogAt = 0;
  #metadata: PreviewUpdate = { mode: "screenshots" };

  constructor(context: PreviewContext) {
    this.#context = context;
    this.#file = new PreviewCaptureFile(context.runtime);

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

    this.#context.emit({ ...this.#metadata, state: "ready" });
    this.#catalogAt = Date.now();
  }

  async #captureLoop(): Promise<void> {
    const { signal, runtime } = this.#context;
    let failures = 0;

    while (!this.#closed && !signal.aborted) {
      try {
        if (
          Date.now() - this.#catalogAt > 5_000 ||
          this.#desktop?.cursorChanged ||
          (this.#desktop && this.#desktop.targetId !== this.#metadata.targetId)
        )
          await this.#catalog();

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
    const { signal } = this.#context;
    const metadata = this.#metadata;
    const sample = this.#desktop?.cursor();
    const args = this.#desktop?.scopeArgs() ?? ["--no-stabilize", "--"];
    const { windowAligned, ...image } = await this.#file.take(args, this.#desktop?.logicalSize(), signal);
    const cursor = windowAligned && sample && (await this.#desktop?.frameCursor(sample.actionId));
    signal.throwIfAborted();

    if (this.#desktop && metadata.targetId !== this.#desktop.targetId) return;

    if (this.#deviceInput) {
      this.#deviceInput.width = image.viewportWidth;
      this.#deviceInput.height = image.viewportHeight;
    }

    this.#context.emit({
      ...metadata,
      ...image,
      ...(cursor && {
        cursor: create(AgentPreviewCursorSchema, {
          actionId: cursor.actionId,
          x: cursor.x,
          y: cursor.y,
          click: cursor.click,
        }),
      }),
      state: "frame",
    });
  }

  async input(inputs: readonly AgentPreviewInput[], owner: string): Promise<void> {
    if (!this.#selected) throw new Error("Select a preview target before sending input");

    if (this.#desktopInput) await this.#context.runtime.prepareDesktopInput();

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

    this.#file.close();
  }
}

export const screenshotPreview = (context: PreviewContext): PreviewBackend => new ScreenshotPreview(context);

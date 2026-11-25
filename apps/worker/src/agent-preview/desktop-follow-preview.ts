import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewCursorSchema } from "@canopy/contracts";
import { sameDesktopWindow, type DesktopTarget } from "../agent-tools/desktop-window.ts";
import { PreviewCaptureFile } from "./capture-file.ts";
import { lookupDesktopTarget } from "./catalog.ts";
import { jpegFrame } from "./frames.ts";
import { openMacWindowCapture, type MacWindowCapture } from "./mac-window-capture.ts";
import type { PreviewRuntime } from "./runtime.ts";
import { MAX_FRAME_BYTES, type PreviewBackend, type PreviewContext, type PreviewUpdate } from "./types.ts";

type Observation = NonNullable<ReturnType<PreviewRuntime["desktopObservation"]>>;

interface FollowContext extends PreviewContext {
  waitForCapacity(signal: AbortSignal, captureMs?: number): Promise<void>;
}

const waiting: PreviewUpdate = { state: "ready", mode: "screenshots", title: "", targetId: "", targets: [] };

function untilSourceChanges(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function selection(target: DesktopTarget | undefined, title: string) {
  const id = target?.identity.id ?? "";
  const caption = title.replaceAll(/\p{Cc}/gu, " ").slice(0, 1024);

  return {
    title: caption,
    targetId: id,
    targets: target ? [{ id, label: caption.slice(0, 400), app: target.app, windowId: id, active: true }] : [],
  };
}

class DesktopFollowPreview implements PreviewBackend {
  readonly #context: FollowContext;
  readonly #file: PreviewCaptureFile;
  #target: DesktopTarget | undefined;
  #observation: Observation | undefined;
  #source = new AbortController();
  #window = new AbortController();
  #native: Promise<MacWindowCapture | undefined> | undefined;
  #stopping = Promise.resolve();
  #publishing: Promise<void> | undefined;
  #loop: Promise<void> | undefined;
  #displayed: "live" | "observation" | undefined;
  #closed = false;

  constructor(context: FollowContext) {
    this.#context = context;
    this.#file = new PreviewCaptureFile(context.runtime);
  }

  async start(): Promise<void> {
    this.#context.emit(waiting);
    this.#context.runtime.watchDesktopTarget(() => this.#sync());
    this.#sync();
    this.#loop = this.#run();
    void this.#loop.catch(() => {});
  }

  #sync(): void {
    const { runtime } = this.#context;
    const target = runtime.desktopTarget();
    const observation = runtime.desktopObservation();

    if (this.#target === target && this.#observation === observation) return;

    this.#clear();
    this.#source.abort();
    this.#source = new AbortController();

    if (this.#target !== target) this.#retireWindow();
    this.#target = target;
    this.#observation = observation;
    // Give an actual model image priority even if a native capture of the same window is still finishing.
    const signal = AbortSignal.any([this.#source.signal, this.#context.signal]);
    this.#publishing = observation ? this.#publishObservation(observation, signal).catch(() => {}) : undefined;
  }

  #retireWindow(): void {
    this.#window.abort();
    this.#window = new AbortController();
    const native = this.#native;
    this.#native = undefined;

    if (native)
      this.#stopping = Promise.all([this.#stopping, native.then((capture) => capture?.close())]).then(() => {});
  }

  #clear(): void {
    if (!this.#displayed) return;
    this.#displayed = undefined;
    this.#context.emit(waiting);
  }

  async #liveUnavailable(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#displayed !== "live") return;
    this.#clear();

    // A temporary capture failure does not invalidate the image already returned by the model's tool.
    if (this.#observation) await this.#publishObservation(this.#observation, signal).catch(() => {});
  }

  async #run(): Promise<void> {
    const { signal: groupSignal } = this.#context;

    while (!this.#closed && !groupSignal.aborted) {
      const signal = AbortSignal.any([this.#source.signal, groupSignal]);
      const target = this.#target;
      const observation = this.#observation;

      try {
        await this.#publishing;
        signal.throwIfAborted();

        if (target && (!observation || observation.target === target)) await this.#capture(target, signal);
        else await untilSourceChanges(signal);
      } catch {
        if (!signal.aborted) {
          await this.#liveUnavailable(signal);
          await delay(250, undefined, { signal }).catch(() => {});
        }
      }
    }
  }

  async #publishObservation(observation: Observation, signal: AbortSignal): Promise<void> {
    const { data, mimeType, width, height } = observation;
    const image = data.byteLength <= MAX_FRAME_BYTES ? { data, mimeType, width, height } : await jpegFrame(data);
    signal.throwIfAborted();
    this.#displayed = "observation";
    this.#context.emit(
      {
        state: "frame",
        mode: "screenshots",
        agentObservation: true,
        ...selection(observation.target, observation.title),
        ...image,
        viewportWidth: width,
        viewportHeight: height,
      },
      () => !signal.aborted && this.#context.runtime.desktopObservation() === observation,
    );
  }

  async #capture(target: DesktopTarget, signal: AbortSignal): Promise<void> {
    const { runtime } = this.#context;
    const stillCurrent = () => !signal.aborted && runtime.desktopTarget() === target;
    const windowSignal = AbortSignal.any([this.#window.signal, this.#context.signal]);
    this.#native ??= openMacWindowCapture(target, windowSignal).catch(() => undefined);
    let native = await this.#native;
    let captureMs = 0;

    while (stillCurrent()) {
      // Begin the next capture after ACK, early enough to finish near the viewer's next presentation time.
      await this.#context.waitForCapacity(signal, captureMs);
      signal.throwIfAborted();
      const started = performance.now();
      const sample = runtime.desktopCursor();
      let frame = await native?.next(windowSignal).catch(() => undefined);
      signal.throwIfAborted();

      if (!frame) {
        if (native) {
          await native.close();
          signal.throwIfAborted();
          native = undefined;
          this.#native = Promise.resolve(undefined);
          await this.#liveUnavailable(signal);
        }

        frame = await this.#portableFrame(target, signal);
      }

      if (!stillCurrent()) return;

      if (!frame) {
        await this.#liveUnavailable(signal);
        await delay(250, undefined, { signal });
        continue;
      }

      captureMs = Math.min(performance.now() - started, 100);
      await this.#context.waitForCapacity(signal);

      if (!stillCurrent()) return;
      const { title: windowTitle, windowAligned, ...image } = frame;

      const title = windowTitle && windowTitle !== target.app ? target.app + " — " + windowTitle : target.app;

      const cursor =
        windowAligned &&
        sample &&
        sameDesktopWindow(sample.identity, target.identity) &&
        sample.width === frame.viewportWidth &&
        sample.height === frame.viewportHeight &&
        runtime.desktopCursor()?.actionId === sample.actionId
          ? create(AgentPreviewCursorSchema, {
              actionId: sample.actionId,
              x: sample.x,
              y: sample.y,
              click: sample.click,
            })
          : undefined;

      this.#displayed = "live";
      this.#context.emit(
        {
          state: "frame",
          mode: "screenshots",
          followingAgent: true,
          mimeType: "image/jpeg",
          ...selection(target, title),
          ...image,
          ...(cursor && { cursor }),
        },
        stillCurrent,
      );
    }
  }

  async #portableFrame(target: DesktopTarget, signal: AbortSignal) {
    const { runtime } = this.#context;
    const before = await lookupDesktopTarget(runtime, target, signal);

    if (!before) return undefined;

    const image = await this.#file.take(
      ["--app=" + target.app, "--window-id", target.identity.id],
      before.bounds ?? undefined,
      signal,
    );

    const after = await lookupDesktopTarget(runtime, target, signal);

    if (!after) return undefined;

    const windowAligned = Boolean(
      image.windowAligned &&
      after.bounds?.width === image.viewportWidth &&
      after.bounds?.height === image.viewportHeight,
    );

    return { ...image, windowAligned, title: after.title };
  }

  async input(): Promise<void> {
    throw new Error("Open the window in interactive Preview to send input");
  }

  async release(): Promise<void> {}

  async close(): Promise<void> {
    this.#closed = true;
    this.#source.abort();
    this.#retireWindow();
    await Promise.all([this.#loop, this.#stopping]);
    this.#file.close();
  }
}

export const followDesktopPreview = (context: FollowContext): PreviewBackend => new DesktopFollowPreview(context);

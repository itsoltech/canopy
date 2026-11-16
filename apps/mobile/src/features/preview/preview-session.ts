import { create } from "@bufbuild/protobuf";
import { base64Encode } from "@bufbuild/protobuf/wire";
import {
  AgentPreviewInputSchema,
  type AgentPreviewEvent,
  type AgentPreviewInput,
  type AgentPreviewTarget,
  type RunAgentTool,
} from "@canopy/contracts";
import type { mobileClient } from "../../api/client";
import { PreviewInputQueue } from "./preview-input";

type PreviewApi = Pick<ReturnType<typeof mobileClient>["api"], "watchAgentPreview" | "sendAgentPreviewInput">;

export interface PreviewSnapshot {
  state: string;
  detail: string;
  notice: string;
  frame?: AgentPreviewEvent | undefined;
  uri?: string | undefined;
  targets: AgentPreviewTarget[];
  targetId: string;
  url: string;
  title: string;
}

export function emptyPreview(state = "idle"): PreviewSnapshot {
  return { state, detail: "", notice: "", targets: [], targetId: "", url: "", title: "" };
}

/** A single foreground subscription; no frame history, automatic reconnect, or input replay. */
export class NativePreviewSession {
  #snapshot = emptyPreview("connecting");
  #controller = new AbortController();
  #previewId = "";
  #queue: PreviewInputQueue;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly api: PreviewApi,
    private readonly threadId: string,
    private readonly scope: RunAgentTool,
    private readonly changed: (snapshot: PreviewSnapshot) => void,
  ) {
    this.#queue = new PreviewInputQueue(
      async (inputs) => {
        if (this.#controller.signal.aborted || !this.#previewId) return;
        await this.api.sendAgentPreviewInput(
          { threadId: this.threadId, previewId: this.#previewId, inputs },
          { signal: this.#controller.signal, timeoutMs: 15_000 },
        );
      },
      (detail) => this.#fail(detail),
    );
  }

  async start(): Promise<void> {
    this.changed(this.#snapshot);

    try {
      for await (const event of this.api.watchAgentPreview(
        { threadId: this.threadId, scope: this.scope, maxFps: 5 },
        { signal: this.#controller.signal, timeoutMs: 0 },
      )) {
        if (this.#controller.signal.aborted) break;
        this.#receive(event);
      }

      if (!this.#controller.signal.aborted) this.#fail();
    } catch {
      if (!this.#controller.signal.aborted) this.#fail();
    }
  }

  input(input: AgentPreviewInput): void {
    if (this.#snapshot.state === "ready" || this.#snapshot.state === "frame") this.#queue.push(input);
  }

  #receive(event: AgentPreviewEvent): void {
    this.#previewId = event.previewId;

    if (event.state === "closed" || event.state === "error") {
      this.#fail(event.detail || "The preview closed. Retry to reconnect.");

      return;
    }

    const snapshot = { ...this.#snapshot, state: event.state, detail: event.detail };

    if (event.state === "ready" || event.state === "frame") {
      if (event.state === "ready" && (!event.targetId || snapshot.targetId !== event.targetId)) {
        snapshot.frame = undefined;
        snapshot.uri = undefined;
      }

      if (event.detail) {
        clearTimeout(this.#noticeTimer);
        snapshot.notice = event.detail;
        this.#noticeTimer = setTimeout(() => {
          this.#snapshot = { ...this.#snapshot, notice: "" };
          this.changed(this.#snapshot);
        }, 4_000);
      }

      snapshot.targets = event.targets;
      snapshot.targetId = event.targetId;
      snapshot.url = event.url;
      snapshot.title = event.title;
    }

    if (event.data.byteLength) {
      if (
        event.data.byteLength > 2 * 1024 * 1024 ||
        !["image/png", "image/jpeg"].includes(event.mimeType) ||
        !event.width ||
        !event.height ||
        event.width > 8192 ||
        event.height > 8192
      ) {
        this.#fail("Could not display the preview image. Retry to reconnect.");

        return;
      }

      snapshot.frame = event;
      snapshot.uri = `data:${event.mimeType};base64,${base64Encode(event.data)}`;
    }

    this.#snapshot = snapshot;
    this.changed(snapshot);
  }

  #release(): void {
    const previewId = this.#previewId;

    if (!previewId) return;
    this.#previewId = "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    void this.api
      .sendAgentPreviewInput(
        { threadId: this.threadId, previewId, inputs: [create(AgentPreviewInputSchema, { kind: "release" })] },
        { signal: controller.signal, timeoutMs: 2_000 },
      )
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }

  #fail(detail = "Check the connection, then retry."): void {
    if (this.#controller.signal.aborted) return;
    this.stop();
    this.#snapshot = { ...this.#snapshot, state: "error", detail };
    this.changed(this.#snapshot);
  }

  stop(): void {
    clearTimeout(this.#noticeTimer);
    this.#queue.dispose();
    this.#release();
    this.#controller.abort();
    this.#snapshot = { ...this.#snapshot, state: "idle", notice: "", frame: undefined, uri: undefined };
  }
}

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  AgentPreviewInputSchema,
  AgentTool,
  ui,
  type AgentPreviewEvent,
  type AgentPreviewInput,
  type AgentPreviewTarget,
  type RunAgentTool,
} from "@canopy/contracts";
import { PreviewInputQueue } from "./preview-input.ts";
import { PreviewImages } from "./preview-images.svelte.ts";
import { acknowledgePreviewFrame, sendAgentPreviewInput, watchAgentPreview } from "./preview-client.ts";

/** One visible preview only. Streams, frames and pending input are discarded together when its scope changes. */
export class PreviewSession {
  state = $state("idle");
  detail = $state("");
  notice = $state("");
  previewId = $state("");
  url = $state("");
  title = $state("");
  mode = $state("");
  targetId = $state("");
  targets = $state<AgentPreviewTarget[]>([]);
  readonly images = new PreviewImages((event) => this.#acknowledge?.(event));
  get frame(): AgentPreviewEvent | undefined {
    return this.images.frame;
  }
  #queue: PreviewInputQueue | undefined;
  #stop: (() => void) | undefined;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  #acknowledge: ((frame: AgentPreviewEvent) => void) | undefined;
  #fail: (() => void) | undefined;

  #setNotice(detail: string): void {
    clearTimeout(this.#noticeTimer);
    this.notice = detail;
    this.#noticeTimer = detail
      ? setTimeout(() => {
          this.notice = "";
          this.#noticeTimer = undefined;
        }, 4_000)
      : undefined;
  }

  input(input: AgentPreviewInput): void {
    if (this.state === "ready" || this.state === "frame") this.#queue?.push(input);
  }

  painted(frame: AgentPreviewEvent): void {
    this.images.painted(frame);
  }

  frameError(frame: AgentPreviewEvent): void {
    if (frame.previewId === this.previewId && frame.frameId === this.frame?.frameId) this.#fail?.();
  }

  #receive(event: AgentPreviewEvent, tool: AgentTool): void {
    this.previewId = event.previewId;
    this.state = event.state;
    this.detail = event.detail;

    if (event.state === "ready" || event.state === "frame") {
      if (
        event.state === "ready" &&
        tool !== AgentTool.BROWSER &&
        (!event.targetId || this.targetId !== event.targetId)
      ) {
        // A target can disappear before its in-flight image decodes. Consume that obsolete
        // frame too, otherwise the worker cannot send the first frame of the replacement target.
        this.images.invalidate();
      }

      if (event.detail) this.#setNotice(event.detail);
      this.url = event.url;
      this.title = event.title;
      this.mode = event.mode;
      this.targets = event.targets;
      this.targetId = event.targetId;
    }

    if (event.state === "frame" && event.data.length) this.images.receive(event);
  }

  connect(
    threadId: string,
    scope: RunAgentTool,
    options: Partial<Pick<ui.WatchAgentPreviewRequest, "maxFps" | "followAgent">> = {},
  ): () => void {
    this.#stop?.();
    const controller = new AbortController();
    this.state = "connecting";
    this.detail = "";
    this.#setNotice("");
    this.previewId = "";
    this.url = "";
    this.title = "";
    this.mode = "";
    this.targetId = "";
    this.targets = [];
    this.images.clear();
    let stopped = false;
    let acknowledged = 0n;

    const request = create(ui.WatchAgentPreviewRequestSchema, {
      threadId,
      scope,
      clientAck: true,
      maxFps: 15,
      ...options,
    });

    const release = () => {
      if (!this.previewId || request.followAgent) return;
      void sendAgentPreviewInput(
        threadId,
        this.previewId,
        [create(AgentPreviewInputSchema, { kind: "release" })],
        AbortSignal.timeout(2_000),
      ).catch(() => {});
    };

    const fail = (detail = "Check the connection, then retry.", state: "error" | "unconfirmed" = "error") => {
      if (stopped) return;
      this.state = state;
      this.detail = detail;
      this.#setNotice("");
      this.images.clear();
      release();
      controller.abort();
      queue.dispose();
    };

    const queue = new PreviewInputQueue(
      async (inputs) => {
        if (stopped || !this.previewId) return;

        try {
          await sendAgentPreviewInput(threadId, this.previewId, inputs, controller.signal);
        } catch {
          if (!controller.signal.aborted) fail();
        }
      },
      () => fail("Input could not keep up. Retry the preview to continue."),
    );

    this.#queue = queue;
    this.#fail = fail;
    this.#acknowledge = (frame) => {
      if (stopped || controller.signal.aborted || frame.previewId !== this.previewId || frame.frameId <= acknowledged)
        return;
      acknowledged = frame.frameId;
      void acknowledgePreviewFrame(threadId, frame, controller.signal).catch(() => {
        if (!controller.signal.aborted) fail();
      });
    };

    void watchAgentPreview(
      request,
      (event) => {
        if (stopped || controller.signal.aborted) return;
        this.#receive(event, scope.tool);

        if (event.state === "closed" || event.state === "error")
          fail(event.detail || "The preview closed. Retry to reconnect.");
      },
      controller.signal,
    )
      .then(() => {
        if (!controller.signal.aborted && !stopped && !["error", "closed"].includes(this.state)) fail();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;

        if (request.followAgent && cause instanceof ConnectError && cause.code === Code.Unimplemented)
          fail("Update the gateway and worker to follow the agent’s view.", "unconfirmed");
        else fail();
      });

    const stop = () => {
      if (stopped) return;
      stopped = true;
      release();
      controller.abort();
      queue.dispose();
      this.images.clear();
      this.previewId = "";
      this.state = "idle";
      this.#setNotice("");

      if (this.#queue === queue) this.#queue = undefined;

      if (this.#stop === stop) this.#stop = undefined;

      this.#acknowledge = undefined;
      this.#fail = undefined;
    };

    this.#stop = stop;

    return stop;
  }
}

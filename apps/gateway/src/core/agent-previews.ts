import { ownerModuleEnabled, moduleDisabledMessage } from "../store/module-access.ts";
import { create } from "@bufbuild/protobuf";
import { ui, type AgentPreviewEvent, type AgentTool } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { coreSettings } from "./core-settings.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreState } from "./core-context.ts";
import { AGENT_WORKER_ID } from "./agent-tools-validation.ts";
import { agentPreviewScope, validatePreviewInputs, validPreviewEvent } from "./agent-preview-validation.ts";
import { AgentPreviewMailbox } from "./agent-preview-mailbox.ts";
import type { GatewayCore } from "./core.ts";
import type { WorkerConnection } from "../worker-link/index.ts";

interface Preview {
  readonly id: string;
  readonly threadId: string;
  readonly worker: WorkerConnection;
  readonly tool: AgentTool;
  readonly mailbox: AgentPreviewMailbox;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly clientAck: boolean;
  timer?: Timer;
  stopped: boolean;
  terminal: boolean;
  checking: boolean;
  seen: bigint;
  delivered: bigint;
  acknowledged: bigint;
  inputTokens: number;
  inputTime: number;
}

/** Human-controlled previews use only the exact live link; no command, journal or replay state. */
export class AgentPreviews {
  readonly #sessions = new Map<string, Preview>();

  constructor(readonly core: GatewayCore) {}

  async #authorize(threadId: string, tool: AgentTool, expected?: WorkerConnection): Promise<WorkerConnection> {
    if (!AGENT_WORKER_ID.test(threadId)) throw new ConnectError("Invalid thread id", Code.InvalidArgument);
    const { runtime, userId } = this.core[coreState].options;

    if (!(await runtime.runPromise(ownerModuleEnabled(userId, "threads"))))
      throw new ConnectError(moduleDisabledMessage("threads"), Code.FailedPrecondition);
    const thread = await coreRun(this.core, (store) => store.thread(threadId));

    if (thread.owner_user_id !== this.core[coreState].options.userId || thread.deleted_at)
      throw new ConnectError("Thread unavailable", Code.NotFound);

    if (thread.archived_at || thread.rewind_pending_id || !thread.worker_id)
      throw new ConnectError("Reopen this thread to use its preview", Code.FailedPrecondition);
    const worker = this.core.link.connections.get(thread.worker_id);

    if (!worker?.isOpen || (expected && worker !== expected))
      throw new ConnectError("The preview's computer disconnected", Code.Unavailable);

    if (!worker.hello.capabilities.includes("agent_preview_v1"))
      throw new ConnectError("Update this worker to use interactive previews", Code.Unimplemented);
    await this.core.agentTools.authorizePreview(worker.workerId, tool);

    if (!worker.isOpen || this.core.link.connections.get(worker.workerId) !== worker)
      throw new ConnectError("The preview's computer disconnected", Code.Unavailable);

    return worker;
  }

  async *watch(request: ui.WatchAgentPreviewRequest, signal: AbortSignal): AsyncIterable<AgentPreviewEvent> {
    const scope = agentPreviewScope(request);
    const worker = await this.#authorize(request.threadId, scope.tool);
    const settings = await coreSettings(this.core, (s) => s.user(this.core[coreState].options.userId));
    signal.throwIfAborted();

    if (this.#sessions.size >= 64 || worker.previewWatches.size >= 4)
      throw new ConnectError("Close an unused preview and try again", Code.ResourceExhausted);
    const id = crypto.randomUUID();

    const preview: Preview = {
      id,
      threadId: request.threadId,
      tool: scope.tool,
      worker,
      signal,
      mailbox: new AgentPreviewMailbox(),
      abort: () => this.#stop(preview),
      clientAck: request.clientAck,
      stopped: false,
      terminal: false,
      checking: false,
      seen: 0n,
      delivered: 0n,
      acknowledged: 0n,
      inputTokens: 256,
      inputTime: Date.now(),
    };

    this.#sessions.set(id, preview);
    worker.previewWatches.set(id, (event) => this.#receive(preview, event));
    signal.addEventListener("abort", preview.abort, { once: true });
    preview.timer = setInterval(() => void this.#heartbeat(preview), 1000);

    try {
      worker.send({
        case: "agentPreview",
        value: {
          kind: {
            case: "start",
            value: {
              previewId: id,
              threadId: request.threadId,
              scope,
              maxFps: request.maxFps || 12,
              agentToolDefaults: settings.agentToolDefaults,
            },
          },
        },
      });

      for (;;) {
        const event = await preview.mailbox.next();

        if (!event || preview.stopped) break;

        if (event.state === "frame") preview.delivered = event.frameId;
        yield event;

        if (event.state === "closed" || event.state === "error") break;

        if (event.state === "frame" && !preview.stopped && !preview.clientAck) {
          preview.acknowledged = event.frameId;
          this.#ack(preview);
        }
      }
    } finally {
      this.#stop(preview);
    }
  }

  #receive(preview: Preview, event?: AgentPreviewEvent): void {
    if (
      !event ||
      !preview.worker.isOpen ||
      this.core.link.connections.get(preview.worker.workerId) !== preview.worker
    ) {
      this.#stop(preview, new ConnectError("The preview's computer disconnected", Code.Unavailable));

      return;
    }

    if (preview.stopped || preview.terminal) return;

    if (!validPreviewEvent(event) || (event.state === "frame" && event.frameId <= preview.seen)) {
      this.#stop(preview, new ConnectError("Invalid preview frame or metadata", Code.DataLoss));

      return;
    }

    if (event.state === "frame") preview.seen = event.frameId;
    preview.terminal = event.state === "error" || event.state === "closed";
    preview.mailbox.push(event);
  }

  async input(request: ui.SendAgentPreviewInputRequest): Promise<ui.WorkerOperationResponse> {
    if (!AGENT_WORKER_ID.test(request.previewId)) throw new ConnectError("Invalid preview id", Code.InvalidArgument);
    validatePreviewInputs(request.inputs);
    const preview = this.#sessions.get(request.previewId);

    if (!preview || preview.threadId !== request.threadId || preview.stopped || preview.terminal)
      throw new ConnectError("Preview unavailable; reopen it", Code.NotFound);
    await this.#authorize(request.threadId, preview.tool, preview.worker);

    if (preview.stopped || preview.terminal || this.#sessions.get(preview.id) !== preview)
      throw new ConnectError("Preview unavailable; reopen it", Code.NotFound);
    const now = Date.now();
    preview.inputTokens = Math.min(256, preview.inputTokens + (now - preview.inputTime) * 0.256);
    preview.inputTime = now;

    if (request.inputs.length > preview.inputTokens)
      throw new ConnectError("Preview input is arriving too quickly", Code.ResourceExhausted);
    preview.inputTokens -= request.inputs.length;
    preview.worker.send({
      case: "agentPreview",
      value: {
        kind: {
          case: "input",
          value: {
            previewId: preview.id,
            inputs: request.inputs,
          },
        },
      },
    });

    return create(ui.WorkerOperationResponseSchema);
  }

  async acknowledge(request: ui.AckAgentPreviewRequest): Promise<ui.WorkerOperationResponse> {
    if (!AGENT_WORKER_ID.test(request.previewId) || request.frameId <= 0n)
      throw new ConnectError("Invalid preview acknowledgement", Code.InvalidArgument);
    const preview = this.#sessions.get(request.previewId);

    if (!preview || preview.threadId !== request.threadId || preview.stopped || preview.terminal)
      throw new ConnectError("Preview unavailable; reopen it", Code.NotFound);
    await this.#authorize(request.threadId, preview.tool, preview.worker);

    if (preview.stopped || preview.terminal || this.#sessions.get(preview.id) !== preview)
      throw new ConnectError("Preview unavailable; reopen it", Code.NotFound);

    if (!preview.clientAck)
      throw new ConnectError("This preview acknowledges frames through its stream", Code.FailedPrecondition);

    // Receiving worker data does not prove delivery: the mailbox may still hold or replace it.
    if (request.frameId !== preview.delivered && request.frameId !== preview.acknowledged)
      throw new ConnectError("Acknowledge a frame delivered by this preview", Code.InvalidArgument);
    preview.acknowledged = request.frameId;
    this.#ack(preview);

    return create(ui.WorkerOperationResponseSchema);
  }

  #ack(preview: Preview): void {
    preview.worker.send({
      case: "agentPreview",
      value: {
        kind: {
          case: "ack",
          value: {
            previewId: preview.id,
            frameId: preview.acknowledged,
          },
        },
      },
    });
  }

  async #heartbeat(preview: Preview): Promise<void> {
    if (preview.checking || preview.stopped) return;
    preview.checking = true;

    try {
      await this.#authorize(preview.threadId, preview.tool, preview.worker);

      if (!preview.stopped) this.#ack(preview);
    } catch (cause) {
      this.#stop(preview, ConnectError.from(cause));
    } finally {
      preview.checking = false;
    }
  }

  #stop(preview: Preview, cause?: Error): void {
    if (preview.stopped) return;
    preview.stopped = true;
    clearInterval(preview.timer);
    preview.signal.removeEventListener("abort", preview.abort);
    preview.worker.previewWatches.delete(preview.id);
    this.#sessions.delete(preview.id);
    preview.mailbox.close(cause);

    if (preview.worker.isOpen) {
      try {
        preview.worker.send({
          case: "agentPreview",
          value: { kind: { case: "stop", value: { previewId: preview.id } } },
        });
      } catch {
        /* The original link closed; previews are never resent to its replacement. */
      }
    }
  }
}

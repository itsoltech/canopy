import { create } from "@bufbuild/protobuf";
import {
  type AgentToolCall,
  AgentToolCallSchema,
  type AgentToolResult,
  AgentToolResultSchema,
  type InteractionRequest,
  InteractionRequestSchema,
  type InteractionResponse,
  InteractionResponseSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import type { GatewayLink } from "../gateway-link/index.ts";

import type { HostContext } from "./host-context.ts";
import { workerDiagnostics } from "../diagnostics/worker.ts";

export class HostEvents {
  constructor(readonly ctx: HostContext) {}
  publish(event: ThreadEvent): void {
    const images = this.ctx.state.markdownImages;

    if (
      images.hold(
        event,
        (held) => this.#publish(held),
        () => Boolean(this.ctx.state.link),
      )
    )
      return;
    const itemId = images.observe(event);
    this.#publish(event);

    if (itemId) images.enqueue(event, itemId, (request, signal) => this.callTool(request, signal));
  }

  #publish(event: ThreadEvent): void {
    const key = `${event.threadId}/${event.turnId}`;

    if (event.body.case === "turnStarted") this.ctx.state.running.add(key);

    if (event.body.case === "turnFinished") {
      this.ctx.state.running.delete(key);
      this.ctx.state.imageExports.close(event.threadId);
      // The turn may have switched branches without the watch noticing.
      setTimeout(() => void this.ctx.state.heads.check(event.threadId), 0).unref();
    }

    if (event.body.case === "turnFinished" || event.body.case === "itemCompleted") {
      this.ctx.ops.wakeRuntimes();
      // The mapper releases its turn/task after publishing the event.
      setTimeout(() => void this.ctx.ops.reconcileRuntimes().catch(() => {}), 0).unref();
    }

    this.ctx.ops.sendEvent(event);
  }

  sendEvent(event: ThreadEvent): void {
    const link = this.ctx.state.link;

    if (!link) return; // journaled: resent (with its previews) after the next Welcome

    try {
      this.ctx.ops.sendPreviews(link, event);
    } catch {
      // link closed meanwhile
    }

    this.ctx.ops.send({ case: "threadEvent", value: event });
  }

  interact(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionResponse> {
    workerDiagnostics.turns.human(request.threadId, request.turnId);
    let completed = false;

    return new Promise((resolve) => {
      const abort = () => {
        const cancelled = create(InteractionRequestSchema, { ...request, cancelled: true });
        this.ctx.state.interactions.set(request.requestId, { request: cancelled, resolve: () => {} });
        this.ctx.ops.send({ case: "interactionRequest", value: cancelled });
        resolve(create(InteractionResponseSchema, { requestId: request.requestId, cancelled: true }));

        if (!completed) workerDiagnostics.turns.humanDone(request.threadId, request.turnId);
        completed = true;
      };

      if (signal?.aborted) {
        abort();

        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
      this.ctx.state.interactions.set(request.requestId, {
        request,
        resolve: (response) => {
          if (!completed) workerDiagnostics.turns.humanDone(request.threadId, request.turnId);
          completed = true;
          signal?.removeEventListener("abort", abort);
          resolve(response);
        },
      });
      this.ctx.ops.send({ case: "interactionRequest", value: request });
    });
  }

  callTool(call: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult> {
    return new Promise((resolve) => {
      const abort = () => {
        const cancelled = create(AgentToolCallSchema, { ...call, cancelled: true });
        // Keep cancellation for reconnect until acknowledged by the gateway.
        this.ctx.state.toolCalls.set(call.callId, { call: cancelled, resolve: () => {} });
        this.ctx.ops.send({ case: "agentToolCall", value: cancelled });
        resolve(create(AgentToolResultSchema, { callId: call.callId, isError: true, content: "Turn interrupted" }));
      };

      if (signal?.aborted) {
        abort();

        return;
      }

      signal?.addEventListener("abort", abort, { once: true });

      const finish = (result: AgentToolResult) => {
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };

      // The same call asked twice (provider retry) shares one gateway round trip.
      const pending = this.ctx.state.toolCalls.get(call.callId);

      if (pending) {
        const first = pending.resolve;
        pending.resolve = (result) => (first(result), finish(result));

        return;
      }

      this.ctx.state.toolCalls.set(call.callId, { call, resolve: finish });
      this.ctx.ops.send({ case: "agentToolCall", value: call });
    });
  }

  send(payload: Parameters<GatewayLink["send"]>[0]): void {
    try {
      this.ctx.state.link?.send(payload);
    } catch {
      // Link closed meanwhile: events are in the journal, interactions are re-sent on attach.
    }
  }

  log(message: string): void {
    this.ctx.state.options.log?.(message);
  }
}

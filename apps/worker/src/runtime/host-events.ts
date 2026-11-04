import { create } from "@bufbuild/protobuf";
import {
  type AgentToolCall,
  type AgentToolResult,
  AgentToolResultSchema,
  type InteractionRequest,
  type InteractionResponse,
  InteractionResponseSchema,
  type ThreadEvent,
} from "@canopy/contracts";
import type { GatewayLink } from "../gateway-link/index.ts";

import type { HostContext } from "./host-context.ts";

export class HostEvents {
  constructor(readonly ctx: HostContext) {}
  publish(event: ThreadEvent): void {
    const key = `${event.threadId}/${event.turnId}`;

    if (event.body.case === "turnStarted") this.ctx.state.running.add(key);

    if (event.body.case === "turnFinished") {
      this.ctx.state.running.delete(key);
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
    return new Promise((resolve) => {
      const abort = () => {
        this.ctx.state.interactions.delete(request.requestId);
        resolve(create(InteractionResponseSchema, { requestId: request.requestId, cancelled: true }));
      };

      if (signal?.aborted) {
        abort();

        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
      this.ctx.state.interactions.set(request.requestId, {
        request,
        resolve: (response) => {
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
        this.ctx.state.toolCalls.delete(call.callId);
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

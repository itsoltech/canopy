import { isAbsolute } from "node:path";
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
  ItemStatus,
  type ThreadEvent,
} from "@canopy/contracts";
import type { GatewayLink } from "../gateway-link/index.ts";
import { Option, Schema } from "effect";

import type { HostContext } from "./host-context.ts";
import { workerDiagnostics } from "../diagnostics/worker.ts";
import { gatewayToolRefusal } from "./tool-gates.ts";
import {
  projectSecretJournalValues,
  projectSecretValues,
  redactSecretText,
  secretPatterns,
} from "./project-secret-guard.ts";
import { projectSecretRequest } from "./project-secret-tool.ts";
import { redactToolOutput } from "../providers/secret-tool-output.ts";

function isMediaPublication(call: AgentToolCall): boolean {
  return (call.toolName === "show_images" || call.toolName === "show_video") && !call.connectorAccountId && !call.botId;
}

function isAutomationAuthorization(call: AgentToolCall): boolean {
  return call.toolName === "authorize_local_automation" && !call.connectorAccountId && !call.botId;
}

const switchedWorkspace = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })));

function isProjectSecretCall(call: AgentToolCall): boolean {
  return call.toolName === "request_secret" && !call.connectorAccountId && projectSecretRequest(call.argumentsJson);
}

const savedProjectFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ status: Schema.Literal("saved"), file: Schema.String })),
);

const PROJECT_SECRET_REQUEST_TIMEOUT_MS = 10_000;
const interactionPayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

function safeInteractionRequest(request: InteractionRequest): InteractionRequest {
  const patterns = secretPatterns(projectSecretJournalValues(request.threadId));

  if (redactSecretText(request.requestJson, patterns) === request.requestJson) return request;
  const payload = interactionPayload(request.requestJson);

  const safe = Option.isSome(payload)
    ? redactToolOutput(payload.value, (text) => redactSecretText(text, patterns))
    : {};

  return create(InteractionRequestSchema, { ...request, requestJson: JSON.stringify(safe) });
}

function projectSecretFailure(callId: string): AgentToolResult {
  return create(AgentToolResultSchema, {
    callId,
    isError: true,
    content:
      "The project secret is unavailable. Canopy needs an active turn, a gateway connection, and a working tool output filter.",
  });
}

export class HostEvents {
  constructor(readonly ctx: HostContext) {}
  publish(event: ThreadEvent): void {
    const { markdownImages: images, secrets } = this.ctx.state;
    const { body, threadId, turnId } = event;

    // Image uploads may delay publication of turn_finished, but the harness turn has already ended.
    if (body.case === "turnStarted") secrets.beginProjectTurn(threadId, turnId);

    if (body.case === "turnFinished") secrets.finishProjectTurn(threadId, turnId);

    if (body.case === "itemStarted" || body.case === "itemCompleted") {
      const item = body.value.item;

      if (item?.content.case === "backgroundTask")
        secrets.trackProjectBackground(
          threadId,
          item.content.value.startedInTurnId || turnId,
          item.itemId,
          item.status === ItemStatus.IN_PROGRESS,
        );
    }

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
    request = safeInteractionRequest(request);
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

  async callTool(
    call: AgentToolCall,
    signal?: AbortSignal,
    admitted?: (finish: () => void) => void,
  ): Promise<AgentToolResult> {
    const link = this.ctx.state.link;
    const result = await this.#requestTool(call, signal);

    if (!result.isError && isAutomationAuthorization(call)) {
      if (!link || this.ctx.state.link !== link) return disconnectedToolResult(call);
      const { callId } = call;
      admitted?.(() => {
        if (this.ctx.state.link === link) this.send({ case: "localAutomationFinished", value: { callId } });
      });
    }

    if (
      !result.isError &&
      call.toolName === "switch_worktree" &&
      !call.connectorAccountId &&
      !call.botId &&
      this.ctx.state.running.has(`${call.threadId}/${call.turnId}`)
    ) {
      const target = switchedWorkspace(result.resultJson);

      if (Option.isSome(target) && isAbsolute(target.value.cwd)) {
        // Owner views follow the committed binding immediately. The active harness keeps its own cwd.
        this.ctx.state.nextWorkspaces.set(call.threadId, target.value.cwd);
        void this.ctx.state.heads.track(call.threadId, target.value.cwd);
        await this.ctx.ops.rebindFileWatch(call.threadId, target.value.cwd);
      }
    }

    if (result.isError || !call.connectorAccountId || call.botId || !result.attachments.length) return result;

    try {
      signal?.throwIfAborted();
      await this.ctx.ops.ensureAttachments(call.threadId, result.attachments, signal);
      signal?.throwIfAborted();

      return result;
    } catch (error) {
      return create(AgentToolResultSchema, {
        callId: call.callId,
        isError: true,
        content: signal?.aborted
          ? "Turn interrupted"
          : `Could not make the downloaded file available on this worker: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  #requestTool(call: AgentToolCall, signal?: AbortSignal): Promise<AgentToolResult> {
    if (this.ctx.state.closedThreads.has(call.threadId) || this.ctx.state.unloadingThreads.has(call.threadId))
      return Promise.resolve(
        create(AgentToolResultSchema, { callId: call.callId, isError: true, content: "Thread closed" }),
      );
    const { link, toolCalls, secrets } = this.ctx.state;
    const mediaPublication = isMediaPublication(call);
    const automation = isAutomationAuthorization(call);
    const projectSecret = isProjectSecretCall(call);

    if (projectSecret) {
      const turn = secrets.requestProjectTurnSignal(call.threadId, call.turnId);

      if (!link || !turn || call.botId || signal?.aborted) return Promise.resolve(projectSecretFailure(call.callId));
      const deadline = AbortSignal.timeout(PROJECT_SECRET_REQUEST_TIMEOUT_MS);
      signal = AbortSignal.any(signal ? [signal, turn, deadline] : [turn, deadline]);
    }

    const privatePatterns = secretPatterns(
      projectSecret ? projectSecretValues(call.threadId) : projectSecretJournalValues(call.threadId),
    );

    if (redactSecretText(call.argumentsJson, privatePatterns) !== call.argumentsJson)
      return Promise.resolve(
        create(AgentToolResultSchema, {
          callId: call.callId,
          isError: true,
          content: "Canopy tools cannot receive a project secret or its private file path. Use it in a local command.",
        }),
      );

    if ((mediaPublication || automation) && !link)
      return Promise.resolve(
        create(AgentToolResultSchema, {
          callId: call.callId,
          isError: true,
          content: "The gateway is offline. Try again when the connection returns.",
        }),
      );
    const refusal = gatewayToolRefusal(call, link?.welcome);

    if (refusal) return Promise.resolve(refusal);

    return new Promise((resolve) => {
      const abort = () => {
        const cancelled = create(AgentToolCallSchema, { ...call, cancelled: true });

        if (projectSecret || automation) {
          signal?.removeEventListener("abort", abort);
          const wasPending = toolCalls.delete(call.callId);

          if (projectSecret) secrets.fenceProjectTurn(call.threadId, call.turnId);

          if ((projectSecret || wasPending) && this.ctx.state.link === link)
            this.ctx.ops.send({ case: "agentToolCall", value: cancelled });
          resolve(
            projectSecret
              ? projectSecretFailure(call.callId)
              : create(AgentToolResultSchema, { callId: call.callId, isError: true, content: "Turn interrupted" }),
          );

          return;
        }

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
      const pending = toolCalls.get(call.callId);

      if (pending) {
        const first = pending.resolve;
        pending.resolve = (result) => (first(result), finish(result));

        return;
      }

      toolCalls.set(call.callId, { call, resolve: finish, ...(automation && { cancel: abort }) });

      if ((mediaPublication || projectSecret || automation) && link) {
        // These calls are bound to their original connection and cannot resume after reconnect.
        try {
          link.send({ case: "agentToolCall", value: call });
        } catch {
          if (projectSecret) secrets.fenceProjectTurns();
          this.toolResult(projectSecret ? projectSecretFailure(call.callId) : disconnectedToolResult(call));
        }
      } else this.ctx.ops.send({ case: "agentToolCall", value: call });
    });
  }

  detachGateway(link: GatewayLink): boolean {
    if (this.ctx.state.link !== link) return false;
    this.ctx.state.link = undefined;
    this.ctx.state.secrets.fenceProjectTurns();

    for (const { call } of this.ctx.state.toolCalls.values())
      if (isMediaPublication(call) || isAutomationAuthorization(call)) this.toolResult(disconnectedToolResult(call));

    return true;
  }

  toolResult(result: AgentToolResult): void {
    const pending = this.ctx.state.toolCalls.get(result.callId);

    if (!pending) return;
    this.ctx.state.toolCalls.delete(result.callId);

    const saved =
      isProjectSecretCall(pending.call) && !result.isError ? savedProjectFile(result.content) : Option.none();

    const { threadId, turnId } = pending.call;

    const available =
      Option.isNone(saved) || this.ctx.state.secrets.projectFileAvailable(threadId, turnId, saved.value.file);

    pending.resolve(available ? result : projectSecretFailure(result.callId));
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

function disconnectedToolResult(call: AgentToolCall): AgentToolResult {
  const media = call.toolName === "show_video" ? "the video was" : "the images were";

  return create(AgentToolResultSchema, {
    callId: call.callId,
    isError: true,
    content: isAutomationAuthorization(call)
      ? "Lost the gateway connection that authorizes this automation action."
      : `Lost the connection to the gateway. Canopy could not confirm that ${media} published. Check the thread before trying again.`,
  });
}

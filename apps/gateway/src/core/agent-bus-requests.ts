import { type JsonValue } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { type AgentToolCall, type AgentToolResult } from "@canopy/contracts";
import {
  authorizeBusCall,
  decodeAgentBusCall,
  isAgentBusTool,
  resolveSpawnTarget,
  type AgentBusCall,
  type SpawnResolution,
} from "@canopy/domain";
import { Result } from "effect";
import { AgentBusStore, GatewayStore, type CallSource } from "../store/index.ts";
import { busState, callerTarget, failure, ok, safeJson, STORES_ITS_CALL, targetsOf } from "./agent-bus-context.ts";
import type { AgentBus } from "./agent-bus.ts";
import { busExecute } from "./agent-bus-tools.ts";
import { busCancel } from "./agent-bus-cancellation.ts";

export interface BusRequestsMethods {
  handle(request: AgentToolCall, workerId?: string): Promise<AgentToolResult>;
}

export const busRequestsMethods: BusRequestsMethods = {
  /** `workerId`: the worker the call came from; it speaks only for its own threads (messages now reach other workers). */
  async handle(this: AgentBus, request: AgentToolCall, workerId?: string): Promise<AgentToolResult> {
    const source: CallSource = {
      callId: request.callId,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      ...(request.expiresAt && { expiresAt: timestampDate(request.expiresAt) }),
    };

    const calling = await this[busState].host
      .run(GatewayStore.use((s) => s.thread(request.threadId)))
      .catch(() => undefined);

    if (
      !calling ||
      (workerId !== undefined && calling.worker_id !== workerId) ||
      (this[busState].host.ownerUserId && calling.owner_user_id !== this[busState].host.ownerUserId)
    )
      return failure(request.callId, "Thread not found");

    if (request.cancelled) return busCancel(this, request, source, workerId);

    const stored = await this[busState].host.run(AgentBusStore.use((s) => s.storedCall(request.callId)));

    if (stored && stored.source_thread_id !== calling.id) return failure(request.callId, "Call not found");

    // A synchronous ask is persisted before waiting; reconnecting attaches to that same question set.
    if (
      stored &&
      stored.status !== "requested" &&
      !(["ask_user", "request_secret"].includes(stored.tool) && stored.status === "completed")
    ) {
      return stored.status === "completed"
        ? ok(request.callId, stored.result ?? {})
        : failure(request.callId, stored.error ?? "failed");
    }

    const decoded = decodeAgentBusCall(request.toolName, request.argumentsJson);

    const refuse = async (reason: string, args: JsonValue | AgentBusCall["args"] = {}) => {
      // The record is for audit and idempotency; the model gets its answer even if storing fails
      // (e.g. a call naming a thread the gateway does not know).
      if (isAgentBusTool(request.toolName)) {
        await this[busState].host
          .run(
            AgentBusStore.use((s) => s.recordCall({ source, tool: request.toolName, args, ok: false, error: reason })),
          )
          .catch((cause: unknown) => console.error("agent bus: refused call not recorded", cause));
      }

      return failure(request.callId, reason);
    };

    if (Result.isFailure(decoded)) return refuse(decoded.failure, safeJson(request.argumentsJson));
    const call = decoded.success;

    if (calling && this[busState].host.linked) {
      try {
        const result = await this[busState].host.linked(request, call, calling);

        if (result !== undefined) {
          await this[busState].host.run(
            AgentBusStore.use((s) =>
              s.recordCall({ source, tool: call.tool, args: call.args, ok: true, result, observedTurnIds: [] }),
            ),
          );

          return ok(request.callId, result);
        }
      } catch (error) {
        return refuse(
          error instanceof Error && error.name === "ConnectError"
            ? error.message
            : "Linked agent action rejected or unavailable",
          call.args,
        );
      }
    }

    // Where a subagent runs: resolved first, so the fork rule can judge it; a problem is reported after the
    // bus rules (a side thread hears that it cannot spawn at all, not that the model is wrong).
    let spawn: SpawnResolution | undefined;

    if (call.tool === "spawn_thread" && calling)
      spawn = resolveSpawnTarget(call.args, callerTarget(calling), await this[busState].host.spawnInstances(calling));

    const { caller, facts } = await this[busState].host.run(
      AgentBusStore.use((s) =>
        s.facts({
          source,
          targetIds: targetsOf(call),
          ...(spawn?.ok && { spawnTarget: spawn.target }),
          ...(call.tool === "answer_interaction" && { interactionId: call.args.request_id }),
          ...(call.tool === "cancel_schedule" && { scheduleId: call.args.schedule_id }),
          ...((call.tool === "schedule_wakeup" || call.tool === "schedule_recurring") && {
            scheduleThreadId: call.args.thread_id ?? source.threadId,
          }),
        }),
      ),
    );

    const decision = authorizeBusCall(call, facts);

    if (!decision.allowed) return refuse(decision.reason, call.args);

    if (spawn && !spawn.ok) return refuse(spawn.reason, call.args);
    const hops = decision.hops ?? facts.callerHops + 1;

    try {
      let result = await busExecute(this, call, source, caller, hops, spawn?.ok ? spawn.target : callerTarget(caller));

      if (this[busState].host.extend) result = await this[busState].host.extend(call, caller, result);

      if (!STORES_ITS_CALL.has(call.tool)) {
        await this[busState].host.run(
          AgentBusStore.use((s) => s.recordCall({ source, tool: call.tool, args: call.args, ok: true, result })),
        );
      }

      if (["get_thread", "read_thread", "wait_threads", "interrupt_thread", "close_thread"].includes(call.tool))
        await this[busState].host.inputsChanged(source.threadId);

      return ok(request.callId, result);
    } catch (error) {
      // A concurrent duplicate of a spawn/send may have stored it first.
      const again = await this[busState].host.run(AgentBusStore.use((s) => s.storedCall(request.callId)));

      if (again?.status === "completed" && again.source_thread_id === calling.id)
        return ok(request.callId, again.result ?? {});

      const reason =
        error instanceof Error && (error.name === "Invalid" || error.name === "NotFound")
          ? error.message
          : "the call failed on the gateway";

      if (reason === "the call failed on the gateway") console.error("agent bus", call.tool, error);

      return refuse(reason, call.args);
    }
  },
};

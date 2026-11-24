import { THREADS_DISABLED_REASON } from "../store/module-worker-commands.ts";
import { ownerModuleEnabled, moduleDisabledMessage } from "../store/module-access.ts";
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
import { AgentBusStore, GatewayStore, type BusCallRow, type CallSource, type ThreadRow } from "../store/index.ts";
import {
  busState,
  callerTarget,
  callerWithServiceTier,
  failure,
  ok,
  safeJson,
  STORES_ITS_CALL,
  targetsOf,
  type BusHost,
} from "./agent-bus-context.ts";
import type { AgentBus } from "./agent-bus.ts";
import { busExecute } from "./agent-bus-tools.ts";
import { busCancel } from "./agent-bus-cancellation.ts";
import type { WorkerConnection } from "../worker-link/index.ts";

export interface BusRequestsMethods {
  handle(request: AgentToolCall, workerId?: string, connection?: WorkerConnection): Promise<AgentToolResult>;
}

export const busRequestsMethods: BusRequestsMethods = {
  /** `workerId`: the worker the call came from; it speaks only for its own threads (messages now reach other workers). */
  async handle(
    this: AgentBus,
    request: AgentToolCall,
    workerId?: string,
    connection?: WorkerConnection,
  ): Promise<AgentToolResult> {
    const supplied = toolSource(request);

    const calling = await this[busState].host
      .run(GatewayStore.use((s) => s.thread(request.threadId)))
      .catch(() => undefined);

    if (
      !calling ||
      (workerId !== undefined && calling.worker_id !== workerId) ||
      calling.owner_user_id !== this[busState].host.ownerUserId
    )
      return failure(request.callId, "Thread not found");

    if (request.cancelled) return busCancel(this, request, supplied, workerId);

    if (!(await this[busState].host.run(ownerModuleEnabled(calling.owner_user_id, "threads"))))
      return failure(request.callId, moduleDisabledMessage("threads"));

    if (calling.rewind_pending_id) return failure(request.callId, "This message has been rewound.");

    const stored = await this[busState].host.run(AgentBusStore.use((s) => s.storedCall(request.callId)));

    if (stored && stored.source_thread_id !== calling.id) return failure(request.callId, "Call not found");

    if (stored && stored.tool !== request.toolName) return failure(request.callId, "Call not found");
    const storedTurnId = stored?.source_turn_id;

    if (storedTurnId) {
      const [turn] = await this[busState].host.run(GatewayStore.use((s) => s.turnsOf(calling.id, [storedTurnId])));

      if (turn?.rewind_id) return failure(request.callId, "This message has been rewound.");
    }

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

    if (request.toolName === "switch_worktree" && !supplied.turnId)
      return failure(request.callId, "Switch worktrees from the active turn.");

    const context = await bindToolSource(this[busState].host, supplied, stored);

    if (!context.ok) return failure(request.callId, context.reason);
    const { source, sourceTurn } = context;

    const decoded = decodeAgentBusCall(request.toolName, request.argumentsJson);

    const refuse = (reason: string, args?: JsonValue | AgentBusCall["args"]) =>
      recordRefusal(this[busState].host, source, request.toolName, reason, args);

    if (Result.isFailure(decoded)) return refuse(decoded.failure, safeJson(request.argumentsJson));
    const call = decoded.success;
    const projectLease = call.tool === "request_secret" && !!call.args.project_secret;

    if (projectLease && (!supplied.turnId || supplied.turnId !== source.turnId))
      return refuse("A project secret requires the calling thread's current turn.", call.args);

    const linked = await runLinkedTool(
      this[busState].host,
      request,
      call,
      source,
      callerWithServiceTier(calling, sourceTurn),
    );

    if (linked) return linked.ok ? ok(request.callId, linked.result) : refuse(linked.reason, call.args);

    // Where a subagent runs: resolved first, so the fork rule can judge it; a problem is reported after the
    // bus rules (a side thread hears that it cannot spawn at all, not that the model is wrong).
    let spawn: SpawnResolution | undefined;

    if (call.tool === "spawn_thread" && calling)
      spawn = resolveSpawnTarget(
        call.args,
        callerTarget(calling, sourceTurn),
        await this[busState].host.spawnInstances(calling),
      );

    const { caller, facts } = await this[busState].host.run(
      AgentBusStore.use((s) =>
        s.facts({
          source,
          targetIds: targetsOf(call),
          matchAudience: ["send_message", "schedule_wakeup", "schedule_recurring"].includes(call.tool),
          ...(spawn?.ok && { spawnTarget: spawn.target }),
          ...(call.tool === "answer_interaction" && { interactionId: call.args.request_id }),
          ...(call.tool === "cancel_schedule" && { scheduleId: call.args.schedule_id }),
          ...((call.tool === "schedule_wakeup" || call.tool === "schedule_recurring") && {
            scheduleThreadId: call.args.thread_id ?? source.threadId,
          }),
        }),
      ),
    );

    if (workerId !== undefined && caller.worker_id !== workerId) return failure(request.callId, "Thread not found");

    const decision = authorizeBusCall(call, facts);

    if (!decision.allowed) return refuse(decision.reason, call.args);

    if (spawn && !spawn.ok) return refuse(spawn.reason, call.args);
    const hops = decision.hops ?? facts.callerHops + 1;

    try {
      let result = await busExecute(
        this,
        call,
        source,
        caller,
        hops,
        spawn?.ok ? spawn.target : callerTarget(caller, sourceTurn),
        connection,
      );

      if (this[busState].host.extend && !(caller.memory_audience && call.tool === "list_threads"))
        result = await this[busState].host.extend(call, caller, result);

      if (!STORES_ITS_CALL.has(call.tool)) {
        const recorded = projectLease ? {} : result;
        await this[busState].host.run(
          AgentBusStore.use((s) =>
            s.recordCall({ source, tool: call.tool, args: call.args, ok: true, result: recorded }),
          ),
        );
      }

      if (["get_thread", "read_thread", "wait_threads", "interrupt_thread", "close_thread"].includes(call.tool))
        await this[busState].host.inputsChanged(source.threadId);

      return ok(request.callId, result);
    } catch (error) {
      // A concurrent duplicate of a spawn/send may have stored it first.
      const again = await this[busState].host.run(AgentBusStore.use((s) => s.storedCall(request.callId)));

      if (!projectLease && again?.status === "completed" && again.source_thread_id === calling.id)
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

async function recordRefusal(
  host: BusHost,
  source: CallSource,
  tool: string,
  reason: string,
  args: JsonValue | AgentBusCall["args"] = {},
) {
  // A failed audit write must not hide the refusal.
  if (isAgentBusTool(tool)) {
    await host
      .run(AgentBusStore.use((s) => s.recordCall({ source, tool, args, ok: false, error: reason })))
      .catch((cause: unknown) => console.error("agent bus: refused call not recorded", cause));
  }

  return failure(source.callId, reason);
}

async function runLinkedTool(
  host: BusHost,
  request: AgentToolCall,
  call: AgentBusCall,
  source: CallSource,
  caller: ThreadRow,
) {
  try {
    const result = await host.linked?.({ ...request, turnId: source.turnId }, call, caller);

    if (result === undefined) return;
    await host.run(
      AgentBusStore.use((s) =>
        s.recordCall({ source, tool: call.tool, args: call.args, ok: true, result, observedTurnIds: [] }),
      ),
    );

    return { ok: true, result } as const;
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "ConnectError"
        ? error.message
        : "Linked agent action rejected or unavailable";

    return { ok: false, reason } as const;
  }
}

async function bindToolSource(host: BusHost, supplied: CallSource, stored: BusCallRow | undefined) {
  const sourceTurn = await host.run(AgentBusStore.use((s) => s.contextTurn(supplied.threadId)));
  const renewing = stored && ["ask_user", "request_secret"].includes(stored.tool);
  const contextId = renewing ? stored.source_turn_id : sourceTurn?.id;

  if (!renewing && supplied.turnId && supplied.turnId !== contextId)
    return { ok: false, reason: "This tool call is outside the current turn context." } as const;

  if (sourceTurn?.interrupt_reason === THREADS_DISABLED_REASON && supplied.turnId && !renewing)
    return { ok: false, reason: "This turn stopped when Threads was turned off." } as const;

  return { ok: true, sourceTurn, source: { ...supplied, turnId: contextId ?? "" } } as const;
}

function toolSource(request: AgentToolCall): CallSource {
  return {
    callId: request.callId,
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    ...(request.expiresAt && { expiresAt: timestampDate(request.expiresAt) }),
  };
}

import { create, type JsonValue } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ui, type AgentToolCall, type AgentToolResult } from "@open-agents/contracts";
import { authorizeBusCall, decodeAgentBusCall, DEFAULT_BUS_LIMITS, isAgentBusTool, type AgentBusCall } from "@open-agents/domain";
import { Result, type Effect } from "effect";
import { AgentBusStore, truncate, type CallSource, type ThreadRow, type TurnRow } from "../store/index.ts";
import { cronProblem, nextCronRun } from "./cron.ts";
import type { GatewayStore } from "../store/index.ts";

/**
 * Agent bus runtime (docs/agent-bus.md): agents delegate work to side threads and talk to the other
 * threads of their tree through tool calls the worker forwards (AgentToolCall).
 *
 * Every call: strict decode -> facts from the database -> authorizeBusCall (packages/domain) -> execute.
 * Calls are idempotent by call_id: a call re-sent after a reconnect gets its stored result.
 * spawn_thread and send_message return at once; the caller hears back through a notification turn
 * when the target's turn finishes, or polls with wait_threads / get_thread.
 */

export interface BusHost {
  run<A, E>(effect: Effect.Effect<A, E, GatewayStore | AgentBusStore>): Promise<A>;
  /** Sends CreateThread for a new thread (with its fork point) and announces it. */
  startThread(row: ThreadRow): Promise<void>;
  /** A turn was queued in a thread: announce it and start it when the thread is free. */
  queued(threadId: string, turn: TurnRow): Promise<void>;
  /** A message was stored as a steer of a running turn: send it to the worker. */
  steered(steerId: string): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  answer(by: { threadId: string }, request: ui.AnswerInteractionRequest): Promise<ui.Interaction>;
  broadcastThread(threadId: string): Promise<void>;
  /** An agent created or cancelled a schedule: announce it. */
  scheduleChanged(scheduleId: string): Promise<void>;
}

const WAIT_POLL_MS = 1_000;
/** Tools whose execution stores the call together with what it created (one transaction). */
const STORES_ITS_CALL = new Set(["spawn_thread", "send_message", "schedule_wakeup", "schedule_recurring"]);

export class AgentBus {
  readonly #host: BusHost;

  constructor(host: BusHost) {
    this.#host = host;
  }

  async handle(request: AgentToolCall): Promise<AgentToolResult> {
    const source: CallSource = { callId: request.callId, threadId: request.threadId, turnId: request.turnId, itemId: request.itemId };
    const stored = await this.#host.run(AgentBusStore.use((s) => s.storedCall(request.callId)));
    if (stored && stored.status !== "requested") {
      return stored.status === "completed" ? ok(request.callId, stored.result ?? {}) : failure(request.callId, stored.error ?? "failed");
    }
    const decoded = decodeAgentBusCall(request.toolName, request.argumentsJson);
    const refuse = async (reason: string, args: unknown = {}) => {
      // The record is for audit and idempotency; the model gets its answer even if storing fails
      // (e.g. a call naming a thread the gateway does not know).
      if (isAgentBusTool(request.toolName)) {
        await this.#host
          .run(AgentBusStore.use((s) => s.recordCall({ source, tool: request.toolName, args, ok: false, error: reason })))
          .catch((error: unknown) => console.error("agent bus: refused call not recorded", error));
      }
      return failure(request.callId, reason);
    };
    if (Result.isFailure(decoded)) return refuse(decoded.failure, safeJson(request.argumentsJson));
    const call = decoded.success;
    if (call.tool === "spawn_thread" && call.args.agent !== undefined) {
      return refuse("agents are not configured yet: omit agent to start a copy of yourself", call.args);
    }

    const { caller, facts } = await this.#host.run(
      AgentBusStore.use((s) =>
        s.facts({
          source,
          targetIds: targetsOf(call),
          ...(call.tool === "answer_interaction" && { interactionId: call.args.request_id }),
          ...(call.tool === "cancel_schedule" && { scheduleId: call.args.schedule_id }),
          ...((call.tool === "schedule_wakeup" || call.tool === "schedule_recurring") && { scheduleThreadId: call.args.thread_id ?? source.threadId }),
        }),
      ),
    );
    const decision = authorizeBusCall(call, facts);
    if (!decision.allowed) return refuse(decision.reason, call.args);
    const hops = decision.hops ?? facts.callerHops + 1;

    try {
      const result = await this.#execute(call, source, caller, hops);
      if (!STORES_ITS_CALL.has(call.tool)) {
        await this.#host.run(AgentBusStore.use((s) => s.recordCall({ source, tool: call.tool, args: call.args, ok: true, result })));
      }
      return ok(request.callId, result);
    } catch (error) {
      // A concurrent duplicate of a spawn/send may have stored it first.
      const again = await this.#host.run(AgentBusStore.use((s) => s.storedCall(request.callId)));
      if (again?.status === "completed") return ok(request.callId, again.result ?? {});
      const reason = error instanceof Error && (error.name === "Invalid" || error.name === "NotFound") ? error.message : "the call failed on the gateway";
      if (reason === "the call failed on the gateway") console.error("agent bus", call.tool, error);
      return refuse(reason, call.args);
    }
  }

  /** A turn finished: notify the threads that asked to hear about it. */
  async onTurnFinished(turnId: string): Promise<void> {
    const due = await this.#host.run(AgentBusStore.use((s) => s.dueNotifications(turnId)));
    for (const { call, target, turnStatus, lastMessage } of due) {
      const label = target.kind === "side" ? "side thread" : "thread";
      const input = {
        note: `[open-agents] The ${label} "${target.title}" (thread_id: ${target.id}) finished a turn: ${turnStatus}. Its last message:`,
        message: truncate(lastMessage, 20_000) || "(no message)",
      };
      const turn = await this.#host.run(AgentBusStore.use((s) => s.deliverNotification(call.id, input)));
      if (turn) await this.#host.queued(call.source_thread_id, turn);
    }
  }

  /** A side thread with interaction_route = parent asks: wake the parent agent with the question. */
  async onInteraction(interaction: ui.Interaction): Promise<void> {
    if (interaction.routedTo !== "parent" || interaction.status !== "pending") return;
    const forwarded = await this.#host.run(
      AgentBusStore.use((s) =>
        s.forwardInteraction({
          requestId: interaction.requestId,
          maxHops: DEFAULT_BUS_LIMITS.maxHops,
          input: (thread) => {
            const kind = interaction.kind === 1 ? "permission" : interaction.kind === 2 ? "question" : "form";
            const how =
              kind === "permission"
                ? `answer_interaction with response "allow" or "deny"`
                : `answer_interaction with response "answer" and answer_json, or "cancel"`;
            // All of it is the platform's; the UI shows the question from the turn's structured source.
            return {
              note:
                `[open-agents] Your side thread "${thread.title}" (thread_id: ${thread.id}) is waiting for your answer.\n` +
                `request_id: ${interaction.requestId}\nkind: ${kind}\ntool: ${interaction.toolName}\n` +
                `request: ${truncate(interaction.requestJson, 4_000)}\n\n` +
                `Answer with ${how}. The user can answer in the UI instead.`,
              message: "",
            };
          },
        }),
      ),
    );
    if (forwarded) await this.#host.queued(forwarded.parentThreadId, forwarded.turn);
  }

  /** A created schedule is announced to the UI before the agent hears back. */
  async #announced(created: Promise<JsonValue>): Promise<JsonValue> {
    const result = await created;
    const id = scheduleIdOf(result);
    if (id) await this.#host.scheduleChanged(id);
    return result;
  }

  async #execute(call: AgentBusCall, source: CallSource, caller: ThreadRow, hops: number): Promise<JsonValue> {
    const store = <A, E>(use: (s: AgentBusStore["Service"]) => Effect.Effect<A, E>) => this.#host.run(AgentBusStore.use(use));
    switch (call.tool) {
      case "list_agents":
        return { agents: [], note: "No agent catalog yet: spawn_thread starts a copy of you (same provider, model and settings)." };
      case "spawn_thread": {
        const { thread, turn, result } = await store((s) => s.spawn({ source, caller, args: call.args, hops }));
        await this.#host.startThread(thread);
        await this.#host.queued(thread.id, turn);
        return result;
      }
      case "send_message": {
        const sent = await store((s) => s.send({ source, caller, args: call.args, hops }));
        if (sent.turn) await this.#host.queued(call.args.thread_id, sent.turn);
        else await this.#host.steered(sent.steerId);
        return sent.result;
      }
      case "wait_threads": {
        const ids = call.args.thread_ids;
        const all = call.args.until === "all";
        const deadline = Date.now() + (call.args.timeout_seconds ?? 120) * 1000;
        for (;;) {
          const threads = await Promise.all(ids.map((id) => store((s) => s.summary(id))));
          const ready = threads.map((t) => t.settled || t.waiting_for_parent > 0);
          const done = all ? ready.every(Boolean) : ready.some(Boolean);
          if (done || Date.now() >= deadline) return { done, threads: threads as unknown as JsonValue };
          await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
        }
      }
      case "get_thread":
        return (await store((s) => s.summary(call.args.thread_id))) as unknown as JsonValue;
      case "read_thread":
        return await store((s) =>
          s.readThread({ threadId: call.args.thread_id, afterSeq: call.args.after_seq ?? 0, limit: call.args.limit ?? 50, view: call.args.view ?? "messages" }),
        );
      case "list_threads":
        return { threads: (await store((s) => s.listThreads(caller, call.args.scope ?? "children"))) as unknown as JsonValue };
      case "interrupt_thread":
        await this.#host.interrupt(call.args.thread_id);
        return { thread_id: call.args.thread_id, interrupted: true };
      case "close_thread":
        await store((s) => s.close(call.args.thread_id));
        await this.#host.interrupt(call.args.thread_id);
        await this.#host.broadcastThread(call.args.thread_id);
        return { thread_id: call.args.thread_id, closed: true };
      case "list_interactions":
        return { interactions: [...(await store((s) => s.parentInteractions(caller.id)))] as unknown as JsonValue };
      case "answer_interaction": {
        const { request_id: requestId, response } = call.args;
        const interaction = await this.#host.answer(
          { threadId: caller.id },
          create(ui.AnswerInteractionRequestSchema, {
            requestId,
            allow: response === "allow",
            cancelled: response === "cancel",
            ...(call.args.message !== undefined && { message: call.args.message }),
            ...(call.args.answer_json !== undefined && { answerJson: call.args.answer_json }),
          }),
        );
        return { request_id: requestId, status: interaction.status };
      }
      case "schedule_wakeup": {
        const now = Date.now();
        const runAt = call.args.at !== undefined ? new Date(call.args.at) : new Date(now + (call.args.delay_seconds ?? 60) * 1000);
        return await this.#announced(store((s) =>
          s.createSchedule({
            source,
            tool: call.tool,
            args: call.args,
            schedule: { threadId: call.args.thread_id ?? caller.id, kind: "once", prompt: call.args.prompt, runAt, timezone: "UTC", nextRunAt: runAt, hops },
          }),
        ));
      }
      case "schedule_recurring": {
        const now = new Date();
        const timezone = call.args.timezone ?? "UTC";
        const problem = cronProblem(call.args.cron, timezone, DEFAULT_BUS_LIMITS.minCronMinutes, now);
        if (problem) throw new BusRefusal(problem);
        const nextRunAt = nextCronRun(call.args.cron, timezone, now);
        if (!nextRunAt) throw new BusRefusal("cron has no future runs");
        return await this.#announced(store((s) =>
          s.createSchedule({
            source,
            tool: call.tool,
            args: call.args,
            schedule: {
              threadId: call.args.thread_id ?? caller.id,
              kind: "recurring",
              prompt: call.args.prompt,
              cron: call.args.cron,
              timezone,
              ...(call.args.until !== undefined && { until: new Date(call.args.until) }),
              ...(call.args.max_runs !== undefined && { maxRuns: call.args.max_runs }),
              nextRunAt,
              hops,
            },
          }),
        ));
      }
      case "list_schedules": {
        const rows = await store((s) => s.listSchedules(caller.id));
        return {
          schedules: rows.map((r) => ({
            schedule_id: r.id,
            thread_id: r.thread_id,
            kind: r.kind,
            prompt: truncate(r.prompt, 500),
            status: r.status,
            next_run_at: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
            runs: r.runs,
            ...(r.cron && { cron: r.cron, timezone: r.timezone }),
            ...(r.max_runs !== null && { max_runs: r.max_runs }),
            ...(r.until && { until: new Date(r.until).toISOString() }),
          })),
        };
      }
      case "cancel_schedule":
        await store((s) => s.cancelSchedule(call.args.schedule_id));
        await this.#host.scheduleChanged(call.args.schedule_id);
        return { schedule_id: call.args.schedule_id, cancelled: true };
      default:
        throw new Error(`${call.tool} is not available yet`);
    }
  }
}

/** A reason for the model, found while executing (e.g. a cron the parser rejects). */
class BusRefusal extends Error {
  override readonly name = "Invalid";
}

function scheduleIdOf(result: JsonValue): string | undefined {
  return result && typeof result === "object" && !Array.isArray(result) && typeof result["schedule_id"] === "string" ? result["schedule_id"] : undefined;
}

function targetsOf(call: AgentBusCall): string[] {
  switch (call.tool) {
    case "send_message":
    case "get_thread":
    case "read_thread":
    case "interrupt_thread":
    case "close_thread":
      return [call.args.thread_id];
    case "wait_threads":
      return [...call.args.thread_ids];
    case "schedule_wakeup":
    case "schedule_recurring":
      return call.args.thread_id ? [call.args.thread_id] : [];
    default:
      return [];
  }
}

function ok(callId: string, result: JsonValue): AgentToolResult {
  const json = JSON.stringify(result);
  return create(AgentToolResultSchema, { callId, isError: false, content: json, resultJson: json });
}

function failure(callId: string, reason: string): AgentToolResult {
  return create(AgentToolResultSchema, { callId, isError: true, content: reason, resultJson: JSON.stringify({ error: reason }) });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: truncate(text, 2_000) };
  }
}

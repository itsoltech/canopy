import { create, type JsonValue } from "@bufbuild/protobuf";
import { AgentToolResultSchema, ui, type AgentToolCall, type AgentToolResult } from "@canopy/contracts";
import { type AgentBusArgs, type AgentBusCall, type SpawnInstance, type SpawnTarget } from "@canopy/domain";
import { Match, Predicate, Schema, type Effect } from "effect";
import {
  AgentBusStore,
  GatewayStore,
  truncate,
  type CallSource,
  type ThreadRow,
  type TurnRow,
} from "../store/index.ts";

/**
 * Agent bus runtime (docs/agent-bus.md): agents delegate work to side threads (on any provider instance of their
 * worker) and talk to the other threads of their tree, or to any thread of their owner like the user would, through
 * tool calls the worker forwards (AgentToolCall).
 *
 * Every call: strict decode -> facts from the database -> authorizeBusCall (packages/domain) -> execute.
 * Calls are idempotent by call_id: a call re-sent after a reconnect gets its stored result.
 * spawn_thread and send_message return at once; the caller hears back through a platform steer (or a turn)
 * when the target's turn finishes, or polls with wait_threads / get_thread.
 */

export interface BusHost {
  ownerUserId?: string;
  linked?(request: AgentToolCall, call: AgentBusCall, caller: ThreadRow): Promise<JsonValue | undefined>;
  extend?(call: AgentBusCall, caller: ThreadRow, result: JsonValue): Promise<JsonValue>;
  run<A, E>(effect: Effect.Effect<A, E, GatewayStore | AgentBusStore>): Promise<A>;
  /** Sends CreateThread for a new thread (with its fork point) and announces it. */
  startThread(row: ThreadRow): Promise<void>;
  prepareWorkspace?(caller: ThreadRow, args: AgentBusArgs["spawn_thread"]): Promise<ui.CreateThreadRequest>;
  nameWorkspace?(thread: ThreadRow, prompt: string): Promise<void>;
  /** A turn was queued in a thread: announce it and start it when the thread is free. */
  queued(threadId: string, turn: TurnRow): Promise<void>;
  /** A message was stored as a steer of a running turn: send it to the worker. */
  steered(steerId: string): Promise<void>;
  fallbackSteer(steerId: string): Promise<void>;
  interaction(interaction: ui.Interaction): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  answer(by: { threadId: string }, request: ui.AnswerInteractionRequest): Promise<ui.Interaction>;
  broadcastThread(threadId: string): Promise<void>;
  /** Publish committed consumption of queued inputs and unentered steers to every live client. */
  inputsChanged(threadId: string): Promise<void>;
  /** An agent created or cancelled a schedule: announce it. */
  scheduleChanged(scheduleId: string): Promise<void>;
  requestSecret(source: CallSource, args: AgentBusArgs["request_secret"]): Promise<JsonValue>;
  showImages(source: CallSource, caller: ThreadRow, args: AgentBusArgs["show_images"]): Promise<JsonValue>;
  /**
   * The provider instances of the thread's worker a subagent can run on (enabled there, with their availability and
   * the pickers' model catalogs); undefined before the worker reported its configuration.
   */
  spawnInstances(thread: ThreadRow): Promise<readonly SpawnInstance[] | undefined>;
  /** The thread's background tasks (list, get, stop): core/background-tasks.ts. */
  backgroundTask(
    call: Extract<AgentBusCall, { tool: "list_background_tasks" | "get_background_task" | "stop_background_task" }>,
    callerId: string,
  ): Promise<JsonValue>;
}

export const WAIT_POLL_MS = 1_000;

/** Tools that persist their own call (reads store their result together with notification consumption). */
export const STORES_ITS_CALL = new Set([
  "show_images",
  "spawn_thread",
  "send_message",
  "schedule_wakeup",
  "schedule_recurring",
  "ask_user",
  "read_thread",
  "get_thread",
  "wait_threads",
]);

/** What the calling thread runs on: a subagent's default. */
export function callerTarget(thread: ThreadRow): SpawnTarget {
  return {
    harness: Match.value(thread.provider).pipe(
      Match.when("claude", () => "claude" as const),
      Match.when("grok", () => "grok" as const),
      Match.orElse(() => "codex" as const),
    ),
    instance: thread.provider_profile_id || "native",
    model: thread.settings.model ?? "",
    effort: thread.settings.effort ?? "",
  };
}

/** A reason for the model, found while executing (e.g. a cron the parser rejects). */
export class BusRefusal extends Error {
  override readonly name = "Invalid";
}

export function scheduleIdOf(result: JsonValue): string | undefined {
  return Predicate.isObject(result) && Predicate.isString(result["schedule_id"]) ? result["schedule_id"] : undefined;
}

export function targetsOf(call: AgentBusCall): string[] {
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
    case "list_background_tasks":
    case "get_background_task":
    case "stop_background_task":
      return call.args.thread_id ? [call.args.thread_id] : [];
    default:
      return [];
  }
}

export function ok(callId: string, result: JsonValue): AgentToolResult {
  const json = JSON.stringify(result);

  return create(AgentToolResultSchema, { callId, isError: false, content: json, resultJson: json });
}

export function failure(callId: string, reason: string): AgentToolResult {
  return create(AgentToolResultSchema, {
    callId,
    isError: true,
    content: reason,
    resultJson: JSON.stringify({ error: reason }),
  });
}

export function safeJson(text: string): JsonValue {
  try {
    return Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(text));
  } catch {
    return { raw: truncate(text, 2_000) };
  }
}

export const busState: unique symbol = Symbol("AgentBus state");

export class AgentBusState {
  host!: BusHost;
  notificationCursor: string | undefined;
  fallbackCursor: string | undefined;
}

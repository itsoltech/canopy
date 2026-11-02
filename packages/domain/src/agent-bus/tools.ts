import { Result, Schema } from "effect";
import { QUESTION_TOOLS, questionsProblem } from "./questions.ts";

/**
 * Agent bus tools: how agents delegate work to each other as side threads (docs/agent-bus.md).
 * Defined once here; the worker exposes them to Claude (in-process MCP server) and Codex
 * (dynamicTools) from the generated JSON Schema, and the gateway decodes calls with the same schemas.
 *
 * Design rules:
 * - spawn/send return immediately (ids); completion arrives as a notification turn or via wait,
 * - wait is bounded and safe to repeat (provider tool timeouts, worker restarts),
 * - results carry ids, never other threads' full transcripts unless asked (read_thread),
 * - two levels only: a main thread (level 0) orchestrates side threads (level 1); side threads
 *   do not get tools to spawn or control other threads (agentBusToolsFor),
 * - scheduling is a platform feature (durable, visible), replacing provider-native timers,
 * - these are the only subagent tools: the harnesses' own (Codex spawn_agent, Claude Agent/Task) are off
 *   (apps/worker/src/providers/native-tools.ts), so descriptions say when to use them for delegation.
 */

const ThreadId = Schema.String.check(Schema.isUUID()).annotate({ description: "Thread id returned by spawn_thread or list_threads." });
const Prompt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000));

const Notify = Schema.Boolean.annotate({
  description:
    "When true (default), you get a new message in this thread once the target finishes the turn, so you can continue other work instead of waiting.",
});

export const ListAgents = Schema.Struct({});

/** Permission modes a side thread may ask for, narrowest first; never broader than the caller's (authorizeBusCall). */
export const SPAWN_PERMISSION_MODES = ["read_only", "ask", "accept_edits", "full_auto"] as const;
export type SpawnPermissionMode = (typeof SPAWN_PERMISSION_MODES)[number];

export const SpawnThread = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
    description: "Short label of the subagent's task, shown to the user (like a task name or description).",
  }),
  prompt: Prompt.annotate({ description: "Task for the new agent. Include everything it needs; it does not see your context unless fork is true." }),
  instructions: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
      description: "Role or standing instructions for the subagent (e.g. 'You are a strict code reviewer...'), added to its system instructions.",
    }),
  ),
  model: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "Model id for the subagent (same provider and account as yours). Defaults to your model. Omit unless the task needs a different one.",
    }),
  ),
  effort: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)).annotate({
      description: "Reasoning effort for the subagent (e.g. low, medium, high), as offered by the model. Defaults to yours.",
    }),
  ),
  permission_mode: Schema.optionalKey(
    Schema.Literals(SPAWN_PERMISSION_MODES).annotate({
      description:
        "What the subagent may do without asking: read_only, ask (risky tools need an answer), accept_edits, full_auto. Defaults to yours; it cannot be broader than yours.",
    }),
  ),
  agent: Schema.optionalKey(Schema.String.annotate({ description: "Agent slug from list_agents. Defaults to your own agent." })),
  fork: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Inherit this thread's history up to its last completed turn. Requires the same provider as yours.",
    }),
  ),
  notify: Schema.optionalKey(Notify),
  interactions: Schema.optionalKey(
    Schema.Literals(["parent", "human"]).annotate({
      description:
        "Who answers the new thread's permission prompts and questions: parent (default) = you, via answer_interaction; human = the user in the UI.",
    }),
  ),
});

export const SendMessage = Schema.Struct({
  thread_id: ThreadId,
  prompt: Prompt.annotate({ description: "Follow-up message for the target thread." }),
  delivery: Schema.optionalKey(
    Schema.Literals(["queue", "steer"]).annotate({
      description: "queue (default): runs as the next turn. steer: joins the turn that is running now.",
    }),
  ),
  notify: Schema.optionalKey(Notify),
});

export const WaitThreads = Schema.Struct({
  thread_ids: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  until: Schema.optionalKey(
    Schema.Literals(["any", "all"]).annotate({ description: "Return when any (default) or all threads are idle." }),
  ),
  timeout_seconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300 })).annotate({
      description: "Max wait (default 120). On timeout you get the current status; call again to keep waiting.",
    }),
  ),
});

export const GetThread = Schema.Struct({ thread_id: ThreadId });

export const ReadThread = Schema.Struct({
  thread_id: ThreadId,
  after_seq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  view: Schema.optionalKey(
    Schema.Literals(["messages", "items"]).annotate({
      description: "messages (default): user and agent messages only. items: every tool call and result.",
    }),
  ),
});

export const ListThreads = Schema.Struct({
  scope: Schema.optionalKey(
    Schema.Literals(["children", "tree"]).annotate({ description: "children (default): threads you spawned. tree: the whole thread tree." }),
  ),
});

export const InterruptThread = Schema.Struct({ thread_id: ThreadId });
export const CloseThread = Schema.Struct({ thread_id: ThreadId });

export const ListInteractions = Schema.Struct({});

export const AnswerInteraction = Schema.Struct({
  request_id: Schema.String.check(Schema.isUUID()).annotate({ description: "Interaction id from list_interactions or a notification." }),
  response: Schema.Literals(["allow", "deny", "answer", "cancel"]).annotate({
    description: "allow/deny for permission prompts, answer for questions and forms, cancel to dismiss.",
  }),
  answer_json: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(100_000)).annotate({ description: "Required for answer: the answer as JSON." }),
  ),
  message: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(10_000)).annotate({ description: "Reason passed to the agent (useful with deny)." }),
  ),
});

const ScheduleTarget = Schema.optionalKey(
  Schema.String.check(Schema.isUUID()).annotate({ description: "Thread to run in: yours (default) or one you spawned." }),
);

export const ScheduleWakeup = Schema.Struct({
  prompt: Prompt.annotate({ description: "Message delivered when the time comes (e.g. what to check)." }),
  delay_seconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 7 * 24 * 3600 })).annotate({ description: "Run after this many seconds." }),
  ),
  at: Schema.optionalKey(Schema.String.annotate({ description: "Run at this time (ISO 8601 with offset). Use either at or delay_seconds." })),
  thread_id: ScheduleTarget,
});

export const ScheduleRecurring = Schema.Struct({
  prompt: Prompt,
  cron: Schema.String.check(Schema.isMinLength(9), Schema.isMaxLength(120)).annotate({
    description: "Five-field cron expression, e.g. '*/30 * * * *'. Minimum interval 5 minutes.",
  }),
  timezone: Schema.optionalKey(Schema.String.annotate({ description: "IANA time zone (default UTC)." })),
  until: Schema.optionalKey(Schema.String.annotate({ description: "Stop after this time (ISO 8601)." })),
  max_runs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
  thread_id: ScheduleTarget,
});

export const ListSchedules = Schema.Struct({});

export const CancelSchedule = Schema.Struct({ schedule_id: Schema.String.check(Schema.isUUID()) });

interface ToolDefinition<S extends Schema.Top> {
  readonly name: string;
  readonly description: string;
  readonly args: S;
  /** Changes state (spawns, sends, stops) as opposed to only reading it. */
  readonly mutates: boolean;
}

const define = <S extends Schema.Top>(tool: ToolDefinition<S>) => tool;

export const AGENT_BUS_TOOLS = {
  ...QUESTION_TOOLS,
  list_agents: define({
    name: "list_agents",
    description: "List agents you can start in a side thread (slug, description, provider, model).",
    args: ListAgents,
    mutates: false,
  }),
  spawn_thread: define({
    name: "spawn_thread",
    description:
      "Start a subagent: delegate a task to a new side thread (a copy of you, optionally with its own instructions, model, effort and " +
      "permissions) in the same working directory. Use this whenever you want to delegate, parallelize or get a second opinion; it is the " +
      "subagent tool here (there is no spawn_agent or Task tool). The user sees the thread and can steer it. Returns at once with " +
      "thread_id and turn_id; its final message comes back to you as a new message when it finishes, or call wait_threads to block for it.",
    args: SpawnThread,
    mutates: true,
  }),
  send_message: define({
    name: "send_message",
    description:
      "Send a follow-up task or message to a thread in your tree (a subagent you spawned, your parent or a sibling): queue runs it as " +
      "the target's next turn, steer joins its running turn. Returns turn_id.",
    args: SendMessage,
    mutates: true,
  }),
  wait_threads: define({
    name: "wait_threads",
    description:
      "Wait for subagents (side threads) to finish their current work: until any (default) or all are done, bounded by timeout_seconds. " +
      "Returns each thread's status, its last turn's outcome and its final message (the result). Call again to keep waiting.",
    args: WaitThreads,
    mutates: false,
  }),
  get_thread: define({
    name: "get_thread",
    description: "Status of a thread: running or queued work, pending questions, model and permissions, last turn's outcome and final message.",
    args: GetThread,
    mutates: false,
  }),
  read_thread: define({
    name: "read_thread",
    description: "Read part of a thread's transcript.",
    args: ReadThread,
    mutates: false,
  }),
  list_threads: define({
    name: "list_threads",
    description: "List your subagents (side threads) or the whole thread tree, with status and last result.",
    args: ListThreads,
    mutates: false,
  }),
  interrupt_thread: define({
    name: "interrupt_thread",
    description: "Interrupt the running turn of a thread you spawned (directly or indirectly).",
    args: InterruptThread,
    mutates: true,
  }),
  close_thread: define({
    name: "close_thread",
    description: "Finish a thread you spawned: stops its work and archives it. Its transcript stays readable.",
    args: CloseThread,
    mutates: true,
  }),
  list_interactions: define({
    name: "list_interactions",
    description: "Permission prompts and questions from your side threads that are waiting for your answer.",
    args: ListInteractions,
    mutates: false,
  }),
  answer_interaction: define({
    name: "answer_interaction",
    description: "Answer a permission prompt or question from one of your side threads. The user can always answer instead.",
    args: AnswerInteraction,
    mutates: true,
  }),
  schedule_wakeup: define({
    name: "schedule_wakeup",
    description: "Run a prompt once, later (e.g. check CI in 10 minutes). Durable: survives restarts.",
    args: ScheduleWakeup,
    mutates: true,
  }),
  schedule_recurring: define({
    name: "schedule_recurring",
    description: "Run a prompt on a cron schedule. Set until or max_runs.",
    args: ScheduleRecurring,
    mutates: true,
  }),
  list_schedules: define({
    name: "list_schedules",
    description: "Schedules of your thread and the threads you spawned.",
    args: ListSchedules,
    mutates: false,
  }),
  cancel_schedule: define({
    name: "cancel_schedule",
    description: "Cancel a schedule of your thread or of a thread you spawned.",
    args: CancelSchedule,
    mutates: true,
  }),
} as const;

/** Tools that only make sense for a thread that can have side threads (level 0). */
const ORCHESTRATOR_ONLY: ReadonlySet<AgentBusToolName> = new Set([
  "spawn_thread",
  "interrupt_thread",
  "close_thread",
  "list_interactions",
  "answer_interaction",
]);

/** Tool names offered to a thread at the given depth (0 = main thread, 1 = side thread). */
export function agentBusToolsFor(depth: number): AgentBusToolName[] {
  return (Object.keys(AGENT_BUS_TOOLS) as AgentBusToolName[]).filter((name) => depth === 0 || !ORCHESTRATOR_ONLY.has(name));
}

export type AgentBusToolName = keyof typeof AGENT_BUS_TOOLS;

/** Decoded arguments per tool. */
export type AgentBusArgs = {
  readonly [K in AgentBusToolName]: Schema.Schema.Type<(typeof AGENT_BUS_TOOLS)[K]["args"]>;
};

export type AgentBusCall = {
  readonly [K in AgentBusToolName]: { readonly tool: K; readonly args: AgentBusArgs[K] };
}[AgentBusToolName];

export function isAgentBusTool(name: string): name is AgentBusToolName {
  return Object.hasOwn(AGENT_BUS_TOOLS, name);
}

/**
 * Strictly decodes a tool call coming from a model. Unknown tools, unknown properties
 * and invalid values are errors (returned to the model as a tool error, never guessed).
 */
export function decodeAgentBusCall(name: string, argumentsJson: string): Result.Result<AgentBusCall, string> {
  if (!isAgentBusTool(name)) return Result.fail(`unknown agent bus tool "${name}"`);
  let raw: unknown;
  try {
    raw = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
  } catch {
    return Result.fail(`${name}: arguments are not valid JSON`);
  }
  const decoded = Schema.decodeUnknownResult(AGENT_BUS_TOOLS[name].args as Schema.Codec<unknown>)(raw, {
    onExcessProperty: "error",
  });
  if (Result.isSuccess(decoded) && name === "ask_user") {
    const problem = questionsProblem((decoded.success as AgentBusArgs["ask_user"]).questions);
    if (problem) return Result.fail(`ask_user: ${problem}`);
  }
  return Result.isSuccess(decoded)
    ? Result.succeed({ tool: name, args: decoded.success } as AgentBusCall)
    : Result.fail(`${name}: ${decoded.failure.message}`);
}

export interface ToolJsonSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Tool specs for providers: Codex dynamicTools ({ name, description, inputSchema }) and the Claude MCP server. */
export function agentBusToolSpecs(names: readonly AgentBusToolName[] = Object.keys(AGENT_BUS_TOOLS) as AgentBusToolName[]): ToolJsonSpec[] {
  return names.map((name) => AGENT_BUS_TOOLS[name]).map((tool) => {
    const document = Schema.toJsonSchemaDocument(tool.args, { onExcessProperty: "error" });
    const schema = document.schema as Record<string, unknown>;
    // Providers require an object schema; an empty Struct compiles to "anything but null".
    const inputSchema = schema["type"] === "object" ? schema : { type: "object", properties: {}, additionalProperties: false };
    return { name: tool.name, description: tool.description, inputSchema: { ...inputSchema, ...definitions(document) } };
  });
}

function definitions(document: { readonly definitions?: Record<string, unknown> }): Record<string, unknown> {
  return document.definitions && Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {};
}

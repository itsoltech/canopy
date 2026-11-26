import { Result, Schema } from "effect";
import { QUESTION_TOOLS, questionsProblem } from "./questions.ts";
import { BACKGROUND_TASK_TOOLS } from "./background-tasks.ts";
import { PR_CHECK_TOOLS } from "./pr-checks.ts";
import { TASK_TOOLS } from "./tasks.ts";
import { isEntityId } from "../computers.ts";
import { IMAGE_TOOLS } from "./images.ts";
import { SECRET_TOOLS, requestSecretProblem } from "./secrets.ts";
import { DELEGATING_BOT_MESSAGE_GUIDANCE, SUBAGENT_REPORTING_RULES } from "./communication.ts";
import { RENDER_VISUAL_MAX_ARGUMENTS, renderVisualProblem, renderHtmlProblem, VISUAL_TOOLS } from "./visuals.ts";
import { HTML_DOCUMENT_BYTES, htmlBytes } from "../visuals/html-source.ts";
import { SETTINGS_GUIDE_TOOL, settingsGuide } from "./settings-guide.ts";
import { switchWorktree } from "./worktree.ts";
import { ListAgents, Notify, Prompt, SpawnThread, StartThread } from "./thread-creation.ts";

export { RequestSecret } from "./secrets.ts";

export { ListAgents, SpawnThread, StartThread } from "./thread-creation.ts";

export { SPAWN_PERMISSION_MODES, type SpawnPermissionMode } from "../permission-modes.ts";

/**
 * Agent bus tools: how agents delegate work and start independent threads (docs/agent-bus.md).
 * Defined once here; the worker exposes them to Claude (in-process MCP server) and Codex
 * (dynamicTools) from the generated JSON Schema, and the gateway decodes calls with the same schemas.
 *
 * Design rules:
 * - spawn/start/send return immediately (ids); completion arrives as a platform steer (or a turn) or via wait,
 * - wait is bounded and safe to repeat (provider tool timeouts, worker restarts),
 * - results carry ids, never other threads' full transcripts unless asked (read_thread),
 * - two levels only: a main thread (level 0) orchestrates side threads (level 1); side threads
 *   do not get tools to start or control other threads (agentBusToolsFor),
 * - scheduling is a platform feature (durable, visible), replacing provider-native timers,
 * - these are the only subagent tools: the harnesses' own (Codex spawn_agent, Claude Agent/Task) are off
 *   (apps/worker/src/providers/native-tools.ts), so descriptions say when to use them for delegation.
 */

const ThreadId = Schema.String.check(Schema.makeFilter(isEntityId)).annotate({
  description: "Thread id returned by spawn_thread or list_threads, including its computer suffix.",
});

const AnyThreadId = Schema.String.check(Schema.makeFilter(isEntityId)).annotate({
  description:
    "Thread id from spawn_thread, start_thread, list_threads (scope all finds the user's threads by title), or a thread the user mentioned.",
});

export const SendMessage = Schema.Struct({
  thread_id: AnyThreadId,
  target_kind: Schema.optionalKey(
    Schema.Literals(["thread", "bot"]).annotate({
      description: "thread (default), or bot using a bot id from list_agents.",
    }),
  ),
  prompt: Prompt.annotate({ description: "Follow-up message for the target thread." }),
  delivery: Schema.optionalKey(
    Schema.Literals(["queue", "steer"]).annotate({
      description:
        "Defaults to steer for a running parent/ancestor or subagent, otherwise queue. Use steer for clarifications to ongoing work; queue explicitly requests a separate next turn. A steer that cannot join falls back to queue. A waiting recipient receives it through wait_threads.",
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

export const GetThread = Schema.Struct({ thread_id: AnyThreadId });

export const ReadThread = Schema.Struct({
  thread_id: AnyThreadId,
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
    Schema.Literals(["children", "tree", "all"]).annotate({
      description:
        "children (default): threads you spawned. tree: the whole thread tree. all: every thread of the user (any project and worker), " +
        "most recent first, with its project and worker; use query to find one by title.",
    }),
  ),
  query: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "scope all: words of the thread's title (fuzzy match), best match first.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
      description: "scope all: at most this many (default 20).",
    }),
  ),
});

export const InterruptThread = Schema.Struct({ thread_id: ThreadId });
export const CloseThread = Schema.Struct({ thread_id: ThreadId });

export const ListInteractions = Schema.Struct({});

export const AnswerInteraction = Schema.Struct({
  request_id: ThreadId.annotate({
    description: "Interaction id from list_interactions or a notification, including its computer suffix.",
  }),
  response: Schema.Literals(["allow", "deny", "answer", "cancel"]).annotate({
    description: "allow/deny for permission prompts, answer for questions and forms, cancel to dismiss.",
  }),
  answer_json: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(100_000)).annotate({
      description: "Required for answer: the answer as JSON.",
    }),
  ),
  message: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(10_000)).annotate({
      description: "Reason passed to the agent (useful with deny).",
    }),
  ),
});

const ScheduleTarget = Schema.optionalKey(
  Schema.String.check(Schema.isUUID()).annotate({
    description: "Thread to run in: yours (default) or one you spawned.",
  }),
);

export const ScheduleWakeup = Schema.Struct({
  prompt: Prompt.annotate({ description: "Message delivered when the time comes (e.g. what to check)." }),
  delay_seconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 7 * 24 * 3600 })).annotate({
      description: "Run after this many seconds.",
    }),
  ),
  at: Schema.optionalKey(
    Schema.String.annotate({ description: "Run at this time (ISO 8601 with offset). Use either at or delay_seconds." }),
  ),
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
  ...IMAGE_TOOLS,
  ...VISUAL_TOOLS,
  [SETTINGS_GUIDE_TOOL]: settingsGuide,
  switch_worktree: switchWorktree,
  ...SECRET_TOOLS,
  // The thread's task list, pinned above the composer: tasks.ts.
  ...TASK_TOOLS,
  list_agents: define({
    name: "list_agents",
    description:
      "Find projects, workers and configured workspaces for start_thread. Lists provider instances, models, reasoning efforts and speeds for the current or selected worker. " +
      "Use spawn_thread for side delegation and start_thread for independent tasks. Also lists linked computers by machine name, their projects, workspaces, workers and bots. " +
      "Remote operations fail immediately if their computer is unreachable or needs an update.",
    args: ListAgents,
    mutates: false,
  }),
  spawn_thread: define({
    name: "spawn_thread",
    description:
      "Start a subagent: delegate a task to a new side thread, inheriting your working directory/worktree unless workspace_mode chooses another placement. By default a copy of you; it can run on " +
      "another provider, model and effort (any provider instance from list_agents), with its own instructions " +
      "and the permissions selected by the owner (same as yours by default). Use this whenever you want to delegate, parallelize or get a second opinion; it is the subagent tool here " +
      "(there is no spawn_agent or Task tool). The user sees the thread and can steer it. Returns at once with thread_id and turn_id; " +
      "its final message is reported to you automatically when it finishes, or call wait_threads to wait for it.",
    args: SpawnThread,
    mutates: true,
  }),
  start_thread: define({
    name: "start_thread",
    description:
      "Start an independent main thread and queue its first task in one of the user's configured placements. " +
      "Omit project, worker and workspace to use your current placement. Call list_agents to discover destinations and models. " +
      "Include the context the task needs. Returns thread_id and turn_id, and reports the outcome to you when the first turn finishes by default. " +
      "Use spawn_thread to delegate within your thread tree.",
    args: StartThread,
    mutates: true,
  }),
  message_delegating_bot: define({
    name: "message_delegating_bot",
    description: DELEGATING_BOT_MESSAGE_GUIDANCE,
    args: Schema.Struct({ text: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(80_000)) }),
    mutates: true,
  }),
  send_message: define({
    name: "send_message",
    description:
      "Send a message to another thread's agent, as the user would: a subagent you spawned, your parent, a sibling, or any other thread " +
      "of the user (find it with list_threads scope all, or one the user mentioned). queue runs it as the target's next turn, steer joins " +
      "its running turn. A running parent/ancestor or subagent defaults to steer; a waiting recipient receives it in wait_threads. " +
      "Clarifications belong in the running turn; reserve queue for a separate task. Do not send acknowledgments or requests to finalize work already reported. " +
      "The target sees your thread as sender; with notify you get its reply when that turn ends.\n\n" +
      SUBAGENT_REPORTING_RULES,
    args: SendMessage,
    mutates: true,
  }),
  wait_threads: define({
    name: "wait_threads",
    description:
      "Wait for subagents (side threads) to finish their current work: until any (default) or all are done, bounded by timeout_seconds. " +
      "Returns each thread's status, last turn's outcome and final message (reported automatically). Returns early for questions or messages " +
      "from a waited-on thread; messages are included in messages and consumed without another input. Call again to keep waiting.",
    args: WaitThreads,
    mutates: false,
  }),
  get_thread: define({
    name: "get_thread",
    description:
      "Status of a thread (yours, in your tree or any other of the user's): running or queued work, pending questions, provider, model and " +
      "permissions, last turn's outcome and final message. Also returns and consumes pending messages addressed to you from that thread in messages.",
    args: GetThread,
    mutates: false,
  }),
  read_thread: define({
    name: "read_thread",
    description:
      "Read part of a thread's transcript. Pending messages addressed to you that the page covers are included in messages and consumed.",
    args: ReadThread,
    mutates: false,
  }),
  list_threads: define({
    name: "list_threads",
    description:
      "List your subagents (side threads), the whole thread tree, or (scope all) any of the user's threads to message, with status and last result.",
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
    description:
      "Answer a permission prompt or question from one of your side threads. The user can always answer instead.",
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
  // The thread's own background work (list, inspect, stop): background-tasks.ts.
  ...BACKGROUND_TASK_TOOLS,
  // CI checks of the thread's linked pull requests (watch, list, cancel): pr-checks.ts.
  ...PR_CHECK_TOOLS,
} as const;

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

export const AGENT_BUS_TOOL_NAMES: readonly AgentBusToolName[] = Object.keys(AGENT_BUS_TOOLS).filter(isAgentBusTool);

/**
 * Strictly decodes a tool call coming from a model. Unknown tools, unknown properties
 * and invalid values are errors (returned to the model as a tool error, never guessed).
 */
export function decodeAgentBusCall(name: string, argumentsJson: string): Result.Result<AgentBusCall, string> {
  if (!isAgentBusTool(name)) return Result.fail(`unknown agent bus tool "${name}"`);

  if (
    name === "render_html" &&
    (argumentsJson.length > HTML_DOCUMENT_BYTES + 8192 || htmlBytes(argumentsJson) > HTML_DOCUMENT_BYTES + 8192)
  )
    return Result.fail("render_html: arguments exceed 512 KiB plus 8 KiB metadata");

  if (name === "render_visual" && argumentsJson.length > RENDER_VISUAL_MAX_ARGUMENTS)
    return Result.fail("render_visual: arguments are larger than the 128 KiB spec limit");
  let raw: unknown;

  try {
    raw = argumentsJson.trim() === "" ? {} : JSON.parse(argumentsJson);
  } catch {
    return Result.fail(`${name}: arguments are not valid JSON`);
  }

  // SAFETY: only widens the indexed union of argument schemas, which TypeScript cannot call; the codec stays the one
  // registered for `name`.
  const decoded = Schema.decodeUnknownResult(AGENT_BUS_TOOLS[name].args as Schema.Codec<unknown>)(raw, {
    onExcessProperty: "error",
  });

  if (Result.isFailure(decoded)) return Result.fail(`${name}: ${decoded.failure.message}`);
  // SAFETY: `decoded` came from AGENT_BUS_TOOLS[name].args, and AgentBusArgs[name] is that schema's Type.
  const call = { tool: name, args: decoded.success } as AgentBusCall;

  const problem =
    (call.tool === "ask_user" && questionsProblem(call.args.questions)) ||
    (call.tool === "request_secret" && requestSecretProblem(call.args)) ||
    (call.tool === "render_visual" && renderVisualProblem(call.args)) ||
    (call.tool === "render_html" && renderHtmlProblem(call.args));

  if (problem) return Result.fail(`${call.tool}: ${problem}`);

  return Result.succeed(call);
}

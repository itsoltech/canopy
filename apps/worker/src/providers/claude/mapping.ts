import type { MessageInitShape } from "@bufbuild/protobuf";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTaskKind, ItemDeltaField, ItemStatus, NoticeLevel, TurnOutcome, type BackgroundTaskSchema, type ItemSchema } from "@open-agents/contracts";
import { isAgentBusTool } from "@open-agents/domain";
import type { ThreadEventInit } from "../../journal/index.ts";

/**
 * Claude Agent SDK messages -> platform transcript events (docs/transcript.md), one mapper per session
 * (one Claude Code process, possibly several turns: the platform's and the ones Claude starts itself).
 *
 * - Text and thinking stream as deltas of an item opened at content_block_start
 *   (id `<message id>:<block index>`); the full assistant message completes it.
 * - Tool calls start with the assistant's tool_use block (id = tool_use id) and complete with the
 *   tool_result in the following user message.
 * - The result message carries usage and the outcome (turn_finished).
 * - Background tasks (docs/execution.md): task_started of a backgrounded task opens a background_task item
 *   `bg:<task_id>`, task_notification ends it. They run outside turns, so their events carry no turn id.
 *   Output comes from the task's output file (the runtime reads it and calls taskOutput).
 * - Goals (docs/goals.md): the local answer of /goal ("Goal set: …", "Goal cleared: …") and the evaluator's
 *   verdicts (goalVerdict, read from the session transcript by the runtime) become goal_state events.
 * - Stream events that only rebuild what the full messages carry (partial tool input JSON,
 *   signatures, message boundaries) are not journaled; every other message is, with raw_json.
 */

type ItemInit = MessageInitShape<typeof ItemSchema>;
type Content = NonNullable<ItemInit["content"]>;

/** Platform agent bus tools, served by the worker's in-process MCP server "openagents". */
export const BUS_SERVER = "openagents";
const BUS_PREFIX = `mcp__${BUS_SERVER}__`;

interface OpenBlock {
  readonly itemId: string;
  readonly kind: "text" | "thinking";
  started: boolean;
  done: boolean;
}

interface Block {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A background task with an open item. */
interface LiveTask {
  readonly itemId: string;
  readonly content: Omit<MessageInitShape<typeof BackgroundTaskSchema>, "$typeName">;
  outputFile?: string;
  stopping: boolean;
}

/** Evaluator verdict of a /goal Stop hook (goal_status attachment in the session transcript). */
export interface GoalVerdict {
  readonly met: boolean;
  readonly failed?: boolean;
  readonly sentinel?: boolean;
  readonly condition: string;
  readonly reason?: string;
  readonly iterations?: number;
}

export class ClaudeEventMapper {
  #turnId: string | undefined;
  /** Blocks of the message being streamed, by index. */
  #messageId = "";
  readonly #open = new Map<number, OpenBlock>();
  /** Started tool items by tool_use id, completed by their tool_result. */
  readonly #tools = new Map<string, { readonly parentItemId: string; readonly content: Content }>();
  #lastUuid: string | undefined;
  #interrupted = false;
  /** Fallback ids for text blocks that were not streamed. */
  #unstreamed = 0;
  /** Bash calls with run_in_background, by tool_use id: command, then the output file from the tool result. */
  readonly #backgroundCalls = new Map<string, { command: string; description: string; outputFile?: string }>();
  /** Tasks that started in the foreground and may be moved to the background later. */
  readonly #foreground = new Map<string, { toolUseId: string; description: string; taskType: string; parentTaskId: string; turnId: string }>();
  readonly #tasks = new Map<string, LiveTask>();
  /** Not-met evaluator verdicts of the current goal. */
  #goalChecks = 0;

  constructor(turnId?: string) {
    this.#turnId = turnId;
  }

  /** Turn the next messages belong to (platform or provider turn). */
  beginTurn(turnId: string): void {
    this.#turnId = turnId;
    this.#lastUuid = undefined;
    this.#interrupted = false;
  }

  get turnId(): string | undefined {
    return this.#turnId;
  }

  /** Background tasks with an open item (task ids). */
  get backgroundTasks(): string[] {
    return [...this.#tasks.keys()];
  }

  /** Output file of a live background task, once known. */
  outputFile(taskId: string): string | undefined {
    return this.#tasks.get(taskId)?.outputFile;
  }

  /** The platform asked to stop this task: its end is reported as stopped by the user. */
  markStopping(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (task) task.stopping = true;
    return task !== undefined;
  }

  /** New output of a background task (read from its output file). */
  taskOutput(taskId: string, chunk: string): ThreadEventInit[] {
    const task = this.#tasks.get(taskId);
    if (!task || !chunk) return [];
    return [{ body: { case: "itemDelta", value: { itemId: task.itemId, field: ItemDeltaField.OUTPUT, chunk } } }];
  }

  /** Background tasks still open when the process ended: interrupted with the given reason. */
  endTasks(stopReason: string): ThreadEventInit[] {
    const events = [...this.#tasks.keys()].map((taskId) => this.#endTask(taskId, ItemStatus.INTERRUPTED, { stopReason }, "{}"));
    return events.flatMap((e) => (e ? [e] : []));
  }

  /** Evaluator verdict of the goal (from the session transcript): goal_state. The sentinel marks a fresh goal. */
  goalVerdict(verdict: GoalVerdict): ThreadEventInit[] {
    if (verdict.sentinel) {
      this.#goalChecks = 0;
      return [];
    }
    const nativeStatus = verdict.met ? "met" : verdict.failed ? "failed" : "active";
    if (nativeStatus === "active") this.#goalChecks++;
    const iterations = verdict.iterations ?? this.#goalChecks + (nativeStatus === "active" ? 0 : 1);
    return [
      {
        ...(this.#turnId && { turnId: this.#turnId }),
        rawJson: JSON.stringify({ type: "goal_status", ...verdict }),
        body: { case: "goalState", value: { nativeStatus, objective: verdict.condition, condition: verdict.condition, iterations, lastReason: verdict.reason ?? "" } },
      },
    ];
  }

  /** Last transcript entry of the turn: the fork point for a fork after this turn (resumeSessionAt / upToMessageId). */
  get lastEntry(): string | undefined {
    return this.#lastUuid;
  }

  /** The platform interrupted the turn: its result counts as interrupted, not failed. */
  markInterrupted(): void {
    this.#interrupted = true;
  }

  map(message: SDKMessage): ThreadEventInit[] {
    const rawJson = JSON.stringify(message);
    const event = (body: ThreadEventInit["body"] | undefined): ThreadEventInit =>
      ({ ...(this.#turnId && { turnId: this.#turnId }), ...(body ? { body } : {}), rawJson }) as ThreadEventInit;
    if ("uuid" in message && typeof message.uuid === "string" && (message.type === "assistant" || message.type === "user")) {
      this.#lastUuid = message.uuid;
    }

    switch (message.type) {
      case "stream_event":
        return this.#stream(message.event as unknown as StreamEvent).map((body) => event(body));
      case "assistant": {
        const blocks = message.message.content as unknown as Block[];
        const goal = message.message.model === "<synthetic>" ? goalAnswer(blocks) : undefined;
        return atLeastOne([...this.#assistant(message.message.id, blocks, message.parent_tool_use_id), ...(goal ? [goal] : [])], event);
      }
      case "user": {
        const content = message.message.content;
        if (typeof content === "string") return [event(undefined)];
        return atLeastOne(this.#toolResults(content as unknown as Block[]), event);
      }
      case "result": {
        const finished = event(this.#result(message));
        this.#turnId = undefined; // what follows (background tasks) is outside the turn until the next one begins
        return [finished];
      }
      case "system":
        switch (message.subtype) {
          case "api_retry":
            return [
              event({
                case: "notice",
                value: { level: NoticeLevel.WARNING, code: "api_retry", message: "the provider API failed; retrying", dataJson: rawJson },
              }),
            ];
          case "task_started":
            return [this.#taskStarted(message, rawJson) ?? { ...event(undefined), turnId: "" }];
          case "task_updated":
            return [(message.patch.is_backgrounded ? this.#backgrounded(message.task_id, rawJson) : undefined) ?? { rawJson }];
          case "task_notification": {
            const status = message.status === "completed" ? ItemStatus.COMPLETED : message.status === "failed" ? ItemStatus.FAILED : ItemStatus.INTERRUPTED;
            this.#foreground.delete(message.task_id);
            const ended = this.#endTask(message.task_id, status, { summary: message.summary, outputFile: message.output_file, usage: message.usage }, rawJson);
            return [ended ?? { rawJson }];
          }
          case "task_progress":
          case "background_tasks_changed":
            return [{ rawJson }]; // kept raw; the edges above carry the state
          default:
            return [event(undefined)];
        }
      default: {
        const active = message as { type: string; value?: { condition?: string; iterations?: number; last_reason?: string } | null };
        // active_goal (when Claude Code forwards it): not-met verdicts with iterations; null is left to the transcript verdicts.
        if (active.type === "active_goal" && active.value) {
          return [
            event({
              case: "goalState",
              value: { nativeStatus: "active", objective: active.value.condition ?? "", condition: active.value.condition ?? "", iterations: active.value.iterations ?? 0, lastReason: active.value.last_reason ?? "" },
            }),
          ];
        }
        return [event(undefined)];
      }
    }
  }

  #taskStarted(message: Extract<SDKMessage, { type: "system"; subtype: "task_started" }>, rawJson: string): ThreadEventInit | undefined {
    if (message.skip_transcript || message.ambient) return undefined;
    const pending = {
      toolUseId: message.tool_use_id ?? "",
      description: message.description,
      taskType: message.task_type ?? "",
      parentTaskId: message.parent_task_id ?? "",
      turnId: this.#turnId ?? "",
    };
    this.#foreground.set(message.task_id, pending);
    return message.is_backgrounded ? this.#backgrounded(message.task_id, rawJson) : undefined;
  }

  /** Opens the background item of a task (backgrounded from the start or moved there later). */
  #backgrounded(taskId: string, rawJson: string): ThreadEventInit | undefined {
    const pending = this.#foreground.get(taskId);
    if (!pending || this.#tasks.has(taskId)) return undefined;
    this.#foreground.delete(taskId);
    const call = this.#backgroundCalls.get(pending.toolUseId);
    const content = {
      taskId,
      kind: backgroundKind(pending.taskType),
      description: pending.description,
      command: call?.command ?? "",
      startedInTurnId: pending.turnId,
      parentTaskId: pending.parentTaskId,
      sourceItemId: pending.toolUseId,
    };
    const task: LiveTask = { itemId: `bg:${taskId}`, content, stopping: false, ...(call?.outputFile && { outputFile: call.outputFile }) };
    this.#tasks.set(taskId, task);
    return {
      rawJson,
      ...(pending.turnId && { turnId: pending.turnId }),
      body: { case: "itemStarted", value: { item: { itemId: task.itemId, status: ItemStatus.IN_PROGRESS, content: { case: "backgroundTask", value: content } } } },
    };
  }

  #endTask(
    taskId: string,
    status: ItemStatus,
    detail: { summary?: string; outputFile?: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } | undefined; stopReason?: string },
    rawJson: string,
  ): ThreadEventInit | undefined {
    const task = this.#tasks.get(taskId);
    if (!task) return undefined;
    this.#tasks.delete(taskId);
    const stopReason = status === ItemStatus.INTERRUPTED ? (task.stopping ? "stopped_by_user" : (detail.stopReason ?? "stopped")) : status === ItemStatus.FAILED ? "error" : "";
    return {
      rawJson,
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId: task.itemId,
            status,
            content: {
              case: "backgroundTask",
              value: {
                ...task.content,
                ...(stopReason && { stopReason }),
                progress: {
                  summary: detail.summary ?? "",
                  ...(detail.usage && { totalTokens: BigInt(detail.usage.total_tokens), toolUses: detail.usage.tool_uses, durationMs: BigInt(detail.usage.duration_ms) }),
                },
              },
            },
          },
        },
      },
    };
  }

  #stream(e: StreamEvent): NonNullable<ThreadEventInit["body"]>[] {
    switch (e.type) {
      case "message_start":
        this.#messageId = e.message?.id ?? this.#messageId;
        this.#open.clear();
        return [];
      case "content_block_start": {
        const type = e.content_block?.type;
        if (type !== "text" && type !== "thinking") return [];
        const block: OpenBlock = { itemId: `${this.#messageId}:${e.index}`, kind: type, started: false, done: false };
        this.#open.set(e.index ?? 0, block);
        return [];
      }
      case "content_block_delta": {
        const block = this.#open.get(e.index ?? 0);
        const chunk = e.delta?.type === "text_delta" ? e.delta.text : e.delta?.type === "thinking_delta" ? e.delta.thinking : undefined;
        if (!block || !chunk) return []; // redacted thinking streams empty deltas
        const bodies: NonNullable<ThreadEventInit["body"]>[] = [];
        if (!block.started) {
          block.started = true;
          bodies.push({ case: "itemStarted", value: { item: { itemId: block.itemId, status: ItemStatus.IN_PROGRESS, content: emptyContent(block.kind) } } });
        }
        bodies.push({ case: "itemDelta", value: { itemId: block.itemId, field: ItemDeltaField.TEXT, chunk } });
        return bodies;
      }
      default:
        return []; // partial tool input, signatures, message boundaries: carried by the full messages
    }
  }

  #assistant(messageId: string, blocks: Block[], parentToolUseId: string | null): NonNullable<ThreadEventInit["body"]>[] {
    const parentItemId = parentToolUseId ?? "";
    return blocks.flatMap((block): NonNullable<ThreadEventInit["body"]>[] => {
      switch (block.type) {
        case "text":
        case "thinking": {
          const text = String(block.type === "text" ? block["text"] : block["thinking"]);
          const open = this.#takeOpen(messageId, block.type);
          if (!text) return []; // redacted thinking: nothing to show
          const itemId = open?.itemId ?? `${messageId}:${block.type}:${++this.#unstreamed}`;
          return [{ case: "itemCompleted", value: { item: { itemId, parentItemId, status: ItemStatus.COMPLETED, content: textContent(block.type, text) } } }];
        }
        case "tool_use": {
          const id = String(block["id"]);
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          if (input["run_in_background"] === true) {
            this.#backgroundCalls.set(id, { command: String(input["command"] ?? ""), description: String(input["description"] ?? "") });
          }
          const content = toolContent(String(block["name"]), block["input"]);
          this.#tools.set(id, { parentItemId, content });
          return [{ case: "itemStarted", value: { item: { itemId: id, parentItemId, status: ItemStatus.IN_PROGRESS, content } } }];
        }
        default:
          return [];
      }
    });
  }

  #toolResults(blocks: Block[]): NonNullable<ThreadEventInit["body"]>[] {
    return blocks.flatMap((block): NonNullable<ThreadEventInit["body"]>[] => {
      if (block.type !== "tool_result") return [];
      const id = String(block["tool_use_id"]);
      const started = this.#tools.get(id);
      if (!started) return [];
      this.#tools.delete(id);
      const failed = block["is_error"] === true;
      const output = resultText(block["content"]);
      const call = this.#backgroundCalls.get(id);
      const file = /Output is being written to: (\S+?\.output)/.exec(output)?.[1];
      if (call && file) {
        call.outputFile = file;
        for (const task of this.#tasks.values()) if (task.content.sourceItemId === id) task.outputFile = file;
      }
      const item: ItemInit = {
        itemId: id,
        parentItemId: started.parentItemId,
        status: failed ? ItemStatus.FAILED : ItemStatus.COMPLETED,
        content: withOutput(started.content, output, failed),
      };
      return [{ case: "itemCompleted", value: { item } }];
    });
  }

  #result(message: Extract<SDKMessage, { type: "result" }>): NonNullable<ThreadEventInit["body"]> {
    const usage = message.usage as unknown as Record<string, number | undefined>;
    const outcome = message.subtype === "success" && !message.is_error ? TurnOutcome.COMPLETED : this.#interrupted ? TurnOutcome.INTERRUPTED : TurnOutcome.FAILED;
    const reason = message.subtype === "success" ? (message.is_error ? message.result : "") : message.errors.join("; ") || message.subtype;
    return {
      case: "turnFinished",
      value: {
        outcome,
        providerTurnRef: this.#lastUuid ?? "",
        ...(outcome !== TurnOutcome.COMPLETED && reason && { reason }),
        usage: {
          inputTokens: BigInt((usage["input_tokens"] ?? 0) + (usage["cache_creation_input_tokens"] ?? 0) + (usage["cache_read_input_tokens"] ?? 0)),
          outputTokens: BigInt(usage["output_tokens"] ?? 0),
          cachedInputTokens: BigInt(usage["cache_read_input_tokens"] ?? 0),
          costUsd: message.total_cost_usd ?? 0,
        },
      },
    };
  }

  /** The streamed block an assistant block completes: the first open, unfinished one of its kind. */
  #takeOpen(messageId: string, kind: "text" | "thinking"): OpenBlock | undefined {
    if (messageId !== this.#messageId) return undefined;
    const block = [...this.#open.entries()].sort(([a], [b]) => a - b).map(([, b]) => b).find((b) => b.kind === kind && !b.done);
    if (block) block.done = true;
    return block;
  }
}

/** Messages that only come within a turn: one arriving between turns means Claude started a turn. */
export function startsTurn(message: { type: string; subtype?: string }): boolean {
  return (message.type === "system" && message.subtype === "init") || message.type === "assistant" || message.type === "stream_event" || message.type === "result";
}

function backgroundKind(taskType: string): BackgroundTaskKind {
  switch (taskType) {
    case "local_agent":
      return BackgroundTaskKind.AGENT;
    case "local_workflow":
      return BackgroundTaskKind.WORKFLOW;
    default:
      return BackgroundTaskKind.SHELL;
  }
}

/** The local answer of /goal (a synthetic assistant message): goal set or cleared. */
function goalAnswer(blocks: Block[]): NonNullable<ThreadEventInit["body"]> | undefined {
  const text = blocks.map((b) => (b.type === "text" ? String(b["text"]) : "")).join("");
  const set = /^Goal set: ([\s\S]+)$/.exec(text)?.[1];
  if (set) return { case: "goalState", value: { nativeStatus: "active", objective: set, condition: set } };
  const cleared = /^Goal cleared: ([\s\S]+)$/.exec(text)?.[1];
  if (cleared) return { case: "goalState", value: { nativeStatus: "cleared", cleared: true, objective: cleared, condition: cleared } };
  return undefined;
}

/** Full messages are never dropped: without mapped content they are kept as raw_json only. */
function atLeastOne(bodies: NonNullable<ThreadEventInit["body"]>[], event: (body: ThreadEventInit["body"] | undefined) => ThreadEventInit): ThreadEventInit[] {
  return bodies.length > 0 ? bodies.map((body) => event(body)) : [event(undefined)];
}

interface StreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly message?: { id?: string };
  readonly content_block?: { type?: string };
  readonly delta?: { type?: string; text?: string; thinking?: string };
}

function emptyContent(kind: "text" | "thinking"): Content {
  return kind === "text" ? { case: "agentMessage", value: { text: "" } } : { case: "reasoning", value: { text: "" } };
}

function textContent(kind: "text" | "thinking", text: string): Content {
  return kind === "text" ? { case: "agentMessage", value: { text } } : { case: "reasoning", value: { text } };
}

/** Claude Code tools as platform items; anything unknown is a generic tool call. */
export function toolContent(name: string, input: unknown): Content {
  const args = (input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  if (name.startsWith(BUS_PREFIX) && isAgentBusTool(name.slice(BUS_PREFIX.length))) {
    return { case: "agentBusCall", value: { toolName: name.slice(BUS_PREFIX.length), argumentsJson: JSON.stringify(args) } };
  }
  switch (name) {
    case "Bash":
    case "PowerShell":
      return { case: "commandExecution", value: { command: str("command") } };
    case "Write":
      return { case: "fileChange", value: { changes: [{ path: str("file_path"), kind: "add", diff: prefixLines(str("content"), "+") }] } };
    case "Edit":
      return { case: "fileChange", value: { changes: [{ path: str("file_path"), kind: "update", diff: editDiff(str("old_string"), str("new_string")) }] } };
    case "MultiEdit": {
      const edits = Array.isArray(args["edits"]) ? (args["edits"] as { old_string?: string; new_string?: string }[]) : [];
      const diff = edits.map((e) => editDiff(e.old_string ?? "", e.new_string ?? "")).join("\n");
      return { case: "fileChange", value: { changes: [{ path: str("file_path"), kind: "update", diff }] } };
    }
    case "NotebookEdit":
      return { case: "fileChange", value: { changes: [{ path: str("notebook_path"), kind: "update", diff: prefixLines(str("new_source"), "+") }] } };
    case "WebSearch":
      return { case: "webSearch", value: { query: str("query") } };
    case "TodoWrite": {
      const todos = Array.isArray(args["todos"]) ? (args["todos"] as { content?: string; status?: string }[]) : [];
      return { case: "todoList", value: { items: todos.map((t) => ({ text: t.content ?? "", status: t.status ?? "" })) } };
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return { case: "toolCall", value: { server: mcp?.[1] ?? "", name: mcp?.[2] ?? name, inputJson: JSON.stringify(args) } };
    }
  }
}

function withOutput(content: Content, output: string, failed: boolean): Content {
  switch (content.case) {
    case "commandExecution":
      return { case: "commandExecution", value: { ...content.value, output } };
    case "toolCall":
      return { case: "toolCall", value: { ...content.value, output, isError: failed } };
    case "agentBusCall":
      return { case: "agentBusCall", value: { ...content.value, resultJson: output, isError: failed } };
    case "webSearch":
      return { case: "webSearch", value: { ...content.value, resultsJson: output } };
    default:
      return content;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string; tool_name?: string }) => (c.type === "text" ? (c.text ?? "") : c.type === "tool_reference" ? `[${c.tool_name}]` : `[${c.type}]`))
    .join("\n");
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function editDiff(before: string, after: string): string {
  return [prefixLines(before, "-"), prefixLines(after, "+")].filter(Boolean).join("\n");
}

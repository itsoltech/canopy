import type { MessageInitShape } from "@bufbuild/protobuf";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ItemDeltaField, ItemStatus, NoticeLevel, TurnOutcome, type ItemSchema } from "@open-agents/contracts";
import { isAgentBusTool } from "@open-agents/domain";
import type { ThreadEventInit } from "../../journal/index.ts";

/**
 * Claude Agent SDK messages -> platform transcript events (docs/transcript.md), one mapper per turn.
 *
 * - Text and thinking stream as deltas of an item opened at content_block_start
 *   (id `<message id>:<block index>`); the full assistant message completes it.
 * - Tool calls start with the assistant's tool_use block (id = tool_use id) and complete with the
 *   tool_result in the following user message.
 * - The result message carries usage and the outcome (turn_finished).
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

export class ClaudeEventMapper {
  readonly #turnId: string;
  /** Blocks of the message being streamed, by index. */
  #messageId = "";
  readonly #open = new Map<number, OpenBlock>();
  /** Started tool items by tool_use id, completed by their tool_result. */
  readonly #tools = new Map<string, { readonly parentItemId: string; readonly content: Content }>();
  #lastUuid: string | undefined;
  #interrupted = false;
  /** Fallback ids for text blocks that were not streamed. */
  #unstreamed = 0;

  constructor(turnId: string) {
    this.#turnId = turnId;
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
      ({ turnId: this.#turnId, ...(body ? { body } : {}), rawJson }) as ThreadEventInit;
    if ("uuid" in message && typeof message.uuid === "string" && (message.type === "assistant" || message.type === "user")) {
      this.#lastUuid = message.uuid;
    }

    switch (message.type) {
      case "stream_event":
        return this.#stream(message.event as unknown as StreamEvent).map((body) => event(body));
      case "assistant":
        return atLeastOne(this.#assistant(message.message.id, message.message.content as unknown as Block[], message.parent_tool_use_id), event);
      case "user": {
        const content = message.message.content;
        if (typeof content === "string") return [event(undefined)];
        return atLeastOne(this.#toolResults(content as unknown as Block[]), event);
      }
      case "result":
        return [event(this.#result(message))];
      case "system":
        return message.subtype === "api_retry"
          ? [
              event({
                case: "notice",
                value: { level: NoticeLevel.WARNING, code: "api_retry", message: "the provider API failed; retrying", dataJson: rawJson },
              }),
            ]
          : [event(undefined)];
      default:
        return [event(undefined)];
    }
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

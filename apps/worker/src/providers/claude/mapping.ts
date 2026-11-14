import { ActiveGoal, goalAnswer, isTaskNotificationAck, type GoalVerdict } from "./goal-mapping.ts";
import { claudeLimitError } from "../usage-limits.ts";

export { isTaskNotificationAck, startsTurn, type GoalVerdict } from "./goal-mapping.ts";

import { ClaudeBackgroundMapper } from "./background-mapping.ts";
import { emptyContent, textContent, toolContent, withOutput, resultText } from "./content-mapping.ts";

export { toolContent, withOutput, resultText } from "./content-mapping.ts";

import type { MessageInitShape } from "@bufbuild/protobuf";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ItemDeltaField,
  ItemStatus,
  NoticeLevel,
  TurnEndSource,
  TurnOutcome,
  type ItemSchema,
} from "@canopy/contracts";
import { PLATFORM_SERVER } from "@canopy/domain";
import type { JsonObject } from "@canopy/domain";
import { Match, Schema } from "effect";
import { isString, jsonObject } from "../json.ts";
import type { ThreadEventInit } from "../../journal/index.ts";

/**
 * Claude Agent SDK messages -> platform transcript events (docs/transcript.md), one mapper per session
 * (one Claude Code process, possibly several turns: the platform's and the ones Claude starts itself).
 *
 * - Text and thinking stream as deltas of an item opened at content_block_start
 *   (id `<message id>:<block index>`); the full assistant message completes it.
 * - A top-level message whose message_delta stops with `end_turn` (no tool use) ends the turn's work: its
 *   last text completes again with phase `final_answer` (docs/timeline-folding.md).
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

/** Platform agent bus tools, served by the worker's in-process MCP server "canopy". */
export const BUS_SERVER = PLATFORM_SERVER;

interface OpenBlock {
  readonly itemId: string;
  readonly kind: "text" | "thinking";
  started: boolean;
  done: boolean;
}

type Block = JsonObject;

const decodeBlocks = Schema.decodeUnknownSync(Schema.Array(Schema.JsonObject));

export class ClaudeEventMapper {
  readonly #background = new ClaudeBackgroundMapper();
  #turnId: string | undefined;
  /** Blocks of the message being streamed, by index. */
  #messageId = "";
  readonly #open = new Map<number, OpenBlock>();
  /** Started tool items by tool_use id, completed by their tool_result. */
  readonly #tools = new Map<string, { readonly parentItemId: string; readonly content: Content }>();
  #lastUuid: string | undefined;
  #interrupted = false;
  /** Last top-level text of the streamed message, re-completed as the answer when the message ends the turn. */
  #lastText: { readonly messageId: string; readonly itemId: string; readonly text: string } | undefined;
  /** Top-level message that stopped with `end_turn`, when its full content arrives after the stop reason. */
  #finalMessage = "";
  /** Fallback ids for text blocks that were not streamed. */
  #unstreamed = 0;
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

  /** The turn goes on after its result (a steered message runs next): what follows still belongs to it. */
  continueTurn(turnId: string): void {
    this.#turnId = turnId;
  }

  get turnId(): string | undefined {
    return this.#turnId;
  }

  get backgroundTasks(): string[] {
    return this.#background.backgroundTasks;
  }
  outputFile(taskId: string): string | undefined {
    return this.#background.outputFile(taskId);
  }
  markStopping(taskId: string): boolean {
    return this.#background.markStopping(taskId);
  }
  taskOutput(taskId: string, chunk: string): ThreadEventInit[] {
    return this.#background.taskOutput(taskId, chunk);
  }
  endTasks(stopReason: string): ThreadEventInit[] {
    return this.#background.endTasks(stopReason);
  }

  /** Evaluator verdict of the goal (from the session transcript): goal_state. The sentinel marks a fresh goal. */
  goalVerdict(verdict: GoalVerdict): ThreadEventInit[] {
    if (verdict.sentinel) {
      this.#goalChecks = 0;

      return [];
    }

    const nativeStatus = Match.value(verdict).pipe(
      Match.when({ met: true }, () => "met"),
      Match.when({ failed: true }, () => "failed"),
      Match.orElse(() => "active"),
    );

    if (nativeStatus === "active") this.#goalChecks++;
    const iterations = verdict.iterations ?? this.#goalChecks + (nativeStatus === "active" ? 0 : 1);

    return [
      {
        ...(this.#turnId && { turnId: this.#turnId }),
        rawJson: JSON.stringify({ type: "goal_status", ...verdict }),
        body: {
          case: "goalState",
          value: {
            nativeStatus,
            objective: verdict.condition,
            condition: verdict.condition,
            iterations,
            lastReason: verdict.reason ?? "",
          },
        },
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

    const event = (body: ThreadEventInit["body"] | undefined): ThreadEventInit => ({
      ...(this.#turnId && { turnId: this.#turnId }),
      ...(body && { body }),
      rawJson,
    });

    if ("uuid" in message && isString(message.uuid) && (message.type === "assistant" || message.type === "user")) {
      this.#lastUuid = message.uuid;
    }

    switch (message.type) {
      case "stream_event":
        return this.#stream(Schema.decodeUnknownSync(StreamEvent)(message.event), message.parent_tool_use_id).map(
          (body) => event(body),
        );
      case "assistant": {
        const blocks = decodeBlocks(message.message.content);
        const goal = message.message.model === "<synthetic>" ? goalAnswer(blocks) : undefined;

        return atLeastOne(
          [...this.#assistant(message.message.id, blocks, message.parent_tool_use_id), ...(goal ? [goal] : [])],
          event,
        );
      }

      case "user": {
        const content = message.message.content;

        if (isString(content)) return [event(undefined)];

        return atLeastOne(this.#toolResults(decodeBlocks(content)), event);
      }

      case "result": {
        // On resume Claude acknowledges an old stopped task without calling the model, before it consumes
        // the new input. This result belongs to the notification, not to the pending platform turn.
        if (isTaskNotificationAck(message)) return [{ rawJson }];
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
                value: {
                  level: NoticeLevel.WARNING,
                  code: "api_retry",
                  message: "the provider API failed; retrying",
                  dataJson: rawJson,
                },
              }),
            ];
          case "task_started":
            return [
              this.#background.taskStarted(message, rawJson, this.#turnId) ?? { ...event(undefined), turnId: "" },
            ];
          case "task_updated":
            return [
              (message.patch.is_backgrounded ? this.#background.backgrounded(message.task_id, rawJson) : undefined) ?? {
                rawJson,
              },
            ];
          case "task_notification": {
            const status = Match.value(message.status).pipe(
              Match.when("completed", () => ItemStatus.COMPLETED),
              Match.when("failed", () => ItemStatus.FAILED),
              Match.orElse(() => ItemStatus.INTERRUPTED),
            );

            this.#background.forgetForeground(message.task_id);

            const ended = this.#background.endTask(
              message.task_id,
              status,
              { summary: message.summary, outputFile: message.output_file, usage: message.usage },
              rawJson,
            );

            return [ended ?? { rawJson }];
          }

          case "task_progress":
          case "background_tasks_changed":
            return [{ rawJson }]; // kept raw; the edges above carry the state
          default:
            return [event(undefined)];
        }

      default: {
        const active = Schema.decodeUnknownSync(ActiveGoal)(message);

        // active_goal (when Claude Code forwards it): not-met verdicts with iterations; null is left to the transcript verdicts.
        if (active.type === "active_goal" && active.value) {
          return [
            event({
              case: "goalState",
              value: {
                nativeStatus: "active",
                objective: active.value.condition ?? "",
                condition: active.value.condition ?? "",
                iterations: active.value.iterations ?? 0,
                lastReason: active.value.last_reason ?? "",
              },
            }),
          ];
        }

        return [event(undefined)];
      }
    }
  }

  #stream(e: StreamEvent, parentToolUseId: string | null): NonNullable<ThreadEventInit["body"]>[] {
    switch (e.type) {
      case "message_delta":
        return e.delta?.stop_reason === "end_turn" && !parentToolUseId ? this.#endTurn() : [];
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

        const chunk = Match.value(e.delta?.type).pipe(
          Match.when("text_delta", () => e.delta?.text),
          Match.when("thinking_delta", () => e.delta?.thinking),
          Match.orElse(() => undefined),
        );

        if (!block || !chunk) return []; // redacted thinking streams empty deltas
        const bodies: NonNullable<ThreadEventInit["body"]>[] = [];

        if (!block.started) {
          block.started = true;
          bodies.push({
            case: "itemStarted",
            value: {
              item: { itemId: block.itemId, status: ItemStatus.IN_PROGRESS, content: emptyContent(block.kind) },
            },
          });
        }

        bodies.push({ case: "itemDelta", value: { itemId: block.itemId, field: ItemDeltaField.TEXT, chunk } });

        return bodies;
      }

      default:
        return []; // partial tool input, signatures, message boundaries: carried by the full messages
    }
  }

  #assistant(
    messageId: string,
    blocks: readonly Block[],
    parentToolUseId: string | null,
  ): NonNullable<ThreadEventInit["body"]>[] {
    const parentItemId = parentToolUseId ?? "";

    return blocks.flatMap((block): NonNullable<ThreadEventInit["body"]>[] => {
      switch (block["type"]) {
        case "text":
        case "thinking": {
          const text = String(block["type"] === "text" ? block["text"] : block["thinking"]);
          const open = this.#takeOpen(messageId, block["type"]);

          if (!text) return []; // redacted thinking: nothing to show
          const itemId = open?.itemId ?? `${messageId}:${block["type"]}:${++this.#unstreamed}`;
          const top = block["type"] === "text" && !parentItemId;

          if (top) this.#lastText = { messageId, itemId, text };
          const content = textContent(block["type"], text, top && messageId === this.#finalMessage);

          return [
            { case: "itemCompleted", value: { item: { itemId, parentItemId, status: ItemStatus.COMPLETED, content } } },
          ];
        }

        case "tool_use": {
          const id = String(block["id"]);
          const input = jsonObject(block["input"]) ?? {};

          if (input["run_in_background"] === true) {
            this.#background.recordCall(id, String(input["command"] ?? ""), String(input["description"] ?? ""));
          }

          const content = toolContent(String(block["name"]), block["input"]);
          this.#tools.set(id, { parentItemId, content });

          return [
            {
              case: "itemStarted",
              value: { item: { itemId: id, parentItemId, status: ItemStatus.IN_PROGRESS, content } },
            },
          ];
        }

        default:
          return [];
      }
    });
  }

  /** The streamed top-level message stopped with `end_turn`: its last completed text is the turn's answer. */
  #endTurn(): NonNullable<ThreadEventInit["body"]>[] {
    this.#finalMessage = this.#messageId;
    const last = this.#lastText;

    if (!last || last.messageId !== this.#messageId) return [];
    const content = textContent("text", last.text, true);

    return [{ case: "itemCompleted", value: { item: { itemId: last.itemId, status: ItemStatus.COMPLETED, content } } }];
  }

  #toolResults(blocks: readonly Block[]): NonNullable<ThreadEventInit["body"]>[] {
    return blocks.flatMap((block): NonNullable<ThreadEventInit["body"]>[] => {
      if (block["type"] !== "tool_result") return [];
      const id = String(block["tool_use_id"]);
      const started = this.#tools.get(id);

      if (!started) return [];
      this.#tools.delete(id);
      const failed = block["is_error"] === true;
      const output = resultText(block["content"]);
      this.#background.recordOutput(id, output);

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
    const usage = message.usage;

    const outcome =
      message.subtype === "success" && !message.is_error
        ? TurnOutcome.COMPLETED
        : this.#interrupted
          ? TurnOutcome.INTERRUPTED
          : TurnOutcome.FAILED;

    const reason =
      message.subtype === "success"
        ? message.is_error
          ? message.result
          : ""
        : message.errors.join("; ") || message.subtype;

    // An interruption the platform asked for is the user's; an error result is Claude Code's (API error, limits, max turns).
    const source =
      outcome === TurnOutcome.INTERRUPTED
        ? TurnEndSource.USER
        : outcome === TurnOutcome.FAILED
          ? TurnEndSource.HARNESS
          : TurnEndSource.UNSPECIFIED;

    return {
      case: "turnFinished",
      value: {
        outcome,
        source,
        ...(outcome === TurnOutcome.FAILED && {
          errorCode: claudeLimitError(reason)
            ? "usage_limit"
            : message.subtype === "success"
              ? "error_result"
              : message.subtype,
        }),
        providerTurnRef: this.#lastUuid ?? "",
        ...(outcome !== TurnOutcome.COMPLETED && reason && { reason }),
        usage: {
          inputTokens: BigInt(
            (usage["input_tokens"] ?? 0) +
              (usage["cache_creation_input_tokens"] ?? 0) +
              (usage["cache_read_input_tokens"] ?? 0),
          ),
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

    const block = [...this.#open.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, b]) => b)
      .find((b) => b.kind === kind && !b.done);

    if (block) block.done = true;

    return block;
  }
}

/** Full messages are never dropped: without mapped content they are kept as raw_json only. */
function atLeastOne(
  bodies: NonNullable<ThreadEventInit["body"]>[],
  event: (body: ThreadEventInit["body"] | undefined) => ThreadEventInit,
): ThreadEventInit[] {
  return bodies.length > 0 ? bodies.map((body) => event(body)) : [event(undefined)];
}

const StreamEvent = Schema.Struct({
  type: Schema.String,
  index: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
  content_block: Schema.optionalKey(Schema.Struct({ type: Schema.optionalKey(Schema.String) })),
  delta: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      text: Schema.optionalKey(Schema.String),
      thinking: Schema.optionalKey(Schema.String),
      stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});

type StreamEvent = typeof StreamEvent.Type;

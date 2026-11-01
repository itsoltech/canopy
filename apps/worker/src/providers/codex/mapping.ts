import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ServerNotification, v2 } from "@open-agents/codex-protocol";
import {
  BackgroundTaskKind,
  ItemDeltaField,
  ItemStatus,
  NoticeLevel,
  ThreadStatus,
  TurnOrigin,
  TurnOutcome,
  type ItemSchema,
} from "@open-agents/contracts";
import { isAgentBusTool } from "@open-agents/domain";
import type { ThreadEventInit } from "../../journal/index.ts";

/**
 * Codex app-server notifications -> platform transcript events (docs/transcript.md, docs/codex-adapter.md).
 *
 * One mapper per thread. Every notification of the thread yields at least one event: when there is
 * no mapping the event has no body but carries raw_json, so nothing is lost.
 *
 * Background processes (docs/execution.md): a unified exec command still running when its turn completes
 * keeps streaming output and ends later (verified live on 0.164.0). At turn end it gets a background_task item
 * `bg:<command item id>` (output so far, then every later delta, outside the turn); the command item keeps
 * what the turn showed and completes, like the background item, when the process exits.
 */

type ItemInit = MessageInitShape<typeof ItemSchema>;
type CodexItem = v2.ThreadItem;

export interface MapperContext {
  /** Platform turn id for a starting Codex turn: the StartTurn mapping, or a fresh id for provider-started turns. */
  startTurn(codexTurnId: string): string;
  /**
   * Platform turn id of a Codex turn this thread started; undefined for others (e.g. a process of a turn from
   * before a worker restart, or the source's last turn right after a fork). Such events keep no turn link.
   */
  turnId(codexTurnId: string): string | undefined;
  /** Codex turn ids started by the platform (StartTurn); others are provider-started (e.g. goal continuation). */
  isCommandTurn(codexTurnId: string): boolean;
}

/** A command item that may outlive its turn (unified exec process). */
interface RunningCommand {
  readonly codexTurnId: string;
  readonly command: string;
  readonly processId: string;
  /** Output shown so far; carried over to the background item when the turn ends first. */
  output: string;
  /** Set once the turn ended while the process kept running. */
  background?: { readonly itemId: string; stopping: boolean };
}

export class CodexEventMapper {
  readonly #ctx: MapperContext;
  /** Last usage per Codex turn, attached to turn_finished. */
  readonly #usage = new Map<string, v2.TokenUsageBreakdown>();
  /** In-progress command items with a process, by item id. */
  readonly #commands = new Map<string, RunningCommand>();

  constructor(ctx: MapperContext) {
    this.#ctx = ctx;
  }

  /** Background processes still running (task id = Codex process id). */
  get backgroundTasks(): string[] {
    return [...this.#commands.values()].flatMap((c) => (c.background ? [c.processId] : []));
  }

  /** The platform asked to stop this process: its end is reported as stopped by the user. Undefined if not running. */
  markStopping(taskId: string): string | undefined {
    for (const command of this.#commands.values()) {
      if (command.background && command.processId === taskId) {
        command.background.stopping = true;
        return command.processId;
      }
    }
    return undefined;
  }

  map(notification: ServerNotification): ThreadEventInit[] {
    const rawJson = JSON.stringify(notification);
    const event = (codexTurnId: string | null | undefined, body: ThreadEventInit["body"]): ThreadEventInit => {
      const turnId = codexTurnId ? this.#ctx.turnId(codexTurnId) : undefined;
      return { ...(turnId ? { turnId } : {}), ...(body ? { body } : {}), rawJson } as ThreadEventInit;
    };

    switch (notification.method) {
      case "turn/started": {
        const { turn } = notification.params;
        const turnId = this.#ctx.startTurn(turn.id);
        return [
          {
            turnId,
            rawJson,
            body: {
              case: "turnStarted",
              value: {
                providerTurnRef: turn.id,
                origin: this.#ctx.isCommandTurn(turn.id) ? TurnOrigin.COMMAND : TurnOrigin.PROVIDER,
              },
            },
          },
        ];
      }
      case "turn/completed": {
        const { turn } = notification.params;
        const usage = this.#usage.get(turn.id);
        this.#usage.delete(turn.id);
        return [
          ...this.#toBackground(turn.id, rawJson),
          event(turn.id, {
            case: "turnFinished",
            value: {
              outcome: turnOutcome(turn.status),
              providerTurnRef: turn.id,
              ...(turn.error && { reason: turn.error.message }),
              ...(usage && { usage: usageOf(usage) }),
            },
          }),
        ];
      }
      case "thread/status/changed": {
        const status = threadStatus(notification.params.status);
        return [event(undefined, status === undefined ? undefined : { case: "activity", value: { status } })];
      }
      case "item/started":
      case "item/completed": {
        const { item, turnId } = notification.params;
        const completed = notification.method === "item/completed";
        if (item.type === "commandExecution") {
          const running = this.#commands.get(item.id);
          if (completed && running?.background) return this.#backgroundEnded(item, running, rawJson);
          if (completed) this.#commands.delete(item.id);
          else if (item.processId) {
            this.#commands.set(item.id, { codexTurnId: turnId, command: item.command, processId: item.processId, output: item.aggregatedOutput ?? "" });
          }
        }
        const mapped = mapItem(item, completed);
        return [event(turnId, { case: completed ? "itemCompleted" : "itemStarted", value: { item: mapped } })];
      }
      case "item/agentMessage/delta":
        return [this.#delta(event, notification.params, ItemDeltaField.TEXT)];
      case "item/reasoning/textDelta":
        return [this.#delta(event, notification.params, ItemDeltaField.TEXT)];
      case "item/reasoning/summaryTextDelta":
        return [this.#delta(event, notification.params, ItemDeltaField.SUMMARY)];
      case "item/commandExecution/outputDelta": {
        const running = this.#commands.get(notification.params.itemId);
        if (running?.background) {
          // After the turn: the process's output belongs to its background item, outside any turn.
          return [{ rawJson, body: { case: "itemDelta", value: { itemId: running.background.itemId, field: ItemDeltaField.OUTPUT, chunk: notification.params.delta } } }];
        }
        if (running) running.output += notification.params.delta;
        return [this.#delta(event, notification.params, ItemDeltaField.OUTPUT)];
      }
      case "turn/plan/updated": {
        const { turnId, explanation, plan } = notification.params;
        // One plan item per turn; each update replaces it (item_completed carries the full state).
        return [
          event(turnId, {
            case: "itemCompleted",
            value: {
              item: {
                itemId: `plan:${turnId}`,
                status: ItemStatus.COMPLETED,
                content: {
                  case: "plan",
                  value: { text: explanation ?? "", steps: plan.map((p) => ({ text: p.step, status: snake(p.status) })) },
                },
              },
            },
          }),
        ];
      }
      case "thread/tokenUsage/updated": {
        const { turnId, tokenUsage } = notification.params;
        this.#usage.set(turnId, tokenUsage.total);
        return [
          event(turnId, {
            case: "usageUpdated",
            value: { usage: { ...usageOf(tokenUsage.total), contextWindowTokens: BigInt(tokenUsage.modelContextWindow ?? 0) } },
          }),
        ];
      }
      case "error": {
        const { error, willRetry, turnId } = notification.params;
        return [
          event(turnId, {
            case: "notice",
            value: {
              level: willRetry ? NoticeLevel.WARNING : NoticeLevel.ERROR,
              code: error.codexErrorInfo ? (typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : Object.keys(error.codexErrorInfo)[0] ?? "error") : "error",
              message: error.message,
              ...(error.additionalDetails && { dataJson: JSON.stringify({ additionalDetails: error.additionalDetails }) }),
            },
          }),
        ];
      }
      case "thread/goal/updated": {
        const { goal, turnId } = notification.params;
        return [
          event(turnId, {
            case: "goalState",
            value: {
              nativeStatus: goal.status,
              objective: goal.objective,
              tokensUsed: BigInt(goal.tokensUsed),
              timeUsedSeconds: BigInt(Math.round(goal.timeUsedSeconds)),
              tokenBudget: BigInt(goal.tokenBudget ?? 0),
            },
          }),
        ];
      }
      case "thread/goal/cleared":
        return [event(undefined, { case: "goalState", value: { cleared: true } })];
      default: {
        // Hooks, read state, moderation metadata, diffs, ...: kept raw for the timeline and later projections.
        const turnId = (notification.params as { turnId?: unknown } | undefined)?.turnId;
        return [event(typeof turnId === "string" ? turnId : undefined, undefined)];
      }
    }
  }

  /** Processes of a turn that keep running after it: each gets its background item before turn_finished. */
  #toBackground(codexTurnId: string, rawJson: string): ThreadEventInit[] {
    const turnId = this.#ctx.turnId(codexTurnId) ?? "";
    const started: ThreadEventInit[] = [];
    for (const [itemId, command] of this.#commands) {
      if (command.codexTurnId !== codexTurnId || command.background) continue;
      command.background = { itemId: `bg:${itemId}`, stopping: false };
      started.push({
        rawJson,
        ...(turnId && { turnId }),
        body: {
          case: "itemStarted",
          value: {
            item: {
              itemId: command.background.itemId,
              status: ItemStatus.IN_PROGRESS,
              content: {
                case: "backgroundTask",
                value: {
                  taskId: command.processId,
                  processId: command.processId,
                  kind: BackgroundTaskKind.PROCESS,
                  command: command.command,
                  description: command.command,
                  output: command.output,
                  startedInTurnId: turnId,
                  sourceItemId: itemId,
                },
              },
            },
          },
        },
      });
      command.output = ""; // later output goes to the background item only
    }
    return started;
  }

  /** The process of a backgrounded command exited (or was terminated): both items end, outside any turn. */
  #backgroundEnded(item: Extract<CodexItem, { type: "commandExecution" }>, running: RunningCommand, rawJson: string): ThreadEventInit[] {
    this.#commands.delete(item.id);
    const background = running.background!;
    const stopped = background.stopping;
    const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
    // The command item keeps the output its turn showed (the full output is on the background item).
    const command = mapItem({ ...item, aggregatedOutput: null }, true);
    return [
      { rawJson, body: { case: "itemCompleted", value: { item: command } } },
      {
        rawJson,
        body: {
          case: "itemCompleted",
          value: {
            item: {
              itemId: background.itemId,
              status: stopped ? ItemStatus.INTERRUPTED : failed ? ItemStatus.FAILED : ItemStatus.COMPLETED,
              content: {
                case: "backgroundTask",
                value: {
                  taskId: running.processId,
                  processId: running.processId,
                  kind: BackgroundTaskKind.PROCESS,
                  command: running.command,
                  description: running.command,
                  startedInTurnId: this.#ctx.turnId(running.codexTurnId) ?? "",
                  sourceItemId: item.id,
                  ...(stopped ? { stopReason: "stopped_by_user" } : failed ? { stopReason: "error" } : {}),
                },
              },
            },
          },
        },
      },
    ];
  }

  #delta(
    event: (codexTurnId: string | null | undefined, body: ThreadEventInit["body"]) => ThreadEventInit,
    params: { turnId: string; itemId: string; delta: string },
    field: ItemDeltaField,
  ): ThreadEventInit {
    return event(params.turnId, { case: "itemDelta", value: { itemId: params.itemId, field, chunk: params.delta } });
  }
}

export function mapItem(item: CodexItem, completed: boolean): ItemInit {
  const base = { itemId: item.id };
  const lifecycle = completed ? ItemStatus.COMPLETED : ItemStatus.IN_PROGRESS;
  switch (item.type) {
    case "userMessage":
      return {
        ...base,
        status: lifecycle,
        content: {
          case: "userMessage",
          value: { text: item.content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n") },
        },
      };
    case "agentMessage":
      return { ...base, status: lifecycle, content: { case: "agentMessage", value: { text: item.text, phase: item.phase ?? "" } } };
    case "reasoning":
      return {
        ...base,
        status: lifecycle,
        content: { case: "reasoning", value: { text: item.content.join("\n"), summary: item.summary.join("\n") } },
      };
    case "commandExecution":
      return {
        ...base,
        status: toolStatus(item.status),
        content: {
          case: "commandExecution",
          value: {
            command: item.command,
            cwd: item.cwd,
            output: item.aggregatedOutput ?? "",
            ...(item.exitCode !== null && { exitCode: item.exitCode }),
            ...(item.durationMs !== null && { durationMs: BigInt(item.durationMs) }),
          },
        },
      };
    case "fileChange":
      return {
        ...base,
        status: toolStatus(item.status),
        content: {
          case: "fileChange",
          value: {
            changes: item.changes.map((change) => ({
              path: change.path,
              kind: change.kind.type === "update" && change.kind.move_path ? "move" : change.kind.type,
              diff: change.diff,
              ...(change.kind.type === "update" && change.kind.move_path ? { movePath: change.kind.move_path } : {}),
            })),
          },
        },
      };
    case "mcpToolCall":
      return {
        ...base,
        status: toolStatus(item.status),
        content: {
          case: "toolCall",
          value: {
            server: item.server,
            name: item.tool,
            inputJson: JSON.stringify(item.arguments ?? null),
            output: item.error ? item.error.message : item.result ? JSON.stringify(item.result.content) : "",
            isError: item.error !== null || item.status === "failed",
          },
        },
      };
    case "dynamicToolCall": {
      const output = (item.contentItems ?? []).map((c) => (c.type === "inputText" ? c.text : `[${c.type}]`)).join("\n");
      if (isAgentBusTool(item.tool)) {
        return {
          ...base,
          status: toolStatus(item.status),
          content: {
            case: "agentBusCall",
            value: {
              callId: item.id,
              toolName: item.tool,
              argumentsJson: JSON.stringify(item.arguments ?? null),
              resultJson: output,
              isError: item.success === false,
            },
          },
        };
      }
      return {
        ...base,
        status: toolStatus(item.status),
        content: {
          case: "toolCall",
          value: {
            server: item.namespace ?? "",
            name: item.tool,
            inputJson: JSON.stringify(item.arguments ?? null),
            output,
            isError: item.success === false,
          },
        },
      };
    }
    case "webSearch":
      return { ...base, status: lifecycle, content: { case: "webSearch", value: { query: item.query } } };
    case "plan":
      return { ...base, status: lifecycle, content: { case: "plan", value: { text: item.text } } };
    case "imageView":
      return { ...base, status: lifecycle, content: { case: "image", value: { path: item.path } } };
    case "imageGeneration":
      return {
        ...base,
        status: item.failure ? ItemStatus.FAILED : lifecycle,
        content: { case: "image", value: { path: item.savedPath ?? "", prompt: item.revisedPrompt ?? "" } },
      };
    case "contextCompaction":
      return { ...base, status: lifecycle, content: { case: "contextCompaction", value: {} } };
    case "collabAgentToolCall":
      return {
        ...base,
        status: lifecycle,
        content: {
          case: "subagent",
          value: {
            agentType: item.tool,
            prompt: item.prompt ?? "",
            model: item.model ?? "",
            providerThreadId: item.receiverThreadIds[0] ?? "",
          },
        },
      };
    default:
      // hookPrompt, review mode, sleep, functionCallOutput, subAgentActivity, and future types: kept whole.
      return { ...base, status: lifecycle, content: { case: "providerItem", value: { type: item.type, json: JSON.stringify(item) } } };
  }
}

function toolStatus(status: "inProgress" | "completed" | "failed" | "declined"): ItemStatus {
  switch (status) {
    case "inProgress":
      return ItemStatus.IN_PROGRESS;
    case "completed":
      return ItemStatus.COMPLETED;
    case "failed":
      return ItemStatus.FAILED;
    case "declined":
      return ItemStatus.DECLINED;
  }
}

function turnOutcome(status: v2.TurnStatus): TurnOutcome {
  switch (status) {
    case "completed":
      return TurnOutcome.COMPLETED;
    case "interrupted":
      return TurnOutcome.INTERRUPTED;
    case "failed":
      return TurnOutcome.FAILED;
    case "inProgress":
      return TurnOutcome.UNSPECIFIED;
  }
}

function threadStatus(status: v2.ThreadStatus): ThreadStatus | undefined {
  switch (status.type) {
    case "idle":
      return ThreadStatus.IDLE;
    case "active":
      return status.activeFlags.length > 0 ? ThreadStatus.WAITING_INPUT : ThreadStatus.RUNNING;
    case "systemError":
      return ThreadStatus.FAILED;
    case "notLoaded":
      return undefined;
  }
}

function usageOf(usage: v2.TokenUsageBreakdown) {
  return {
    inputTokens: BigInt(usage.inputTokens),
    outputTokens: BigInt(usage.outputTokens + usage.reasoningOutputTokens),
    cachedInputTokens: BigInt(usage.cachedInputTokens),
  };
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

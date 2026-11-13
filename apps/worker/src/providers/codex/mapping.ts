import { mapItem, providerToolCall, shellCommandItem, outputText } from "./item-mapping.ts";

export { mapItem } from "./item-mapping.ts";

import { turnEndSource, turnOutcome, threadStatus, usageOf, snake } from "./status-mapping.ts";

export { codexErrorCode } from "./status-mapping.ts";

import { timestampNow } from "@bufbuild/protobuf/wkt";
import type { FunctionCallOutputBody, ResponseItem, ServerNotification, v2 } from "@canopy/codex-protocol";
import { BackgroundTaskKind, ItemDeltaField, ItemStatus, NoticeLevel, TurnOrigin } from "@canopy/contracts";
import { decodeJson, isString, jsonObject } from "../json.ts";
import type { ThreadEventInit } from "../../journal/index.ts";

/**
 * Codex app-server notifications -> platform transcript events (docs/transcript.md, docs/codex-adapter.md).
 *
 * One mapper per thread. Every notification of the thread yields at least one event: when there is
 * no mapping the event has no body but carries raw_json, so nothing is lost. The exception are model output
 * items read from the rollout (`rawResponseItem/completed`, see threads.ts): they yield events only for what
 * no app-server item covers (code-mode cells, shell calls Codex did not report).
 *
 * Background processes (docs/execution.md): a unified exec command still running when its turn completes
 * keeps streaming output and ends later (verified live on 0.164.0). At turn end it gets a background_task item
 * `bg:<command item id>` (output so far, then every later delta, outside the turn); the command item keeps
 * what the turn showed and completes, like the background item, when the process exits.
 */

type CodexItem = v2.ThreadItem;

type EventOf = (codexTurnId: string | null | undefined, body: ThreadEventInit["body"]) => ThreadEventInit;

/** Code-mode cell (custom tool) and its continuation (function): no app-server item exists for either. */
const CODE_MODE_CELL = "exec";
const CODE_MODE_WAIT = "wait";

/** Shell tools whose calls Codex normally reports as `commandExecution` items, with the call id as item id. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["exec_command", "shell_command", "shell"]);

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
  /** The platform asked to interrupt this turn (turn/interrupt): its interruption is the user's, else the system's. */
  interruptRequested?(codexTurnId: string): boolean;
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
  /** Code-mode cells and waits by call id: they become tool_call items (docs/codex-adapter.md, "Code mode"). */
  readonly #calls = new Map<string, { codexTurnId: string; name: string; inputJson: string; outputs: string[] }>();
  /** Shell calls by call id, kept until the turn ends: then those Codex reported no item for get one. */
  readonly #shellCalls = new Map<
    string,
    { codexTurnId: string; name: string; arguments: string; output?: FunctionCallOutputBody }
  >();
  /** Item ids Codex reported in the current turn. */
  readonly #reported = new Set<string>();

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

      return { ...(turnId && { turnId }), ...(body && { body }), rawJson };
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
          ...this.#unreportedShellCalls(event, turn.id),
          ...this.#toBackground(turn.id, rawJson),
          event(turn.id, {
            case: "turnFinished",
            value: {
              outcome: turnOutcome(turn.status),
              providerTurnRef: turn.id,
              ...turnEndSource(turn, this.#ctx.interruptRequested?.(turn.id) ?? true),
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

        // The authenticated connector bridge journals its own account-aware tool item.
        if (item.type === "mcpToolCall" && item.server === "canopy_connectors") return [event(turnId, undefined)];
        const completed = notification.method === "item/completed";
        this.#reported.add(item.id);

        if (item.type === "commandExecution") {
          const running = this.#commands.get(item.id);

          if (completed && running?.background) return this.#backgroundEnded(item, running, rawJson);

          if (completed) this.#commands.delete(item.id);
          else if (item.processId) {
            this.#commands.set(item.id, {
              codexTurnId: turnId,
              command: item.command,
              processId: item.processId,
              output: item.aggregatedOutput ?? "",
            });
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
          return [
            {
              rawJson,
              body: {
                case: "itemDelta",
                value: {
                  itemId: running.background.itemId,
                  field: ItemDeltaField.OUTPUT,
                  chunk: notification.params.delta,
                },
              },
            },
          ];
        }

        if (running) running.output += notification.params.delta;

        return [this.#delta(event, notification.params, ItemDeltaField.OUTPUT)];
      }

      case "rawResponseItem/completed":
        return this.#responseItem(event, notification.params.turnId, notification.params.item);
      default: {
        const mapped = this.#metadata(notification, event);

        if (mapped) return mapped;
        // Hooks, read state, moderation metadata, diffs, ...: kept raw for the timeline and later projections.
        const turnId = jsonObject(decodeJson(notification.params ?? null))?.["turnId"];

        return [event(isString(turnId) ? turnId : undefined, undefined)];
      }
    }
  }

  #metadata(notification: ServerNotification, event: EventOf): ThreadEventInit[] | undefined {
    switch (notification.method) {
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
                  value: {
                    text: explanation ?? "",
                    steps: plan.map((p) => ({ text: p.step, status: snake(p.status) })),
                  },
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
            value: {
              usage: { ...usageOf(tokenUsage.total), contextWindowTokens: BigInt(tokenUsage.modelContextWindow ?? 0) },
            },
          }),
        ];
      }

      case "error": {
        const { error, willRetry, turnId } = notification.params;

        // Even willRetry=false is a diagnostic, not a turn end. Only turn/completed carries the outcome.
        return [
          event(turnId, {
            case: "notice",
            value: {
              level: willRetry ? NoticeLevel.WARNING : NoticeLevel.ERROR,
              code: error.codexErrorInfo
                ? isString(error.codexErrorInfo)
                  ? error.codexErrorInfo
                  : (Object.keys(error.codexErrorInfo)[0] ?? "error")
                : "error",
              message: error.message,
              ...(error.additionalDetails && {
                dataJson: JSON.stringify({ additionalDetails: error.additionalDetails }),
              }),
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

      default:
        return undefined;
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
                  startedAt: timestampNow(),
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
  #backgroundEnded(
    item: Extract<CodexItem, { type: "commandExecution" }>,
    running: RunningCommand,
    rawJson: string,
  ): ThreadEventInit[] {
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
                  endedAt: timestampNow(),
                  ...(item.exitCode !== null && { exitCode: item.exitCode }),
                  ...((stopped || failed) && { stopReason: stopped ? "stopped_by_user" : "error" }),
                },
              },
            },
          },
        },
      },
    ];
  }

  /**
   * Model output items (from the rollout, see threads.ts). Only what no app-server item covers yields events;
   * everything else (messages, reasoning, tools with items) is already in the transcript.
   */
  #responseItem(event: EventOf, codexTurnId: string, item: ResponseItem): ThreadEventInit[] {
    const call = (callId: string, name: string, inputJson: string) => {
      const state = { codexTurnId, name, inputJson, outputs: [] };
      this.#calls.set(callId, state);

      return [event(codexTurnId, { case: "itemStarted", value: { item: providerToolCall(callId, state, false) } })];
    };

    const output = (callId: string, body: FunctionCallOutputBody) => {
      const state = this.#calls.get(callId);

      if (!state) return undefined;
      // A cell can report more than once (notify(), then its result); the item carries all of it.
      state.outputs.push(outputText(body));

      return [event(codexTurnId, { case: "itemCompleted", value: { item: providerToolCall(callId, state, true) } })];
    };

    switch (item.type) {
      case "custom_tool_call":
        return item.name === CODE_MODE_CELL ? call(item.call_id, item.name, JSON.stringify({ code: item.input })) : [];
      case "custom_tool_call_output":
        return output(item.call_id, item.output) ?? [];
      case "function_call":
        if (item.name === CODE_MODE_WAIT) return call(item.call_id, item.name, item.arguments);

        if (SHELL_TOOLS.has(item.name))
          this.#shellCalls.set(item.call_id, { codexTurnId, name: item.name, arguments: item.arguments });

        return [];
      case "function_call_output": {
        if (!item.call_id) return [];
        const shell = this.#shellCalls.get(item.call_id);

        if (shell) shell.output = item.output;

        return output(item.call_id, item.output) ?? [];
      }

      default:
        return [];
    }
  }

  /**
   * Shell calls of the turn without a Codex item. Codex 0.164.0 emits none for a command that fails with output
   * that looks like a sandbox denial (e.g. "Operation not permitted"), even with approvals off. Decided at the
   * turn end, because the rollout can be read before the item notification of the same call arrives.
   */
  #unreportedShellCalls(event: EventOf, codexTurnId: string): ThreadEventInit[] {
    const events: ThreadEventInit[] = [];

    for (const [callId, call] of this.#shellCalls) {
      if (call.codexTurnId !== codexTurnId) continue;
      this.#shellCalls.delete(callId);

      if (!this.#reported.has(callId))
        events.push(event(codexTurnId, { case: "itemCompleted", value: { item: shellCommandItem(callId, call) } }));
    }

    for (const [callId, call] of this.#calls) if (call.codexTurnId === codexTurnId) this.#calls.delete(callId);
    this.#reported.clear();

    return events;
  }

  #delta(
    event: EventOf,
    params: { turnId: string; itemId: string; delta: string },
    field: ItemDeltaField,
  ): ThreadEventInit {
    return event(params.turnId, { case: "itemDelta", value: { itemId: params.itemId, field, chunk: params.delta } });
  }
}

import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTaskKind, ItemDeltaField, ItemStatus, type BackgroundTaskSchema } from "@canopy/contracts";
import type { ThreadEventInit } from "../../journal/index.ts";

/** A background task with an open item. */
interface LiveTask {
  readonly itemId: string;
  readonly content: Omit<MessageInitShape<typeof BackgroundTaskSchema>, "$typeName">;
  outputFile?: string;
  stopping: boolean;
}

export class ClaudeBackgroundMapper {
  /** Bash calls with run_in_background, by tool_use id: command, then the output file from the tool result. */
  readonly #backgroundCalls = new Map<string, { command: string; description: string; outputFile?: string }>();
  /** Tasks that started in the foreground and may be moved to the background later. */
  readonly #foreground = new Map<
    string,
    { toolUseId: string; description: string; taskType: string; parentTaskId: string; turnId: string }
  >();
  readonly #tasks = new Map<string, LiveTask>();
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
    const events = [...this.#tasks.keys()].map((taskId) =>
      this.endTask(taskId, ItemStatus.INTERRUPTED, { stopReason }, "{}"),
    );

    return events.flatMap((e) => (e ? [e] : []));
  }

  taskStarted(
    message: Extract<SDKMessage, { type: "system"; subtype: "task_started" }>,
    rawJson: string,
    turnId: string | undefined,
  ): ThreadEventInit | undefined {
    if (message.skip_transcript || message.ambient) return undefined;

    const pending = {
      toolUseId: message.tool_use_id ?? "",
      description: message.description,
      taskType: message.task_type ?? "",
      parentTaskId: message.parent_task_id ?? "",
      turnId: turnId ?? "",
    };

    this.#foreground.set(message.task_id, pending);

    return message.is_backgrounded ? this.backgrounded(message.task_id, rawJson) : undefined;
  }

  /** Opens the background item of a task (backgrounded from the start or moved there later). */
  backgrounded(taskId: string, rawJson: string): ThreadEventInit | undefined {
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
      startedAt: timestampNow(),
    };

    const task: LiveTask = {
      itemId: `bg:${taskId}`,
      content,
      stopping: false,
      ...(call?.outputFile && { outputFile: call.outputFile }),
    };

    this.#tasks.set(taskId, task);

    return {
      rawJson,
      ...(pending.turnId && { turnId: pending.turnId }),
      body: {
        case: "itemStarted",
        value: {
          item: {
            itemId: task.itemId,
            status: ItemStatus.IN_PROGRESS,
            content: { case: "backgroundTask", value: content },
          },
        },
      },
    };
  }

  endTask(
    taskId: string,
    status: ItemStatus,
    detail: {
      summary?: string;
      outputFile?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number } | undefined;
      stopReason?: string;
    },
    rawJson: string,
  ): ThreadEventInit | undefined {
    const task = this.#tasks.get(taskId);

    if (!task) return undefined;
    this.#tasks.delete(taskId);

    const stopReason =
      status === ItemStatus.INTERRUPTED
        ? task.stopping
          ? "stopped_by_user"
          : (detail.stopReason ?? "stopped")
        : status === ItemStatus.FAILED
          ? "error"
          : "";

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
                endedAt: timestampNow(),
                ...(stopReason && { stopReason }),
                progress: {
                  summary: detail.summary ?? "",
                  ...(detail.usage && {
                    totalTokens: BigInt(detail.usage.total_tokens),
                    toolUses: detail.usage.tool_uses,
                    durationMs: BigInt(detail.usage.duration_ms),
                  }),
                },
              },
            },
          },
        },
      },
    };
  }

  recordCall(id: string, command: string, description: string): void {
    this.#backgroundCalls.set(id, { command, description });
  }
  recordOutput(id: string, output: string): void {
    const call = this.#backgroundCalls.get(id);
    const file = /Output is being written to: (\S+?\.output)/.exec(output)?.[1];

    if (call && file) {
      call.outputFile = file;

      for (const task of this.#tasks.values()) if (task.content.sourceItemId === id) task.outputFile = file;
    }
  }
  forgetForeground(taskId: string): void {
    this.#foreground.delete(taskId);
  }
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

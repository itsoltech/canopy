import type { ResponseItem, ServerNotification, v2 } from "@open-agents/codex-protocol";
import { ItemStatus, TurnEndSource, TurnOutcome } from "@open-agents/contracts";
import type { ThreadEventInit } from "../../journal/index.ts";
import { readJsonl, type HarnessRecord, type TurnEnd } from "../harness-record.ts";
import { CodexEventMapper, codexErrorCode } from "./mapping.ts";

/**
 * One turn as Codex recorded it in its rollout (docs/durability.md, "Rekoncyliacja z transkryptu harnessu").
 *
 * The rollout has, per turn: `task_started` / `turn_context` (the turn begins), `event_msg item_completed` with every
 * finished item under the same id app-server uses (user and agent messages, reasoning, commands, file changes, tool
 * calls), the model's `response_item`s (code-mode cells, shell calls without an item), `token_count`, and the end:
 * `task_complete` (with `error` when the turn failed, e.g. a 401 from the model provider) or `turn_aborted` (with
 * the reason, "interrupted" when the client asked). The items go through the same mapper as live notifications, so
 * they come out with the ids and shapes the live events had.
 */
export async function readCodexTurn(path: string, offset: number, codexTurnId: string, platformTurnId: string): Promise<HarnessRecord | undefined> {
  const records = (await readJsonl(path, offset)) as RolloutRecord[];
  let target = codexTurnId || undefined;
  let current: string | undefined;
  const mapper = new CodexEventMapper({
    startTurn: () => platformTurnId,
    turnId: (turn) => (turn === target ? platformTurnId : undefined),
    isCommandTurn: () => true,
  });
  const events: ThreadEventInit[] = [];
  let end: TurnEnd | undefined;
  let usage: TokenUsage | undefined;
  let seen = false;
  for (const record of records) {
    const payload = record.payload;
    if (!payload || typeof payload !== "object") continue;
    const turnOf = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    if (turnOf && turnOf === target) seen = true;
    if (record.type === "turn_context" || (record.type === "event_msg" && payload.type === "task_started")) {
      current = turnOf;
      // Without the Codex turn id, the first turn after the offset is this one (one turn at a time per thread).
      target ??= current;
      if (current === target) seen = true;
      continue;
    }
    if (!target) continue;
    if (record.type === "event_msg" && payload.type === "item_completed" && turnOf === target) {
      const item = threadItem(payload["item"]);
      if (item) events.push(...mapper.map({ method: "item/completed", params: { threadId: "", turnId: target, item } } as ServerNotification));
    } else if (record.type === "response_item" && current === target) {
      events.push(...mapper.map({ method: "rawResponseItem/completed", params: { threadId: "", turnId: target, item: payload as unknown as ResponseItem } }));
    } else if (record.type === "event_msg" && payload.type === "token_count" && current === target) {
      usage = (payload["info"] as { total_token_usage?: TokenUsage } | null | undefined)?.total_token_usage ?? usage;
    } else if (record.type === "event_msg" && payload.type === "task_complete" && turnOf === target) {
      const error = payload["error"] as { message?: string; codex_error_info?: unknown } | null | undefined;
      end = error
        ? { outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, reason: error.message ?? "the turn failed", errorCode: codexErrorCode(error.codex_error_info) }
        : { outcome: TurnOutcome.COMPLETED, source: TurnEndSource.UNSPECIFIED, reason: "" };
    } else if (record.type === "event_msg" && payload.type === "turn_aborted" && turnOf === target) {
      const reason = typeof payload["reason"] === "string" ? payload["reason"] : "aborted";
      // "interrupted": the client (the platform, for its user) asked; anything else Codex decided itself.
      end = { outcome: TurnOutcome.INTERRUPTED, source: reason === "interrupted" ? TurnEndSource.USER : TurnEndSource.SYSTEM, reason };
    }
  }
  if (!target || !seen) return undefined;
  // Shell calls Codex reported no item for come out at the turn's end, like live.
  const turn = { id: target, items: [], status: "interrupted", error: null } as unknown as v2.Turn;
  events.push(...mapper.map({ method: "turn/completed", params: { threadId: "", turn } }).filter((e) => e.body?.case !== "turnFinished"));
  return {
    items: itemsOf(events),
    ...(end && {
      end: {
        ...end,
        providerTurnRef: target,
        ...(usage && {
          usage: {
            inputTokens: BigInt(usage.input_tokens ?? 0),
            outputTokens: BigInt((usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0)),
            cachedInputTokens: BigInt(usage.cached_input_tokens ?? 0),
          },
        }),
      },
    }),
  };
}

interface RolloutRecord {
  readonly type?: string;
  readonly payload?: { readonly type?: string; readonly turn_id?: unknown; readonly [key: string]: unknown };
}

interface TokenUsage {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
}

/** Last state of every item the events touch, in first-seen order (deltas are not in the rollout). */
function itemsOf(events: ThreadEventInit[]): HarnessRecord["items"] {
  const items = new Map<string, HarnessRecord["items"][number]>();
  for (const event of events) {
    const body = event.body;
    if (body?.case !== "itemStarted" && body?.case !== "itemCompleted") continue;
    const item = body.value.item;
    if (!item?.itemId) continue;
    const known = items.get(item.itemId);
    // A start never replaces what finished.
    if (body.case === "itemStarted" && known && known.status !== ItemStatus.IN_PROGRESS) continue;
    items.set(item.itemId, item);
  }
  return [...items.values()];
}

/**
 * A rollout item (Codex's internal turn item: PascalCase type, snake_case fields) as the app-server item the mapper
 * reads. Unknown types are kept whole (provider_item).
 */
export function threadItem(raw: unknown): v2.ThreadItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown> & { type?: unknown; id?: unknown };
  if (typeof item.type !== "string" || typeof item.id !== "string") return undefined;
  const id = item.id;
  const status = camelStatus(item["status"]);
  const as = (value: Record<string, unknown>) => ({ id, ...value }) as unknown as v2.ThreadItem;
  switch (item.type) {
    case "UserMessage":
      return as({ type: "userMessage", content: Array.isArray(item["content"]) ? item["content"] : [], clientId: str(item["client_id"]) || null });
    case "AgentMessage":
      return as({ type: "agentMessage", text: texts(item["content"]), phase: str(item["phase"]) || null });
    case "Reasoning":
      return as({ type: "reasoning", summary: strings(item["summary_text"]), content: strings(item["raw_content"]) });
    case "CommandExecution": {
      const duration = item["duration"] as { secs?: number; nanos?: number } | undefined;
      return as({
        type: "commandExecution",
        command: commandText(item["command"]),
        cwd: fileUri(str(item["cwd"])),
        processId: str(item["process_id"]) || null,
        status,
        aggregatedOutput: typeof item["aggregated_output"] === "string" ? item["aggregated_output"] : null,
        exitCode: typeof item["exit_code"] === "number" ? item["exit_code"] : null,
        durationMs: duration ? Math.round((duration.secs ?? 0) * 1000 + (duration.nanos ?? 0) / 1e6) : null,
      });
    }
    case "FileChange": {
      const changes = item["changes"] && typeof item["changes"] === "object" ? Object.entries(item["changes"] as Record<string, Record<string, unknown>>) : [];
      return as({
        type: "fileChange",
        status,
        changes: changes.map(([path, change]) => ({
          path,
          kind: { type: str(change["type"]) || "update", move_path: str(change["move_path"]) || null },
          diff: str(change["unified_diff"]) || str(change["content"]),
        })),
      });
    }
    case "McpToolCall": {
      const error = item["error"];
      return as({
        type: "mcpToolCall",
        server: str(item["server"]),
        tool: str(item["tool"]),
        arguments: item["arguments"] ?? null,
        status,
        result: item["result"] ?? null,
        error: error ? { message: typeof error === "string" ? error : str((error as { message?: unknown }).message) || JSON.stringify(error) } : null,
      });
    }
    case "DynamicToolCall":
      return as({
        type: "dynamicToolCall",
        tool: str(item["tool"]),
        namespace: str(item["namespace"]) || null,
        arguments: item["arguments"] ?? null,
        status,
        contentItems: Array.isArray(item["content_items"]) ? item["content_items"] : null,
        success: typeof item["success"] === "boolean" ? item["success"] : null,
      });
    case "ImageView":
      return as({ type: "imageView", path: fileUri(str(item["path"])) });
    case "Plan":
      return as({ type: "plan", text: str(item["text"]) });
    case "ContextCompaction":
      return as({ type: "contextCompaction" });
    case "Extension":
      if (item["kind"] === "web.search") return as({ type: "webSearch", query: str(item["query"]) });
      return as({ ...item, type: "extension" });
    default:
      return as({ ...item, type: item.type.charAt(0).toLowerCase() + item.type.slice(1) });
  }
}

function camelStatus(value: unknown): string {
  switch (value) {
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "failed":
    case "declined":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : str((v as { text?: unknown } | null)?.text))) : [];
}

function texts(content: unknown): string {
  return Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
}

/** argv as app-server shows it: shell-quoted words joined by spaces. */
function commandText(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  return command.map((word) => (typeof word === "string" && /^[\w@%+=:,./-]+$/.test(word) ? word : `'${String(word).replaceAll("'", `'\\''`)}'`)).join(" ");
}

function fileUri(path: string): string {
  return path.startsWith("file://") ? decodeURIComponent(path.slice("file://".length)) : path;
}

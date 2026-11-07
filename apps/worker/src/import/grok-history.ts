import { join } from "node:path";
import { ItemStatus, type ImportedTurn } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import type { SessionUpdate, ToolCall } from "@canopy/grok-acp";
import { Option, Schema } from "effect";
import type { ThreadEventInit } from "../journal/index.ts";
import { GrokEventMapper } from "../providers/grok/mapping.ts";
import { grokStopReason } from "../providers/grok/transcript.ts";
import { isJsonObject, isNumber, jsonString } from "../providers/json.ts";
import { PagePosition, type PageResult } from "./claude-history.ts";
import { lines, parseLine, sourceExists, type SourceFile } from "./read.ts";
import { grokPromptText } from "./scan-grok.ts";
import { timeMs } from "./scan-types.ts";
import { maskedRecord, type Masker } from "./masking.ts";
import { draft, finish, putItem, setItem, turnBytes, type TurnDraft } from "./turns.ts";

/**
 * A Grok session as Canopy turns (docs/import.md, "Grok"). `updates.jsonl` is the session's ACP log: the user's
 * `user_message_chunk`s open a turn, agent and thought chunks and tool calls go through the adapter's own mapper
 * (the one live threads use), and `_x.ai/session/update turn_completed` ends it with its stop reason. A session
 * without that log falls back to `chat_history.jsonl` (prompts, answers, tool calls with results).
 */

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ToolContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("content"), content: Text }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    path: Schema.String,
    oldText: Schema.optional(Schema.NullOr(Schema.String)),
    newText: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("terminal"), terminalId: Schema.String }),
]);

const Update = Schema.Struct({
  sessionUpdate: Schema.String,
  content: Schema.optional(Schema.Union([Text, Schema.Array(ToolContent)])),
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  kind: Schema.optional(
    Schema.Literals(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]),
  ),
  status: Schema.optional(Schema.Literals(["pending", "in_progress", "completed", "failed"])),
  rawInput: Schema.optional(Schema.Json),
  rawOutput: Schema.optional(Schema.Json),
  stop_reason: Schema.optional(Schema.String),
  _meta: Schema.optional(Schema.Struct({ modelId: Schema.optional(Schema.String) })),
});

const Entry = Schema.Struct({ method: Schema.String, params: Schema.Struct({ update: Update }) });
const decodeEntry = Schema.decodeUnknownOption(Entry);

export interface GrokPageInput {
  /** The session directory, in its CLI home. */
  readonly dir: SourceFile;
  readonly end: number;
  readonly cursor: number;
  readonly threadId: string;
  readonly sessionId: string;
  readonly masker: Masker;
  readonly maxBytes: number;
}

interface GrokTurn {
  readonly draft: TurnDraft;
  readonly mapper: GrokEventMapper;
  prompting: boolean;
}

/** How a Grok stop reason ends the turn; anything else failed. */
const STOPS = new Map<string, "completed" | "interrupted">([
  ["end_turn", "completed"],
  ["cancelled", "interrupted"],
]);

export const GROK_HISTORY = ["updates.jsonl", "chat_history.jsonl"] as const;

/** The file a session's history is read from (a regular file in the CLI home, never a link), and how. */
export function grokHistoryFile(dir: SourceFile): SourceFile | undefined {
  return GROK_HISTORY.map((name) => ({ root: dir.root, path: join(dir.path, name) })).find(sourceExists);
}

export function readGrokPage(input: GrokPageInput): PageResult {
  const file = grokHistoryFile(input.dir);

  if (!file) return { turns: [], next: 0, read: 0, done: true, skipped: 0 };

  return file.path.endsWith("updates.jsonl") ? fromUpdates(file, input) : fromChatHistory(file, input);
}

function fromUpdates(file: SourceFile, input: GrokPageInput): PageResult {
  const turns: ImportedTurn[] = [];
  const position = new PagePosition(input.cursor);
  let current: GrokTurn | undefined;
  let bytes = 0;
  let skipped = 0;

  const close = (status = ItemStatus.INTERRUPTED) => {
    if (!current) return;
    take(current, current.mapper.finish(status), current.draft.endedMs);
    const turn = finish(input.threadId, input.sessionId, current.draft, input.masker);
    turns.push(turn);
    bytes += turnBytes(turn);
    current = undefined;
  };

  for (const line of lines(file, input.cursor, input.end)) {
    // Masked as decoded values first: tool calls, diffs and terminal output below work on masked data. Streamed text
    // (prompt, answer and thinking chunks) is the exception: a chunk masked alone could cut a secret apart (a key's
    // header in one chunk, its body in the next), so chunks are joined raw and the whole message is masked in finish().
    const raw = parseLine(line.text);
    const record = maskedRecord(raw, input.masker);
    position.line(line.end);
    const parsed = record ? decodeEntry(record) : Option.none();
    const chunk = raw ? streamedText(raw) : undefined;

    if (Option.isNone(parsed)) {
      if (line.text.trim() && !record) skipped += 1;
      continue;
    }

    const update = parsed.value.params.update;
    const at = timeMs(record?.["timestamp"]);

    if (update.sessionUpdate === "user_message_chunk") {
      if (!current?.prompting) {
        close();

        if (turns.length > 0 && bytes >= input.maxBytes)
          return { turns, next: line.offset, read: line.offset, done: false, skipped };
        const ref = `${line.offset}`;
        position.turn(line.offset);
        current = {
          draft: draft(ref, "", at),
          mapper: new GrokEventMapper(`${input.sessionId}:${line.offset}`, ""),
          prompting: true,
        };
      }

      if (chunk !== undefined) current.draft.prompt += chunk;
      current.draft.model ||= update._meta?.modelId ?? "";
      continue;
    }

    const mapped = acpUpdate(update, chunk);

    // Content without a prompt (a subagent's or a headless session's) still forms a turn.
    if (!current && (mapped || update.sessionUpdate === "turn_completed")) {
      position.turn(line.offset);
      current = {
        draft: draft(`${line.offset}`, "", at),
        mapper: new GrokEventMapper(`${input.sessionId}:${line.offset}`, ""),
        prompting: false,
      };
    }

    if (!current) continue;
    current.prompting = false;

    if (at !== undefined) current.draft.endedMs = Math.max(current.draft.endedMs ?? at, at);

    if (update.sessionUpdate === "turn_completed") {
      const reason = grokStopReason(update.stop_reason ?? "end_turn");
      current.draft.status = STOPS.get(reason) ?? "failed";

      if (current.draft.status === "failed") current.draft.error = `Grok stopped the turn (${reason})`;
      current.draft.providerTurnRef = input.sessionId;
      close(current.draft.status === "completed" ? ItemStatus.COMPLETED : ItemStatus.INTERRUPTED);
      continue;
    }

    if (mapped) take(current, current.mapper.update(mapped), at);
  }

  close();

  return { turns, ...position.end(), done: true, skipped };
}

/** The unmasked text of a streamed chunk (prompt, answer or thinking); finish() masks the joined message. */
function streamedText(raw: JsonObject): string | undefined {
  const entry = decodeEntry(raw);

  if (Option.isNone(entry)) return undefined;
  const update = entry.value.params.update;

  if (!STREAMED.has(update.sessionUpdate)) return undefined;

  return update.content && "text" in update.content ? update.content.text : undefined;
}

const STREAMED: ReadonlySet<string> = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]);

function acpUpdate(update: typeof Update.Type, chunk: string | undefined): SessionUpdate | undefined {
  if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")
    return chunk === undefined
      ? undefined
      : { sessionUpdate: update.sessionUpdate, content: { type: "text", text: chunk } };

  const content = update.content;

  if ((update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") || !update.toolCallId)
    return undefined;

  const tool: ToolCall = {
    toolCallId: update.toolCallId,
    ...(update.title !== undefined && { title: update.title }),
    ...(update.kind !== undefined && { kind: update.kind }),
    ...(update.status !== undefined && { status: update.status }),
    ...(update.rawInput !== undefined && { rawInput: update.rawInput }),
    ...(update.rawOutput !== undefined && { rawOutput: update.rawOutput }),
    ...(Array.isArray(content) && { content: [...content] }),
  };

  return { sessionUpdate: update.sessionUpdate, ...tool };
}

/** The mapper's items in their latest state, prefixed by nothing: the turn's own ids come from finish(). */
function take(turn: GrokTurn, events: readonly ThreadEventInit[], at: number | undefined): void {
  for (const event of events) {
    const body = event.body;

    if ((body?.case === "itemStarted" || body?.case === "itemCompleted") && body.value.item)
      putItem(turn.draft, body.value.item, at);
  }
}

/** Without an ACP log: prompts (with prompt_index), answers and tool calls with their results. */
function fromChatHistory(file: SourceFile, input: GrokPageInput): PageResult {
  const turns: ImportedTurn[] = [];
  const position = new PagePosition(input.cursor);
  let current: TurnDraft | undefined;
  let bytes = 0;
  let skipped = 0;

  const close = () => {
    if (!current) return;
    current.providerTurnRef = input.sessionId;
    const turn = finish(input.threadId, input.sessionId, current, input.masker);
    turns.push(turn);
    bytes += turnBytes(turn);
    current = undefined;
  };

  for (const line of lines(file, input.cursor, input.end)) {
    const entry = maskedRecord(parseLine(line.text), input.masker);
    position.line(line.end);

    if (!entry) {
      if (line.text.trim()) skipped += 1;
      continue;
    }

    const at = timeMs(entry["timestamp"]);

    if (entry["type"] === "user" && isNumber(entry["prompt_index"]) && !entry["synthetic_reason"]) {
      close();

      if (turns.length > 0 && bytes >= input.maxBytes)
        return { turns, next: line.offset, read: line.offset, done: false, skipped };
      position.turn(line.offset);
      const content = entry["content"];

      const text = Array.isArray(content)
        ? content.map((p) => (isJsonObject(p) ? jsonString(p["text"]) : "")).join("\n")
        : jsonString(content);

      current = draft(`${line.offset}`, grokPromptText(text), at);
      continue;
    }

    if (!current) continue;

    if (entry["type"] === "assistant") {
      const text = jsonString(entry["content"]);

      if (text)
        setItem(current, `${line.offset}:text`, { case: "agentMessage", value: { text } }, ItemStatus.COMPLETED, at);
      current.model ||= jsonString(entry["model_id"]);
      const calls = Array.isArray(entry["tool_calls"]) ? entry["tool_calls"] : [];

      for (const call of calls) {
        if (!isJsonObject(call)) continue;
        setItem(
          current,
          jsonString(call["id"]),
          { case: "toolCall", value: { name: jsonString(call["name"]), inputJson: jsonString(call["arguments"]) } },
          ItemStatus.IN_PROGRESS,
          at,
        );
      }
    } else if (entry["type"] === "tool_result") {
      const id = jsonString(entry["tool_call_id"]);
      const known = current.items.get(id);

      if (known?.item.content?.case === "toolCall")
        setItem(
          current,
          id,
          { case: "toolCall", value: { ...known.item.content.value, output: jsonString(entry["content"]) } },
          ItemStatus.COMPLETED,
          at,
        );
    }
  }

  close();

  return { turns, ...position.end(), done: true, skipped };
}

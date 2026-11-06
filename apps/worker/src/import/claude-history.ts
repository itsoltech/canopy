import type { MessageInitShape } from "@bufbuild/protobuf";
import { ItemStatus, type ImportedTurn, type ItemSchema } from "@canopy/contracts";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { isJsonObject, isString, jsonObject, jsonString } from "../providers/json.ts";
import { resultText, toolContent, withOutput } from "../providers/claude/content-mapping.ts";
import { contentText, promptText } from "./claude-entries.ts";
import type { ClaudeIndex } from "./claude-index.ts";
import type { Masker } from "./masking.ts";
import { lines, parseLine, sourceStat, type SourceFile } from "./read.ts";
import { timeMs } from "./scan-types.ts";
import { maskedRecord } from "./masking.ts";
import { draft, finish, setItem, turnBytes, type TurnDraft } from "./turns.ts";

type Content = NonNullable<MessageInitShape<typeof ItemSchema>["content"]>;

/**
 * A Claude Code session as Canopy turns (docs/import.md, "Claude"). A turn starts at a prompt the user typed (or a
 * slash command); assistant blocks become messages, reasoning and tool items with their results; `/compact` and
 * automatic compaction become a context_compaction item with the summary Claude kept; subagents (Task/Agent) become
 * subagent items whose own steps come from `<session>/subagents/`. Only the active branch is read.
 */

const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);
const INTERRUPTED = "[Request interrupted by user";

export interface ClaudePageInput {
  readonly file: SourceFile;
  readonly end: number;
  readonly cursor: number;
  readonly threadId: string;
  readonly sessionId: string;
  readonly index: ClaudeIndex;
  readonly masker: Masker;
  readonly maxBytes: number;
}

export interface PageResult {
  readonly turns: ImportedTurn[];
  /**
   * Where the next page starts. At the end it is the start of the last turn: an import of turns the CLI added later
   * reads that turn again, so the steps that finished it are not lost (the gateway adds what it did not have).
   */
  readonly next: number;
  /** End of the last complete record read: a line the CLI was still writing is read next time. */
  readonly read: number;
  readonly done: boolean;
  readonly skipped: number;
}

export interface PageEnd {
  readonly next: number;
  readonly read: number;
}

/** Offsets a reader tracks while it reads lines (see PageResult). */
export class PagePosition {
  read: number;
  #turnStart: number | undefined;

  constructor(cursor: number) {
    this.read = cursor;
  }

  line(end: number): void {
    this.read = end;
  }

  turn(offset: number): void {
    this.#turnStart = offset;
  }

  /** The end of the source: the last turn is read again next time. */
  end(): PageEnd {
    return { next: this.#turnStart ?? this.read, read: this.read };
  }
}

interface State {
  turn: TurnDraft | undefined;
  readonly tools: Map<string, { content: Content; parent: string }>;
  readonly blocks: Map<string, number>;
  compaction: string;
}

export function readClaudePage(input: ClaudePageInput): PageResult {
  const turns: ImportedTurn[] = [];
  const state: State = { turn: undefined, tools: new Map(), blocks: new Map(), compaction: "" };
  const position = new PagePosition(input.cursor);
  let bytes = 0;
  let skipped = 0;

  const close = () => {
    if (!state.turn) return;
    const turn = finish(input.threadId, input.sessionId, state.turn, input.masker);
    turns.push(turn);
    bytes += turnBytes(turn);
    state.turn = undefined;
  };

  for (const line of lines(input.file, input.cursor, input.end)) {
    // Masked as decoded values first: every transform below (diffs, previews) works on masked data. Text and thinking
    // blocks go in as written (`raw`): a message's blocks are separate entries, and finish() masks the turn's fields
    // joined, so a key split across blocks is found whole.
    const raw = parseLine(line.text);
    const entry = maskedRecord(raw, input.masker);
    position.line(line.end);

    if (!entry) {
      if (line.text.trim()) skipped += 1;
      continue;
    }

    const uuid = jsonString(entry["uuid"]);

    if (!uuid || !input.index.active.has(uuid)) continue;
    const at = timeMs(entry["timestamp"]);
    const prompt = promptText(entry);
    const compact = entry["type"] === "system" && entry["subtype"] === "compact_boundary";
    const startsTurn = prompt !== undefined || (compact && !autoCompaction(entry));

    // `/compact` typed after its boundary: the boundary already opened that turn.
    if (prompt === "/compact" && state.turn?.prompt === "/compact" && onlyCompaction(state.turn)) continue;

    if (startsTurn) {
      close();

      // A page ends before a turn that does not fit (it always holds one).
      if (turns.length > 0 && bytes >= input.maxBytes)
        return { turns, next: line.offset, read: line.offset, done: false, skipped };
      state.turn = draft(uuid, prompt ?? "/compact", at);
      position.turn(line.offset);
    }

    if (!state.turn) {
      state.turn = draft(uuid, "", at);
      position.turn(line.offset);
    }

    state.turn.providerTurnRef = uuid;

    if (compact) {
      state.compaction = `compact:${uuid}`;
      setItem(
        state.turn,
        state.compaction,
        { case: "contextCompaction", value: { summary: "" } },
        ItemStatus.COMPLETED,
        at,
      );
    } else applyEntry(state, { entry, raw }, at, "");

    if (entry["type"] === "user" && entry["isCompactSummary"] === true && state.compaction) {
      const summary = contentText(jsonObject(entry["message"])?.["content"]);
      setItem(
        state.turn,
        state.compaction,
        { case: "contextCompaction", value: { summary } },
        ItemStatus.COMPLETED,
        at,
      );
    }

    for (const tool of startedSubagents(entry))
      readSubagent(state, tool, input.index.subagents.get(tool), input.masker);
  }

  close();

  return { turns, ...position.end(), done: true, skipped };
}

function contentBlocks(content: JsonValue | undefined): JsonObject[] {
  return Array.isArray(content) ? content.flatMap((b) => (isJsonObject(b) ? [b] : [])) : [];
}

function autoCompaction(entry: JsonObject): boolean {
  return jsonString(jsonObject(entry["compactMetadata"])?.["trigger"]) === "auto";
}

function onlyCompaction(turn: TurnDraft): boolean {
  return [...turn.items.keys()].every((id) => id.startsWith("compact:"));
}

/** Assistant blocks and tool results of one entry (`parent`: the subagent tool call for a subagent's steps). */
function applyEntry(
  state: State,
  { entry, raw }: { readonly entry: JsonObject; readonly raw: JsonObject | undefined },
  at: number | undefined,
  parent: string,
): void {
  const turn = state.turn;
  const message = jsonObject(entry["message"]);

  if (!turn || !message) return;
  const content = message["content"];
  const blocks = contentBlocks(content);
  const written = contentBlocks(jsonObject(raw?.["message"])?.["content"]);

  if (entry["type"] === "assistant") {
    const messageId = jsonString(message["id"]) || jsonString(entry["uuid"]);

    if (!parent && isString(message["model"]) && message["model"] !== "<synthetic>") turn.model = message["model"];

    if (entry["isApiErrorMessage"] === true && !parent) {
      turn.status = "failed";
      turn.error = contentText(content) || jsonString(entry["error"]) || "API error";

      return;
    }

    for (const [position, block] of blocks.entries()) {
      const index = state.blocks.get(messageId) ?? 0;
      state.blocks.set(messageId, index + 1);
      const type = jsonString(block["type"]);

      if (type === "text" || type === "thinking") {
        const text = jsonString(written[position]?.[type === "text" ? "text" : "thinking"]);

        if (!text) continue;

        const item: Content =
          type === "text" ? { case: "agentMessage", value: { text } } : { case: "reasoning", value: { text } };

        setItem(turn, `${messageId}:${index}`, item, ItemStatus.COMPLETED, at, parent);
      } else if (type === "tool_use") {
        const id = jsonString(block["id"]);
        const name = jsonString(block["name"]);
        const started = SUBAGENT_TOOLS.has(name) ? subagentContent(block["input"]) : toolContent(name, block["input"]);
        state.tools.set(id, { content: started, parent });
        setItem(turn, id, started, ItemStatus.IN_PROGRESS, at, parent);
      }
    }

    return;
  }

  if (contentText(content).startsWith(INTERRUPTED) && !parent) turn.status = "interrupted";

  for (const block of blocks) {
    if (block["type"] !== "tool_result") continue;
    const id = jsonString(block["tool_use_id"]);
    const tool = state.tools.get(id);

    if (!tool) continue;
    const failed = block["is_error"] === true;
    const output = resultText(block["content"]);

    const done =
      tool.content.case === "subagent"
        ? { case: "subagent" as const, value: { ...tool.content.value, result: output } }
        : withOutput(tool.content, output, failed);

    setItem(turn, id, done, failed ? ItemStatus.FAILED : ItemStatus.COMPLETED, at, tool.parent);
  }
}

function subagentContent(input: JsonObject[string] | undefined): Content {
  const args = jsonObject(input) ?? {};

  return {
    case: "subagent",
    value: {
      agentType: jsonString(args["subagent_type"]),
      description: jsonString(args["description"]),
      prompt: jsonString(args["prompt"]),
    },
  };
}

/** Subagent tool calls an entry starts (their steps are read from the subagent's own transcript). */
function startedSubagents(entry: JsonObject): string[] {
  const content = jsonObject(entry["message"])?.["content"];

  if (entry["type"] !== "assistant" || !Array.isArray(content)) return [];

  return content.flatMap((b) =>
    isJsonObject(b) && b["type"] === "tool_use" && SUBAGENT_TOOLS.has(jsonString(b["name"]))
      ? [jsonString(b["id"])]
      : [],
  );
}

/** A subagent's own steps, nested under its tool call (at most 32 MB of transcript). */
function readSubagent(state: State, parent: string, file: SourceFile | undefined, masker: Masker): void {
  if (!file || !state.turn) return;
  const size = Math.min(sourceStat(file).size, 32 * 1024 ** 2);

  for (const line of lines(file, 0, size)) {
    const raw = parseLine(line.text);
    const entry = maskedRecord(raw, masker);

    if (entry && (entry["type"] === "assistant" || entry["type"] === "user") && promptText(entry) === undefined)
      applyEntry(state, { entry, raw }, timeMs(entry["timestamp"]), parent);
  }
}

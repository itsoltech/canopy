import type { v2 } from "@canopy/codex-protocol";
import { ItemStatus, type ImportedTurn } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import type { ThreadEventInit } from "../journal/index.ts";
import { CodexEventMapper } from "../providers/codex/mapping.ts";
import { decodeResponseItem } from "../providers/codex/rollout.ts";
import { threadItem } from "../providers/codex/transcript.ts";
import { isJsonObject, isString, jsonObject, jsonString } from "../providers/json.ts";
import { PagePosition, type PageResult } from "./claude-history.ts";
import { codexPrompt } from "./codex-entries.ts";
import type { Masker } from "./masking.ts";
import { lines, parseLine, type SourceFile } from "./read.ts";
import { timeMs } from "./scan-types.ts";
import { maskedRecord } from "./masking.ts";
import { draft, finish, putItem, setItem, turnBytes, type TurnDraft } from "./turns.ts";

/**
 * A Codex rollout as Canopy turns (docs/import.md, "Codex"). Turns are `task_started` … `task_complete` (or
 * `turn_aborted`); their items go through the adapter's own mapper, the one live threads use: `event_msg
 * item_completed` (newer CLIs) and raw `response_item`s (shell calls without an item, code-mode cells). Rollouts from
 * before `item_completed` get their messages and reasoning from `response_item`s and `event_msg user_message`.
 */

/** Records that carry a turn's content (a turn opens on them when the rollout has no task_started). */
const CONTENT = /^(?:response_item:|event_msg:item_completed$|event_msg:user_message$|compacted:)/;

interface CodexTurn {
  readonly draft: TurnDraft;
  readonly codexTurnId: string;
  readonly mapper: CodexEventMapper;
  /** The rollout records whole items for this turn (newer CLIs). */
  items: boolean;
  legacy: number;
  readonly compactions: { summary: string; at: number | undefined }[];
}

export interface CodexPageInput {
  readonly file: SourceFile;
  readonly end: number;
  readonly cursor: number;
  readonly threadId: string;
  readonly sessionId: string;
  readonly masker: Masker;
  readonly maxBytes: number;
}

export function readCodexPage(input: CodexPageInput): PageResult {
  const turns: ImportedTurn[] = [];
  let current: CodexTurn | undefined;
  const position = new PagePosition(input.cursor);
  let bytes = 0;
  let skipped = 0;

  const close = () => {
    if (!current) return;
    flush(current);

    if (!current.draft.prompt && current.draft.items.size === 0) {
      current = undefined;

      return;
    }

    const turn = finish(input.threadId, input.sessionId, current.draft, input.masker);
    turns.push(turn);
    bytes += turnBytes(turn);
    current = undefined;
  };

  for (const line of lines(input.file, input.cursor, input.end)) {
    // Masked as decoded values first: command previews and patches below work on masked data.
    const record = maskedRecord(parseLine(line.text), input.masker);
    position.line(line.end);

    if (!record) {
      if (line.text.trim()) skipped += 1;
      continue;
    }

    const payload = jsonObject(record["payload"]);
    const kind = `${jsonString(record["type"])}:${jsonString(payload?.["type"])}`;
    const at = timeMs(record["timestamp"]);
    const turnOf = jsonString(payload?.["turn_id"]);
    const legacyPrompt = current?.items === false || !current ? codexPrompt(record, false) : undefined;

    const starts =
      kind === "event_msg:task_started" ||
      // Before task_started existed a prompt opened the turn.
      (legacyPrompt !== undefined && kind === "event_msg:user_message" && (!current || current.draft.prompt !== ""));

    if (starts) {
      close();

      if (turns.length > 0 && bytes >= input.maxBytes)
        return { turns, next: line.offset, read: line.offset, done: false, skipped };
      current = open(turnOf || `${line.offset}`, at);
      position.turn(line.offset);
    }

    if (!payload) continue;

    // Records before the first turn (session_meta, settings) open none.
    if (!current && !CONTENT.test(kind)) continue;

    if (!current) {
      current = open(`${line.offset}`, at);
      position.turn(line.offset);
    }

    apply(current, record, payload, kind, at);
  }

  close();

  return { turns, ...position.end(), done: true, skipped };
}

function open(codexTurnId: string, at: number | undefined): CodexTurn {
  return {
    draft: draft(codexTurnId, "", at),
    codexTurnId,
    mapper: new CodexEventMapper({
      startTurn: () => codexTurnId,
      turnId: () => codexTurnId,
      isCommandTurn: () => true,
    }),
    items: false,
    legacy: 0,
    compactions: [],
  };
}

function apply(turn: CodexTurn, record: JsonObject, payload: JsonObject, kind: string, at: number | undefined): void {
  const draftTurn = turn.draft;

  if (at !== undefined) draftTurn.endedMs = Math.max(draftTurn.endedMs ?? at, at);

  switch (kind) {
    case "turn_context:":
      draftTurn.model ||= jsonString(payload["model"]);

      return;
    case "event_msg:item_completed": {
      const item = threadItem(payload["item"]);

      if (!item) return;
      turn.items = true;

      if (item.type === "userMessage") {
        draftTurn.prompt ||= codexPrompt(record, true) ?? "";

        return;
      }

      take(
        turn,
        turn.mapper.map({
          method: "item/completed",
          params: { threadId: "", turnId: turn.codexTurnId, item, completedAtMs: at ?? 0 },
        }),
        at,
      );

      return;
    }

    case "event_msg:user_message":
      if (!turn.items) draftTurn.prompt ||= codexPrompt(record, false) ?? "";

      return;
    case "event_msg:task_complete": {
      const error = jsonObject(payload["error"]);

      if (error) {
        draftTurn.status = "failed";
        draftTurn.error = jsonString(error["message"]) || "The turn failed";
      }

      draftTurn.providerTurnRef = turn.codexTurnId;

      return;
    }

    case "event_msg:turn_aborted":
      draftTurn.status = "interrupted";
      draftTurn.providerTurnRef = turn.codexTurnId;

      return;
    case "compacted:":
      // Newer rollouts record the compaction as an item too; the record alone counts only without items.
      turn.compactions.push({ summary: jsonString(payload["message"]), at });

      return;
    default:
      if (record["type"] === "response_item") responseItem(turn, payload, at);
  }
}

/** Raw model output: shell calls and code cells through the mapper; messages and reasoning of older rollouts here. */
function responseItem(turn: CodexTurn, payload: JsonObject, at: number | undefined): void {
  take(
    turn,
    turn.mapper.map({
      method: "rawResponseItem/completed",
      params: { threadId: "", turnId: turn.codexTurnId, item: decodeResponseItem(payload) },
    }),
    at,
  );

  if (turn.items) return;
  const id = jsonString(payload["id"]) || `${turn.codexTurnId}:${turn.legacy++}`;

  if (payload["type"] === "message" && payload["role"] === "assistant") {
    const text = texts(payload["content"]);

    if (text) setItem(turn.draft, id, { case: "agentMessage", value: { text } }, ItemStatus.COMPLETED, at);
  } else if (payload["type"] === "message" && payload["role"] === "user" && !turn.draft.prompt) {
    turn.draft.prompt =
      codexPrompt(
        { type: "event_msg", payload: { type: "user_message", message: texts(payload["content"]) } },
        false,
      ) ?? "";
  } else if (payload["type"] === "reasoning") {
    const summary = Array.isArray(payload["summary"]) ? payload["summary"] : [];
    const text = summary.map((s) => (isJsonObject(s) ? jsonString(s["text"]) : "")).join("\n");

    if (text) setItem(turn.draft, id, { case: "reasoning", value: { text } }, ItemStatus.COMPLETED, at);
  }
}

/** Shell calls Codex reported no item for come out at the turn's end, like live. */
function flush(turn: CodexTurn): void {
  const end = {
    id: turn.codexTurnId,
    rootTurnId: null,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  } satisfies v2.Turn;

  take(turn, turn.mapper.map({ method: "turn/completed", params: { threadId: "", turn: end } }), turn.draft.endedMs);

  if (turn.items) return;

  for (const [index, c] of turn.compactions.entries())
    setItem(
      turn.draft,
      `compact:${turn.codexTurnId}:${index}`,
      { case: "contextCompaction", value: { summary: c.summary } },
      ItemStatus.COMPLETED,
      c.at,
    );
}

/** The mapper's items, each in its latest state; a start never replaces what finished. */
function take(turn: CodexTurn, events: readonly ThreadEventInit[], at: number | undefined): void {
  for (const event of events) {
    const body = event.body;

    if (body?.case !== "itemStarted" && body?.case !== "itemCompleted") continue;
    const item = body.value.item;

    if (!item?.itemId || item.content?.case === "userMessage") continue;
    const known = turn.draft.items.get(item.itemId);

    if (body.case === "itemStarted" && known && known.item.status !== ItemStatus.IN_PROGRESS) continue;
    putItem(turn.draft, item, at);
  }
}

function texts(content: JsonObject[string] | undefined): string {
  if (isString(content)) return content;

  return Array.isArray(content) ? content.map((p) => (isJsonObject(p) ? jsonString(p["text"]) : "")).join("\n") : "";
}

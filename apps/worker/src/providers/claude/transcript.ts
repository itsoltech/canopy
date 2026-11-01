import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ItemStatus, TurnEndSource, TurnOutcome } from "@open-agents/contracts";
import { readJsonl, type HarnessRecord, type TurnEnd } from "../harness-record.ts";
import { resultText, toolContent, withOutput } from "./mapping.ts";

/**
 * One turn as Claude Code recorded it in the session transcript (docs/durability.md, "Rekoncyliacja z transkryptu
 * harnessu"): `<config dir>/projects/<project dir>/<session id>.jsonl`, everything after the offset the turn started
 * at (one turn at a time per session).
 *
 * - Assistant entries carry one content block each; blocks of one API message share `message.id`, so a block's index
 *   in its message is its position among them. Text and thinking get the live id `<message id>:<index>`, tool calls
 *   their tool_use id; a tool call finishes with the tool_result in a later user entry.
 * - The end: an assistant entry with `isApiErrorMessage` failed in the harness (`apiError`/`error` is the code, its
 *   text the message, e.g. a usage limit or a 401); a user entry "[Request interrupted by user…]" was interrupted on
 *   request; a last assistant entry that stopped (end_turn, stop_sequence, max_tokens, refusal) with no tool call
 *   waiting completed the turn. Anything else: the process stopped mid-turn (no end).
 * - Subagent entries (isSidechain) belong to their tool call, not to the turn's own items.
 */
export async function readClaudeTurn(home: string, sessionId: string, offset: number): Promise<HarnessRecord | undefined> {
  const path = transcriptPath(home, sessionId);
  if (!path) return undefined;
  const entries = (await readJsonl(path, offset)) as TranscriptEntry[];
  const items = new Map<string, HarnessRecord["items"][number]>();
  const tools = new Map<string, NonNullable<HarnessRecord["items"][number]["content"]>>();
  const blocks = new Map<string, number>();
  let last: { stopReason: string | null; uuid: string; apiError?: { code: string; text: string } } | undefined;
  let interrupted = false;
  let seen = false;
  for (const entry of entries) {
    if (entry.isSidechain || (entry.type !== "assistant" && entry.type !== "user") || !entry.message) continue;
    seen = true;
    const content = entry.message.content;
    if (entry.type === "assistant") {
      interrupted = false;
      const messageId = entry.message.id ?? entry.uuid ?? "";
      const list = Array.isArray(content) ? (content as Block[]) : [];
      if (entry.isApiErrorMessage) {
        const text = list.map((b) => (b.type === "text" ? String(b["text"] ?? "") : "")).join("");
        last = { stopReason: entry.message.stop_reason ?? null, uuid: entry.uuid ?? "", apiError: { code: entry.apiError || entry.error || "api_error", text } };
        continue;
      }
      for (const block of list) {
        const index = blocks.get(messageId) ?? 0;
        blocks.set(messageId, index + 1);
        if (block.type === "text" || block.type === "thinking") {
          const text = String(block.type === "text" ? block["text"] : block["thinking"]);
          if (!text) continue;
          const itemId = `${messageId}:${index}`;
          items.set(itemId, {
            itemId,
            status: ItemStatus.COMPLETED,
            content: block.type === "text" ? { case: "agentMessage", value: { text } } : { case: "reasoning", value: { text } },
          });
        } else if (block.type === "tool_use") {
          const id = String(block["id"]);
          const started = toolContent(String(block["name"]), block["input"]);
          tools.set(id, started);
          items.set(id, { itemId: id, status: ItemStatus.IN_PROGRESS, content: started });
        }
      }
      last = { stopReason: entry.message.stop_reason ?? null, uuid: entry.uuid ?? "" };
      continue;
    }
    // user: tool results, an interruption, or a prompt (the worker journals prompts itself).
    const list = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];
    for (const block of list) {
      if (block.type === "text" && /^\[Request interrupted by user/.test(String(block["text"] ?? ""))) interrupted = true;
      if (block.type !== "tool_result") continue;
      const id = String(block["tool_use_id"]);
      const started = tools.get(id);
      if (!started) continue;
      const failed = block["is_error"] === true;
      items.set(id, { itemId: id, status: failed ? ItemStatus.FAILED : ItemStatus.COMPLETED, content: withOutput(started, resultText(block["content"]), failed) });
      // The model has not answered the result yet.
      if (last) last = { ...last, stopReason: null };
    }
  }
  if (!seen) return undefined;
  const waiting = [...items.values()].some((i) => i.status === ItemStatus.IN_PROGRESS);
  let end: TurnEnd | undefined;
  if (interrupted) end = { outcome: TurnOutcome.INTERRUPTED, source: TurnEndSource.USER, reason: "interrupted" };
  else if (last?.apiError) end = { outcome: TurnOutcome.FAILED, source: TurnEndSource.HARNESS, reason: last.apiError.text || last.apiError.code, errorCode: last.apiError.code };
  else if (last && !waiting && last.stopReason && STOPPED.has(last.stopReason)) end = { outcome: TurnOutcome.COMPLETED, source: TurnEndSource.UNSPECIFIED, reason: "" };
  return { items: [...items.values()], ...(end && { end: { ...end, ...(last?.uuid && { providerTurnRef: last.uuid }) } }) };
}

const STOPPED: ReadonlySet<string> = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

interface TranscriptEntry {
  readonly type?: string;
  readonly uuid?: string;
  readonly isSidechain?: boolean;
  readonly isApiErrorMessage?: boolean;
  readonly error?: string;
  readonly apiError?: string | null;
  readonly message?: { readonly id?: string; readonly stop_reason?: string | null; readonly content?: unknown };
}

interface Block {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Session transcript of Claude Code: <config dir>/projects/<project dir>/<session id>.jsonl. */
export function transcriptPath(home: string, sessionId: string): string | undefined {
  const projects = join(home, "projects");
  if (!existsSync(projects)) return undefined;
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

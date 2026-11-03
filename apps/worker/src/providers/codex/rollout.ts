import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { ResponseItem } from "@canopy/codex-protocol";

/**
 * Codex's own record of a thread (`Thread.path`, `<CODEX_HOME>/sessions/.../rollout-*.jsonl`), read as it grows.
 *
 * It has what app-server notifications do not (docs/codex-adapter.md, "Code mode"): code-mode `exec` cells
 * (`custom_tool_call` + output) and `exec_command` calls for which Codex emits no item. The protocol's
 * `experimentalRawEvents` would carry the same items, but only for `thread/start`; resumed and forked threads
 * lose it, so the rollout is the one source that works for every thread.
 */
export type RolloutLine =
  | { readonly kind: "turn"; readonly turnId: string; readonly ended: boolean }
  | { readonly kind: "item"; readonly item: ResponseItem };

export class RolloutTail {
  readonly #path: string;
  #offset: number;
  #partial = "";

  /** Starts at the current end: earlier lines (resumed or forked history) are not this process's turns. */
  constructor(path: string) {
    this.#path = path;
    this.#offset = existsSync(path) ? statSync(path).size : 0;
  }

  /** Complete lines appended since the last read: turn boundaries and response items. */
  read(): RolloutLine[] {
    if (!existsSync(this.#path)) return []; // Codex creates the file lazily
    const fd = openSync(this.#path, "r");
    let chunk: string;
    try {
      const size = fstatSync(fd).size;
      if (size <= this.#offset) return [];
      const buffer = Buffer.alloc(size - this.#offset);
      const read = readSync(fd, buffer, 0, buffer.length, this.#offset);
      this.#offset += read;
      chunk = this.#partial + buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = chunk.split("\n");
    this.#partial = lines.pop() ?? "";
    return lines.flatMap((line) => parseLine(line));
  }
}

function parseLine(line: string): RolloutLine[] {
  if (!line.trim()) return [];
  let record: { type?: string; payload?: { type?: string; turn_id?: unknown } };
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  const payload = record.payload;
  if (!payload) return [];
  if (record.type === "response_item") return [{ kind: "item", item: payload as ResponseItem }];
  if (typeof payload.turn_id !== "string") return [];
  if (record.type === "turn_context" || (record.type === "event_msg" && payload.type === "task_started")) {
    return [{ kind: "turn", turnId: payload.turn_id, ended: false }];
  }
  if (record.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
    return [{ kind: "turn", turnId: payload.turn_id, ended: true }];
  }
  return [];
}

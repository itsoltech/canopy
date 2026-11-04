import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { ResponseItem } from "@canopy/codex-protocol";
import type { JsonObject } from "@canopy/domain";
import { Schema } from "effect";
import { decodeJsonObject, isString, jsonObject } from "../json.ts";

const OutputBody = Schema.Union([
  Schema.String,
  Schema.mutable(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
        Schema.Struct({
          type: Schema.Literal("input_image"),
          image_url: Schema.String,
          detail: Schema.optionalKey(Schema.Literals(["auto", "low", "high", "original"])),
        }),
        Schema.Struct({
          type: Schema.Literal("input_image"),
          file_id: Schema.String,
          detail: Schema.optionalKey(Schema.Literals(["auto", "low", "high", "original"])),
        }),
        Schema.Struct({ type: Schema.Literal("input_audio"), audio_url: Schema.String }),
        Schema.Struct({ type: Schema.Literal("encrypted_content"), encrypted_content: Schema.String }),
      ]),
    ),
  ),
]);

const ToolResponseItem = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("custom_tool_call"),
    call_id: Schema.String,
    name: Schema.String,
    input: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("custom_tool_call_output"), call_id: Schema.String, output: OutputBody }),
  Schema.Struct({
    type: Schema.Literal("function_call"),
    call_id: Schema.String,
    name: Schema.String,
    arguments: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.optionalKey(Schema.String),
    output: OutputBody,
  }),
]);

/** Validate the raw tool variants consumed by the mapper; keep all other provider records opaque. */
export function decodeResponseItem(raw: JsonObject): ResponseItem {
  switch (raw["type"]) {
    case "custom_tool_call":
    case "custom_tool_call_output":
    case "function_call":
    case "function_call_output":
      if (Schema.is(ToolResponseItem)(raw)) return raw;

      return Schema.decodeUnknownSync(ToolResponseItem)(raw);
    default:
      // SAFETY: The mapper ignores every other raw response type. Preserve the original JSON for
      // consumers instead of inventing fields from the generated, broader app-server union.
      return raw as ResponseItem;
  }
}

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
  let record: JsonObject;

  try {
    record = decodeJsonObject(JSON.parse(line));
  } catch {
    return [];
  }

  const payload = jsonObject(record["payload"]);

  if (!payload) return [];

  if (record["type"] === "response_item") return [{ kind: "item", item: decodeResponseItem(payload) }];

  if (!isString(payload["turn_id"])) return [];

  if (record["type"] === "turn_context" || (record["type"] === "event_msg" && payload["type"] === "task_started")) {
    return [{ kind: "turn", turnId: payload["turn_id"], ended: false }];
  }

  if (record["type"] === "event_msg" && (payload["type"] === "task_complete" || payload["type"] === "turn_aborted")) {
    return [{ kind: "turn", turnId: payload["turn_id"], ended: true }];
  }

  return [];
}

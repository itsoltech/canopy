import type { JsonValue } from "@bufbuild/protobuf";
import { Predicate } from "effect";

const MIN_DUPLICATE_CHARS = 128;
const MIN_JSON_DUPLICATE_CHARS = 1024;
const ITEM_KINDS = new Set(["item_started", "item_delta", "item_completed"]);
const STRUCTURED_KEYS = new Set(["arguments", "content", "input", "item", "output", "rawInput", "rawOutput"]);

type Path = readonly string[];

export interface RawPayloadRef {
  readonly raw: Path;
  readonly payload: Path;
  readonly json?: true;
}

interface MappedContent {
  readonly strings: Map<string, Path>;
  readonly structured: Map<string, Path>;
}

/** Plan substitutions from the mapped payload of this event. SQL verifies structured matches. */
export function compactEventRaw(kind: string, payload: JsonValue, rawJson: string) {
  if (!rawJson || !ITEM_KINDS.has(kind)) return undefined;
  const mapped = mappedContent(payload);

  if ((!mapped.strings.size && !mapped.structured.size) || containsImage(payload)) return undefined;
  let raw: JsonValue;

  try {
    // SAFETY: JSON.parse accepts only JSON scalars, arrays and objects; these are exactly JsonValue.
    raw = JSON.parse(rawJson) as JsonValue;
  } catch {
    // Invalid JSON must still reach the SQL cast and quarantine path unchanged.
    return undefined;
  }

  if (containsImage(raw)) return undefined;
  const refs: RawPayloadRef[] = [];
  const compact = replaceDuplicates(raw, [], mapped, refs, 0);

  if (!refs.length || refs.length > 256) return undefined;
  const compactJson = JSON.stringify(compact);
  const refsJson = JSON.stringify(refs);

  // Count the actual serialized JSON, including the paths; never inflate short deltas.
  if (Buffer.byteLength(compactJson) + Buffer.byteLength(refsJson) >= Buffer.byteLength(rawJson)) return undefined;

  return { refs: refsJson };
}

function mappedContent(payload: JsonValue): MappedContent {
  const strings = new Map<string, Path>();
  const structured = new Map<string, Path>();
  const object = jsonObject(payload);
  const delta = jsonObject(object?.["itemDelta"]);

  if (Predicate.isString(delta?.["chunk"]) && delta["chunk"].length >= MIN_DUPLICATE_CHARS)
    strings.set(delta["chunk"], ["itemDelta", "chunk"]);

  for (const phase of ["itemStarted", "itemCompleted"]) {
    const item = jsonObject(jsonObject(object?.[phase])?.["item"]);

    for (const [type, fields] of [
      ["userMessage", ["text"]],
      ["agentMessage", ["text"]],
      ["reasoning", ["text", "summary"]],
      ["commandExecution", ["command", "output"]],
      ["toolCall", ["inputJson", "output"]],
      ["webSearch", ["query", "resultsJson"]],
      ["plan", ["text"]],
      ["subagent", ["prompt", "result"]],
      ["backgroundTask", ["output"]],
      ["contextCompaction", ["summary"]],
      ["providerItem", ["json"]],
    ] as const) {
      const content = jsonObject(item?.[type]);

      for (const field of fields) {
        const value = content?.[field];

        if (!Predicate.isString(value) || value.length < MIN_DUPLICATE_CHARS) continue;
        const path = [phase, "item", type, field];
        strings.set(value, path);

        if (type === "toolCall" || type === "providerItem") {
          const serialized = structuredJson(value);

          if (serialized) structured.set(serialized, path);
        }
      }
    }

    const changes = jsonObject(item?.["fileChange"])?.["changes"];

    if (Array.isArray(changes))
      for (const [index, change] of changes.entries()) {
        const diff = jsonObject(change)?.["diff"];

        if (Predicate.isString(diff) && diff.length >= MIN_DUPLICATE_CHARS)
          strings.set(diff, [phase, "item", "fileChange", "changes", String(index), "diff"]);
      }
  }

  return { strings, structured };
}

function structuredJson(value: string): string | undefined {
  if (value.length < MIN_JSON_DUPLICATE_CHARS || !/^\s*[[{]/.test(value)) return undefined;

  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function replaceDuplicates(
  value: JsonValue,
  path: Path,
  mapped: MappedContent,
  refs: RawPayloadRef[],
  depth: number,
): JsonValue {
  if (depth > 64 || refs.length > 256) return value;

  if (Predicate.isString(value)) {
    const payload = mapped.strings.get(value);

    if (!payload) return value;
    refs.push({ raw: path, payload });

    return null;
  }

  if (
    (Array.isArray(value) || jsonObject(value)) &&
    mapped.structured.size &&
    STRUCTURED_KEYS.has(path.at(-1) ?? "item")
  ) {
    const payload = mapped.structured.get(JSON.stringify(value));

    if (payload) {
      refs.push({ raw: path, payload, json: true });

      return null;
    }
  }

  if (Array.isArray(value))
    return value.map((entry, index) => replaceDuplicates(entry, [...path, String(index)], mapped, refs, depth + 1));

  const object = jsonObject(value);

  return object
    ? Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [
          key,
          replaceDuplicates(entry, [...path, key], mapped, refs, depth + 1),
        ]),
      )
    : value;
}

function containsImage(value: JsonValue): boolean {
  const pending = [value];

  while (pending.length) {
    const next = pending.pop();

    if (Predicate.isString(next) && /(?:data:|^)image(?:\/|$)|canopyBlob/i.test(next)) return true;

    if (Array.isArray(next)) {
      for (const entry of next) pending.push(entry);
    } else {
      const object = jsonObject(next);

      if (!object) continue;

      for (const [key, entry] of Object.entries(object)) {
        if (/image|canopyblob/i.test(key)) return true;
        pending.push(entry);
      }
    }
  }

  return false;
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && Predicate.isObject(value)
    ? value
    : undefined;
}

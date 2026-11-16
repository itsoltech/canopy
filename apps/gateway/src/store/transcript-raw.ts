import type { JsonValue } from "@bufbuild/protobuf";
import { Predicate } from "effect";

const MIN_DUPLICATE_CHARS = 128;
const ITEM_KINDS = new Set(["item_started", "item_delta", "item_completed"]);

type Path = readonly string[];

export interface RawPayloadRef {
  readonly raw: Path;
  readonly payload: Path;
}

/** Retain all provider fields, substituting only exact copies of mapped text in this same event. */
export function compactEventRaw(kind: string, payload: JsonValue, rawJson: string) {
  if (!rawJson || !ITEM_KINDS.has(kind)) return undefined;
  let raw: JsonValue;

  try {
    // SAFETY: JSON.parse accepts only JSON scalars, arrays and objects; these are exactly JsonValue.
    raw = JSON.parse(rawJson) as JsonValue;
  } catch {
    // Invalid JSON must still reach the SQL cast and quarantine path unchanged.
    return undefined;
  }

  if (containsImage(raw) || containsImage(payload)) return undefined;
  const strings = mappedStrings(payload);

  if (!strings.size) return undefined;
  const refs: RawPayloadRef[] = [];
  const compact = replaceStrings(raw, [], strings, refs, 0);

  if (!refs.length || refs.length > 256) return undefined;
  const compactJson = JSON.stringify(compact);
  const refsJson = JSON.stringify(refs);

  // Count the actual serialized JSON, including the paths; never inflate short deltas.
  if (Buffer.byteLength(compactJson) + Buffer.byteLength(refsJson) >= Buffer.byteLength(rawJson)) return undefined;

  return { refs: refsJson };
}

function mappedStrings(payload: JsonValue): Map<string, Path> {
  const strings = new Map<string, Path>();
  const object = jsonObject(payload);
  const delta = jsonObject(object?.["itemDelta"]);

  if (Predicate.isString(delta?.["chunk"]) && delta["chunk"].length >= MIN_DUPLICATE_CHARS)
    strings.set(delta["chunk"], ["itemDelta", "chunk"]);

  for (const phase of ["itemStarted", "itemCompleted"]) {
    const item = jsonObject(jsonObject(object?.[phase])?.["item"]);

    for (const [type, fields] of [
      ["agentMessage", ["text"]],
      ["reasoning", ["text", "summary"]],
      ["commandExecution", ["output"]],
      ["toolCall", ["output"]],
      ["backgroundTask", ["output"]],
    ] as const) {
      const content = jsonObject(item?.[type]);

      for (const field of fields) {
        const value = content?.[field];

        if (Predicate.isString(value) && value.length >= MIN_DUPLICATE_CHARS)
          strings.set(value, [phase, "item", type, field]);
      }
    }
  }

  return strings;
}

function replaceStrings(
  value: JsonValue,
  path: Path,
  strings: ReadonlyMap<string, Path>,
  refs: RawPayloadRef[],
  depth: number,
): JsonValue {
  if (depth > 64 || refs.length > 256) return value;

  if (Predicate.isString(value)) {
    const payload = strings.get(value);

    if (!payload) return value;
    refs.push({ raw: path, payload });

    return null;
  }

  if (Array.isArray(value))
    return value.map((entry, index) => replaceStrings(entry, [...path, String(index)], strings, refs, depth + 1));

  const object = jsonObject(value);

  return object
    ? Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [
          key,
          replaceStrings(entry, [...path, key], strings, refs, depth + 1),
        ]),
      )
    : value;
}

function containsImage(value: JsonValue): boolean {
  const pending = [value];

  while (pending.length) {
    const next = pending.pop();

    if (Predicate.isString(next) && /data:image|canopyBlob/i.test(next)) return true;

    if (Array.isArray(next)) pending.push(...next);
    else {
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

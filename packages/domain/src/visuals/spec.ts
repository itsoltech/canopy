import { Result, Schema } from "effect";
import { isJsonObject, parseJson, type JsonValue } from "../json.ts";
import { VISUAL_LIMITS } from "./limits.ts";
import { VisualSpecSchema } from "./schema.ts";
import { resolveVisualState, visualTextBytes } from "./semantics.ts";
import type { VisualSpec, VisualStateDomain } from "./types.ts";
import { jsonDepthExceeds } from "./walk.ts";

export interface DecodedVisual {
  readonly spec: VisualSpec;
  readonly domains: ReadonlyMap<string, VisualStateDomain>;
  /** Canonical JSON of the spec, as stored and hashed. */
  readonly json: string;
}

// Node levels × the deepest container path (node → tabs → panel → children → node) plus the spec envelope.
const MAX_JSON_DEPTH = VISUAL_LIMITS.depth * 4 + 4;

const decodeStructure = Schema.decodeUnknownResult(VisualSpecSchema);

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Validates a spec in increasing cost order: serialized size, raw nesting, structure (unknown fields and tokens are
 * errors), then tree limits and state references. Messages name the failing path for the model.
 */
export function decodeVisualSpec(raw: JsonValue): Result.Result<DecodedVisual, string> {
  if (!isJsonObject(raw)) return Result.fail("spec must be an object");
  const serialized = JSON.stringify(raw);

  if (utf8Bytes(serialized) > VISUAL_LIMITS.specBytes)
    return Result.fail(`spec is larger than ${VISUAL_LIMITS.specBytes / 1024} KiB`);

  if (jsonDepthExceeds(raw, MAX_JSON_DEPTH))
    return Result.fail(`spec nesting is deeper than ${VISUAL_LIMITS.depth} levels`);
  const decoded = decodeStructure(raw, { onExcessProperty: "error" });

  if (Result.isFailure(decoded)) return Result.fail(decoded.failure.message);
  const spec = decoded.success;
  const { domains, problem } = resolveVisualState(spec);

  if (problem) return Result.fail(problem);

  if (visualTextBytes(raw) > VISUAL_LIMITS.textBytes)
    return Result.fail(`spec text is longer than ${VISUAL_LIMITS.textBytes / 1024} KiB`);

  return Result.succeed({ spec, domains, json: serialized });
}

/** Parses stored JSON (already validated when it was published) for rendering. */
export function parseVisualSpec(json: string): Result.Result<DecodedVisual, string> {
  if (utf8Bytes(json) > VISUAL_LIMITS.specBytes) return Result.fail("spec is too large");
  const raw = parseJson(json);

  return raw === undefined ? Result.fail("spec is not valid JSON") : decodeVisualSpec(raw);
}

export function initialVisualState(spec: VisualSpec) {
  return { ...spec.state };
}

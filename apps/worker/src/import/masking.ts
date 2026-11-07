import { join } from "node:path";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { decodeJson, isJsonObject, isString } from "../providers/json.ts";
import { CommandError } from "../runtime/host-types.ts";
import { readSourceText } from "./read.ts";
import { ExactMatcher, mergeSpans, pems, tokenSpans, type Span } from "./secret-matcher.ts";
import type { ImportRootPath } from "./source-key.ts";

/**
 * Masking of imported text (docs/import.md, "Bezpieczeństwo"), applied before anything leaves the worker:
 *
 * - exact values: every string the worker can see in the CLIs' login files, and the values under credential-like
 *   keys (env blocks, headers, tokens, keys) in their settings and MCP configuration, plus the instance environment;
 *   at least 12 characters long, at most MAX_SECRETS of them; found with one linear matcher, also in the forms JSON
 *   text writes them (once and twice escaped);
 * - token formats with a distinctive prefix (API keys, access tokens, private keys), found with a linear scan.
 *   Plain words such as `token = value` stay: they are common in code and the exact values cover what the worker
 *   knows.
 *
 * Each field is also checked in decoded views (JSON string escapes undone, up to DECODE_DEPTH times). A secret
 * found only there cannot be mapped back to a span of the field, so the whole field is hidden (fail closed).
 *
 * maskText, maskJson and maskedRecord are the only ways in: readers mask a parsed record before they take a prompt,
 * a title or a preview from it, and trim, join or cut text only after that.
 *
 * The native copy that a thread resumes from stays as it was, on this worker only.
 */

export const MASK = "[redacted]";

/** What a field becomes when a secret is found in it only after decoding. */
export const HIDDEN = "[hidden: contained a credential]";

const MIN_SECRET = 12;

/** Known secret values one masker holds at most: more is refused, not masked partly. */
export const MAX_SECRETS = 10_000;

/** JSON string escapes are undone this many times at most for the decoded views. */
const DECODE_DEPTH = 3;

/** JSON inside JSON inside a field is decoded this deep at most. */
const MAX_DEPTH = 8;

interface SecretFile {
  readonly name: string;
  /** A login file: every string counts. Otherwise only values under credential-like keys. */
  readonly login: boolean;
}

/** Login, settings and MCP files per CLI home (JSON or TOML). */
const SECRET_FILES: Readonly<Record<ImportRootPath["agentCli"], readonly SecretFile[]>> = {
  claude: [
    { name: ".credentials.json", login: true },
    { name: "settings.json", login: false },
    { name: "settings.local.json", login: false },
    { name: ".claude.json", login: false },
  ],
  codex: [
    { name: "auth.json", login: true },
    { name: "config.toml", login: false },
  ],
  grok: [
    { name: "auth.json", login: true },
    { name: "config.toml", login: false },
    { name: "settings.json", login: false },
  ],
};

export class Masker {
  readonly #exact: ExactMatcher;

  constructor(values: Iterable<string>) {
    const secrets = new Set([...values].filter((v) => v.length >= MIN_SECRET));

    if (secrets.size > MAX_SECRETS)
      throw new CommandError(
        "IMPORT_TOO_MANY_SECRETS",
        `the CLI settings hold more than ${MAX_SECRETS} credential values; nothing was imported`,
        false,
      );

    // Also as JSON text writes them (once and twice escaped): a secret inside JSON inside other text, such as a
    // command line, is found in the form it has there.
    this.#exact = new ExactMatcher(
      [...secrets].flatMap((v) => {
        const once = JSON.stringify(v).slice(1, -1);

        return [v, once, JSON.stringify(once).slice(1, -1)];
      }),
    );
  }

  /** Where secrets are in the text (known values and token formats), merged. */
  spans(text: string): Span[] {
    return mergeSpans([...this.#exact.spans(text), ...tokenSpans(text)]);
  }

  /**
   * Secrets in strings a reader joined by lines: known values and private key blocks (no token format crosses a
   * line break).
   */
  joinedSpans(text: string): Span[] {
    const found = this.#exact.spans(text);
    pems(text, found);

    return mergeSpans(found);
  }

  /** One field with secrets replaced, and how many were found. Use maskText, maskJson or maskedRecord. */
  field(text: string): { text: string; found: number } {
    const spans = this.spans(text);
    let out = "";
    let at = 0;

    for (const [start, end] of spans) {
      out += text.slice(at, start) + MASK;
      at = end;
    }

    out += text.slice(at);

    return this.#decodedClean(out) ? { text: out, found: spans.length } : { text: HIDDEN, found: spans.length + 1 };
  }

  /** Whether the masked field stays clean in its decoded views. */
  #decodedClean(text: string): boolean {
    let view = text;

    for (let depth = 0; depth < DECODE_DEPTH && view.includes("\\"); depth++) {
      const decoded = decodeEscapes(view);

      if (decoded === view) return true;

      if (this.#exact.spans(decoded).length > 0 || tokenSpans(decoded).length > 0) return false;
      view = decoded;
    }

    return true;
  }
}

const ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/** JSON string escapes undone once (`\uXXXX` as UTF-16 code units, so surrogate pairs join); others stay. */
export function decodeEscapes(text: string): string {
  let out = "";
  let at = 0;

  for (let i = text.indexOf("\\"); i >= 0 && i + 1 < text.length; i = text.indexOf("\\", at)) {
    const next = text[i + 1] ?? "";
    const simple = ESCAPES.get(next);
    const hex = next === "u" ? text.slice(i + 2, i + 6) : "";

    if (simple !== undefined) {
      out += text.slice(at, i) + simple;
      at = i + 2;
    } else if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      out += text.slice(at, i) + String.fromCharCode(Number.parseInt(hex, 16));
      at = i + 6;
    } else {
      out += text.slice(at, i + 1);
      at = i + 1;
    }
  }

  return out + text.slice(at);
}

/**
 * Masks text as decoded values: JSON inside it (tool arguments, structured output, a JSON-encoded string) is
 * decoded and masked value by value, down to MAX_DEPTH levels, and encoded again only when something was masked.
 */
export function maskText(text: string, masker: Masker, found: () => void = () => {}, depth = 0): string {
  const trimmed = text.trimStart();

  if (depth < MAX_DEPTH && (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"'))) {
    let decoded: JsonValue | undefined;

    try {
      decoded = decodeJson(JSON.parse(text));
    } catch {
      decoded = undefined;
    }

    if (decoded !== undefined) {
      let changed = false;

      const masked = maskJson(
        decoded,
        masker,
        () => {
          changed = true;
          found();
        },
        depth + 1,
      );

      // Formats that are JSON in name only stay as they were unless something was masked. The encoded result is
      // checked as a field too (its decoded views): a masked sibling never skips that check.
      if (changed) return fieldText(JSON.stringify(masked), masker, found);
    }
  }

  return fieldText(text, masker, found);
}

function fieldText(text: string, masker: Masker, found: () => void): string {
  const masked = masker.field(text);

  for (let i = 0; i < masked.found; i++) found();

  return masked.text;
}

/**
 * Every string and key in a JSON value masked with maskText; `found` is called once per secret. Readers join
 * strings of one value (content parts, a command and its arguments), so the strings and keys are also checked joined
 * in document order: a secret that spans two of them (a key's header in one part, its body in the next) hides every
 * string it touches.
 */
export function maskJson(value: JsonValue, masker: Masker, found: () => void, depth = 0): JsonValue {
  const hidden = joinedSecrets(value, masker);

  for (let i = 0; i < hidden.size; i++) found();

  return maskTree(value, { masker, found, depth, hidden, leaf: 0 });
}

interface TreeMasking {
  readonly masker: Masker;
  readonly found: () => void;
  readonly depth: number;
  /** Leaves (keys and strings, in document order) a joined secret touches. */
  readonly hidden: ReadonlySet<number>;
  leaf: number;
}

function maskLeaf(text: string, state: TreeMasking): string {
  return state.hidden.has(state.leaf++) ? HIDDEN : maskText(text, state.masker, state.found, state.depth);
}

function maskTree(value: JsonValue, state: TreeMasking): JsonValue {
  if (isString(value)) return maskLeaf(value, state);

  if (Array.isArray(value)) return value.map((v) => maskTree(v, state));

  if (!isJsonObject(value)) return value;
  const out: Record<string, JsonValue> = {};

  for (const [key, child] of Object.entries(value)) {
    const masked = maskLeaf(key, state);
    let name = masked;

    // Two keys masked alike stay two keys.
    for (let n = 2; name in out; n++) name = `${masked} ${n}`;
    out[name] = maskTree(child, state);
  }

  return out;
}

/** Leaves a secret spans when the value's keys and strings are joined as readers join them. */
function joinedSecrets(value: JsonValue, masker: Masker): Set<number> {
  const leaves: string[] = [];
  collectLeaves(value, leaves);

  return spanningSecrets(leaves, masker);
}

/**
 * Which of these strings, joined by lines in this order, a secret spans (it starts in one and ends in another):
 * those strings can only be hidden whole. For one record's strings, and for one turn's fields (finish in turns.ts).
 */
export function spanningSecrets(leaves: readonly string[], masker: Masker): Set<number> {
  const hidden = new Set<number>();

  if (leaves.length < 2) return hidden;

  // Readers join parts of one record by lines (or spaces, which no secret format crosses); records that are
  // streamed in chunks are joined by the readers first and masked as a whole (finish in turns.ts).
  for (const separator of ["\n"]) {
    const starts: number[] = [];
    let at = 0;

    for (const leaf of leaves) {
      starts.push(at);
      at += leaf.length + separator.length;
    }

    for (const [start, end] of masker.joinedSpans(leaves.join(separator))) {
      const first = lastStartAtOrBefore(starts, start);
      const last = lastStartAtOrBefore(starts, end - 1);

      for (let i = first; i <= last && last > first; i++) hidden.add(i);
    }
  }

  return hidden;
}

function collectLeaves(value: JsonValue, into: string[]): void {
  if (isString(value)) into.push(value);
  else if (Array.isArray(value)) for (const v of value) collectLeaves(v, into);
  else if (isJsonObject(value))
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      collectLeaves(child, into);
    }
}

/** Index of the leaf that contains this offset of the joined text. */
function lastStartAtOrBefore(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >> 1;

    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }

  return low;
}

/**
 * A source record masked as decoded values, before a reader takes anything from it: tool inputs become diffs,
 * prompts become previews and titles only after this, so a secret escaped inside JSON cannot slip through a
 * transform.
 */
export function maskedRecord(
  record: JsonObject | undefined,
  masker: Masker,
  found: () => void = () => {},
): JsonObject | undefined {
  if (!record) return undefined;
  const masked = maskJson(record, masker, found);

  return isJsonObject(masked) ? masked : undefined;
}

/** Secret values the worker can read for these roots, plus extra values (instance environment). */
export function loadMasker(roots: readonly ImportRootPath[], extra: Iterable<string>, userHome: string): Masker {
  const values = new Set<string>(extra);

  for (const root of roots) {
    for (const file of SECRET_FILES[root.agentCli])
      collect(readSmall(root.path, join(root.path, file.name)), file, values);
  }

  // Claude keeps MCP servers (with their env and headers) and the account in ~/.claude.json.
  collect(readSmall(userHome, join(userHome, ".claude.json")), { name: ".claude.json", login: false }, values);

  return new Masker(values);
}

function readSmall(root: string, path: string): string | undefined {
  return readSourceText({ root, path }, 4 * 1024 ** 2);
}

function collect(text: string | undefined, file: SecretFile, into: Set<string>): void {
  if (text === undefined) return;
  let parsed: JsonValue | undefined;

  try {
    parsed = file.name.endsWith(".toml") ? decodeJson(Bun.TOML.parse(text)) : decodeJson(JSON.parse(text));
  } catch {
    return;
  }

  // Settings files are mostly settings: only values under credential-like places (an `env` block, too) count.
  walk(parsed, file.login, into);
}

const SENSITIVE_KEY = /env|header|token|secret|key|auth|password|credential|bearer/i;

/** Settings that hold the name of a variable, not its value (Codex env_key, bearer_token_env_var, env_vars). */
const VARIABLE_NAME_KEY = /(?:^|_)env_(?:key|var|vars)$|^env_vars$/i;

function walk(value: JsonValue | undefined, sensitive: boolean, into: Set<string>): void {
  if (isString(value)) {
    if (sensitive) into.add(value);

    return;
  }

  if (Array.isArray(value)) {
    for (const v of value) walk(v, sensitive, into);

    return;
  }

  if (!isJsonObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (!VARIABLE_NAME_KEY.test(key)) walk(child, sensitive || SENSITIVE_KEY.test(key), into);
  }
}

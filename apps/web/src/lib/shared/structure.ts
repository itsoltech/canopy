import { humanizeEnum, humanizeKey, isEnumToken, isIdKey, isIsoDateTime, isOpaqueId } from "./humanize.ts";

/**
 * Any JSON value as something to show rather than to parse: fields with readable labels, ids set apart
 * (shown behind a copy action), enum tokens in words, dates, links, paths, long text and nested
 * objects and lists. The generic view of tool inputs and results (`StructuredView`) renders this.
 */
export type Node =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "long"; readonly text: string }
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "date"; readonly iso: string }
  | { readonly kind: "enum"; readonly label: string; readonly raw: string }
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "url"; readonly href: string }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "empty" }
  | { readonly kind: "list"; readonly items: readonly Node[] }
  | { readonly kind: "object"; readonly fields: readonly Field[] };

export interface Field {
  readonly key: string;
  readonly label: string;
  readonly node: Node;
}

/** Text longer than this, or with a line break, is shown as a block of its own. */
const LONG = 120;
/** Nesting below this depth stays a short JSON line (a value that deep is rarely read). */
const MAX_DEPTH = 6;

const isPath = (text: string) =>
  !/\s/.test(text) && (/^(\/|~\/|\.{1,2}\/)[^\s]*$/.test(text) || /^[\w.-]+(\/[\w.@-]+)+\.\w{1,8}$/.test(text));

/** A JSON value (or a JSON text inside a string) as a node; `key` helps tell ids and enums apart. */
export function structure(value: unknown, key = "", depth = 0): Node {
  if (value === null || value === undefined) return { kind: "empty" };
  if (typeof value === "boolean") return { kind: "bool", value };
  if (typeof value === "number" || typeof value === "bigint") return { kind: "number", text: String(value) };
  if (typeof value === "string") return leaf(value, key, depth);
  if (depth >= MAX_DEPTH) return { kind: "long", text: JSON.stringify(value) };
  if (Array.isArray(value)) return { kind: "list", items: value.map((item) => structure(item, singular(key), depth + 1)) };
  if (typeof value === "object") return { kind: "object", fields: fieldsOf(value as Record<string, unknown>, depth + 1) };
  return { kind: "text", text: String(value) };
}

/** The fields of an object, in its order. */
export function fieldsOf(record: Record<string, unknown>, depth = 0): Field[] {
  return Object.entries(record).map(([key, value]) => ({ key, label: humanizeKey(key), node: structure(value, key, depth) }));
}

function leaf(text: string, key: string, depth: number): Node {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  // JSON inside a string (answer_json, nested tool output): its structure, not its text.
  if (/^[[{]/.test(trimmed) && depth < MAX_DEPTH) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return structure(parsed, key, depth + 1);
    } catch {
      // Not JSON: text below.
    }
  }
  if (isOpaqueId(trimmed) || (isIdKey(key) && !/\s/.test(trimmed) && trimmed.length >= 8)) return { kind: "id", id: trimmed };
  if (isIsoDateTime(trimmed)) return { kind: "date", iso: trimmed };
  if (/^https?:\/\/\S+$/.test(trimmed)) return { kind: "url", href: trimmed };
  if (isPath(trimmed)) return { kind: "path", path: trimmed };
  if (isEnumToken(trimmed)) return { kind: "enum", label: humanizeEnum(trimmed), raw: trimmed };
  if (text.includes("\n") || text.length > LONG) return { kind: "long", text };
  return { kind: "text", text };
}

/** `thread_ids` → `thread_id`: list items are judged by the singular key. */
const singular = (key: string) => key.replace(/(Ids|_ids|IDs)$/, (m) => m.slice(0, -1)).replace(/s$/, "");

/** Nothing worth showing: an empty object, list or value. */
export function isEmptyNode(node: Node): boolean {
  return node.kind === "empty" || (node.kind === "list" && node.items.length === 0) || (node.kind === "object" && node.fields.length === 0);
}

/** A node short enough to sit on one line next to its label. */
export const isInline = (node: Node): boolean => !["long", "list", "object"].includes(node.kind) || isEmptyNode(node);

/** Parses JSON text into a node; text that is not JSON stays text (long when it has lines). */
export function structureJson(json: string): Node {
  const text = json.trim();
  if (!text) return { kind: "empty" };
  try {
    return structure(JSON.parse(text));
  } catch {
    return text.includes("\n") || text.length > LONG ? { kind: "long", text: json } : { kind: "text", text };
  }
}

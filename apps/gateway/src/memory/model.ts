import { Invalid } from "../store/errors.ts";

export type MemoryScope =
  | { kind: "project"; projectId: string }
  | { kind: "worker"; projectId: string; workerId: string }
  | { kind: "bot"; botId: string }
  | { kind: "conversation"; botId: string; conversationId: string };

export interface MemoryDraft {
  title: string;
  body: string;
  aliases?: readonly string[] | undefined;
  pinned?: boolean | undefined;
}

export interface MemorySource {
  kind: "thread" | "bot";
  id: string;
  turnId: string;
}

export interface MemoryNote {
  id: string;
  scope: MemoryScope;
  title: string;
  body: string;
  aliases: string[];
  pinned: boolean;
  revision: number;
  source?: MemorySource | undefined;
  createdAt?: Date | undefined;
  updatedAt: Date;
}

export interface SaveOptions {
  id?: string | undefined;
  expectedRevision?: number | undefined;
  source?: MemorySource | undefined;
  operationId?: string | undefined;
}

export class MemoryConflict extends Error {
  override readonly name = "MemoryConflict";
}

export function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Invalid("Invalid memory identifier.");
  }

  return value.toLowerCase();
}

export function scopeKey(scope: MemoryScope) {
  switch (scope.kind) {
    case "project":
      return `project:${uuid(scope.projectId)}`;
    case "worker":
      return `worker:${uuid(scope.projectId)}:${uuid(scope.workerId)}`;
    case "bot":
      return `bot:${uuid(scope.botId)}`;
    case "conversation":
      return `conversation:${uuid(scope.botId)}:${uuid(scope.conversationId)}`;
  }
}

export function scopeFromKey(key: string): MemoryScope {
  const [kind, parent, child] = key.split(":");

  if (parent) {
    if (kind === "project") return { kind, projectId: parent };

    if (kind === "worker" && child) return { kind, projectId: parent, workerId: child };

    if (kind === "bot") return { kind, botId: parent };

    if (kind === "conversation" && child) return { kind, botId: parent, conversationId: child };
  }

  throw new Error("Invalid stored memory scope.");
}

function checkedText(value: string, label: string, limit: number) {
  const trimmed = value.trim();

  if (!trimmed || trimmed.includes("\0") || trimmed.length > limit)
    throw new Invalid(`${label} must contain 1–${limit} characters.`);

  return trimmed;
}

export function checkedDraft(draft: MemoryDraft): MemoryDraft {
  if (draft.aliases && draft.aliases.length > 8) throw new Invalid("Use at most 8 aliases.");

  return {
    title: checkedText(draft.title, "Title", 160),
    body: checkedText(draft.body, "Body", 4000),
    ...(draft.aliases !== undefined && { aliases: draft.aliases.map((alias) => checkedText(alias, "Alias", 80)) }),
    ...(draft.pinned !== undefined && { pinned: draft.pinned }),
  };
}

export function checkedRevision(value: number | undefined) {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1)
    throw new Invalid("Provide the current note revision.");

  return value;
}

export interface NoteRow {
  id: string;
  scope_key: string;
  title: string;
  body: string;
  aliases: string[];
  pinned: boolean;
  revision: number;
  source_kind: "thread" | "bot" | null;
  source_id: string | null;
  source_turn_id: string | null;
  created_at: Date | null;
  updated_at: Date;
}

export function noteFromRow(row: NoteRow): MemoryNote {
  return {
    id: row.id,
    scope: scopeFromKey(row.scope_key),
    title: row.title,
    body: row.body,
    aliases: row.aliases,
    pinned: row.pinned,
    revision: row.revision,
    ...(row.created_at !== null && { createdAt: new Date(row.created_at) }),
    updatedAt: new Date(row.updated_at),
    ...(row.source_kind &&
      row.source_id &&
      row.source_turn_id && {
        source: { kind: row.source_kind, id: row.source_id, turnId: row.source_turn_id },
      }),
  };
}

export function pageLimit(limit: number | undefined, fallback: number, max: number) {
  if (limit === undefined || limit === 0) return fallback;

  if (!Number.isSafeInteger(limit) || limit < 1) throw new Invalid("Use a positive result limit.");

  return Math.min(max, limit);
}

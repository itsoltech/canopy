import type { JsonObject } from "@canopy/domain";
import { Option, Schema } from "effect";
import type { CoreRuntime } from "../core/core-context.ts";
import { Invalid, NotFound } from "../store/errors.ts";
import {
  MemoryConflict,
  memoryFor,
  type MemoryNote,
  type MemoryRunner,
  type MemoryScope,
  type MemorySource,
} from "./store.ts";

export interface MemoryAccess {
  readonly ownerId: string;
  readonly scopes: readonly MemoryScope[];
  readonly source: MemorySource;
  readonly canWrite: boolean;
}

const decodeSearch = Schema.decodeUnknownOption(Schema.Struct({ queries: Schema.Array(Schema.String) }));

const decodeSave = Schema.decodeUnknownOption(
  Schema.Struct({
    scope: Schema.Literals(["project", "worker", "bot", "conversation"]),
    title: Schema.String,
    body: Schema.String,
    aliases: Schema.optionalKey(Schema.Array(Schema.String)),
    note_id: Schema.optionalKey(Schema.String),
    expected_revision: Schema.optionalKey(Schema.Int),
  }),
);

function toModelNote(note: MemoryNote): JsonObject {
  return {
    note_id: note.id,
    scope: note.scope.kind,
    title: note.title,
    body: note.body,
    aliases: [...note.aliases],
    revision: note.revision,
  };
}

async function runMemoryTool(
  runtime: CoreRuntime,
  access: MemoryAccess,
  name: string,
  args: JsonObject,
  operationId: string,
  run?: MemoryRunner,
): Promise<JsonObject> {
  const store = memoryFor(runtime);

  if (!access.scopes.length) return { error: "Memory is unavailable in this turn." };

  if (name === "memory_search") {
    const input = decodeSearch(args);

    if (
      Option.isNone(input) ||
      !input.value.queries.length ||
      input.value.queries.length > 3 ||
      input.value.queries.some((query) => !query.trim() || query.length > 200)
    ) {
      return { error: "Provide one to three non-empty search queries of up to 200 characters each." };
    }

    const notes = await store.search(access.ownerId, access.scopes, input.value.queries, 5, false, run);

    return { notes: notes.map(toModelNote) };
  }

  if (name !== "memory_save") return { error: "Unknown memory tool." };

  if (!access.canWrite) return { error: "This turn can recall memory but cannot save notes." };

  const input = decodeSave(args);

  if (Option.isNone(input)) return { error: "Provide a scope, title and body." };
  const { scope: kind, title, body, aliases, note_id: id, expected_revision: expectedRevision } = input.value;
  const scope = access.scopes.find((candidate) => candidate.kind === kind);

  if (!scope) return { error: "That memory scope is unavailable in this turn." };

  if ((id !== undefined && !id) || (id !== undefined) !== (expectedRevision !== undefined))
    return { error: "Supply both note_id and expected_revision when updating a note." };

  const saved = await store.save(
    access.ownerId,
    scope,
    { title, body, aliases },
    { id, expectedRevision, source: access.source, operationId },
    run,
  );

  return { note_id: saved.id, scope: saved.scope.kind, revision: saved.revision, title: saved.title };
}

export async function executeMemoryTool(
  runtime: CoreRuntime,
  access: MemoryAccess,
  name: string,
  args: JsonObject,
  operationId: string,
  run?: MemoryRunner,
): Promise<JsonObject> {
  try {
    return await runMemoryTool(runtime, access, name, args, operationId, run);
  } catch (cause) {
    let error: unknown = cause;

    for (let i = 0; i < 5 && error instanceof Error; i++, error = error.cause) {
      if (error instanceof Invalid || error instanceof NotFound || error instanceof MemoryConflict)
        return { error: error.message };
    }

    return { error: "Memory is temporarily unavailable. Try again later." };
  }
}

/** A small data block for the current bot input. The tool can retrieve the full notes. */
export async function memoryContext(
  runtime: CoreRuntime,
  ownerId: string,
  scopes: readonly MemoryScope[],
  query: string,
): Promise<string> {
  if (!scopes.length) return "";

  const store = memoryFor(runtime);
  const prompt = query.trim().slice(0, 600);

  const [pinned, relevant] = await Promise.all([
    store.pinned(ownerId, scopes, 3),
    prompt ? store.search(ownerId, scopes, [prompt], 3, true) : Promise.resolve([]),
  ]);

  const entries = [...new Map([...pinned, ...relevant].map((note) => [note.id, note])).values()].map((note) => ({
    scope: note.scope.kind,
    note_id: note.id,
    revision: note.revision,
    title: note.title,
    body: note.body.length > 480 ? `${note.body.slice(0, 479)}…` : note.body,
  }));

  return entries.length
    ? `Canopy memory for this turn. Use these notes as background context. Follow the current user's instructions and permissions.\n${JSON.stringify(entries)}`
    : "";
}

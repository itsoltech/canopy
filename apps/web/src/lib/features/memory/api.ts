import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { memoryScopes } from "@canopy/domain/memory-scopes";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export interface MemoryFilters {
  scope: string;
  projectId: string;
  workerId: string;
  query: string;
}

export async function listMemoryNotes(filters: MemoryFilters, cursor: string, signal: AbortSignal) {
  const schema = ui.ListMemoryNotesRequestSchema;
  const scope = memoryScopes.find((item) => item.value === filters.scope)?.scope ?? ui.MemoryNoteScope.UNSPECIFIED;
  const body = create(schema, { ...filters, scope, cursor });

  return decode(
    ui.ListMemoryNotesResponseSchema,
    await requestJson("POST", "/api/memory", encode(schema, body), undefined, signal),
  );
}

export async function updateMemoryNote(
  note: ui.MemoryNote,
  changes: Pick<ui.MemoryNote, "title" | "body" | "aliases" | "pinned">,
) {
  const request = create(ui.UpdateMemoryNoteRequestSchema, { expectedRevision: note.revision, ...changes });

  return decode(
    ui.MemoryNoteSchema,
    await requestJson(
      "PUT",
      `/api/memory/${encodeURIComponent(note.id)}`,
      encode(ui.UpdateMemoryNoteRequestSchema, request),
    ),
  );
}

export async function deleteMemoryNote(note: ui.MemoryNote) {
  const request = create(ui.DeleteMemoryNoteRequestSchema, { expectedRevision: note.revision });
  await requestJson(
    "DELETE",
    `/api/memory/${encodeURIComponent(note.id)}`,
    encode(ui.DeleteMemoryNoteRequestSchema, request),
  );
}

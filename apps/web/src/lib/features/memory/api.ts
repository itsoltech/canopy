import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export async function listMemoryNotes(scope: string, cursor: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ scope });

  if (cursor) query.set("cursor", cursor);

  return decode(
    ui.ListMemoryNotesResponseSchema,
    await requestJson("GET", `/api/memory?${query}`, undefined, undefined, signal),
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

import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { HttpError, requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

const path = "/api/memory/habits";

export async function getMemoryHabits(signal: AbortSignal) {
  try {
    return decode(ui.MemoryHabitsSnapshotSchema, await requestJson("GET", path, undefined, undefined, signal));
  } catch (cause) {
    if (cause instanceof HttpError && cause.status === 426) return null;
    throw cause;
  }
}

export async function updateMemoryReflection(settings: ui.MemoryReflectionSettings, signal: AbortSignal) {
  const schema = ui.UpdateMemoryReflectionRequestSchema;

  return decode(
    ui.MemoryReflectionSettingsSchema,
    await requestJson("PUT", path, encode(schema, create(schema, { settings })), undefined, signal),
  );
}

export async function resolveMemoryHabit(
  suggestion: ui.MemoryHabitSuggestion,
  approve: boolean,
  rule: string,
  signal: AbortSignal,
) {
  const schema = ui.ResolveMemoryHabitRequestSchema;

  const body = create(schema, {
    expectedRevision: suggestion.revision,
    expectedNoteRevision: suggestion.noteRevision,
    approve,
    rule: approve ? rule : "",
  });

  await requestJson("POST", `${path}/${encodeURIComponent(suggestion.id)}`, encode(schema, body), undefined, signal);
}

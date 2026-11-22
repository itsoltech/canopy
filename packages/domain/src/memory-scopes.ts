import { ui } from "@canopy/contracts";

export const memoryScopes = [
  { value: "all", label: "All scopes", scope: ui.MemoryNoteScope.UNSPECIFIED },
  { value: "project", label: "Project", scope: ui.MemoryNoteScope.PROJECT },
  { value: "worker", label: "Worker", scope: ui.MemoryNoteScope.WORKER },
  { value: "bot", label: "Bot", scope: ui.MemoryNoteScope.BOT },
  { value: "conversation", label: "Conversation", scope: ui.MemoryNoteScope.CONVERSATION },
];

export function noteScopeLabel(note: ui.MemoryNote): string {
  const kind = memoryScopes.find((option) => option.scope === note.scope)?.label;

  return [kind, note.scopeLabel].filter(Boolean).join(" · ");
}

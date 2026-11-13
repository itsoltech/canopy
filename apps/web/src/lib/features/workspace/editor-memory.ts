import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import type { CodeEditorMemory } from "#lib/features/files/code-editor.ts";

const memories = new WeakMap<WorkspaceFile, CodeEditorMemory>();

/** A closed document releases its model with the document, without retaining editor DOM. */
export function editorMemory(document: WorkspaceFile): CodeEditorMemory {
  let memory = memories.get(document);

  if (!memory) {
    memory = {};
    memories.set(document, memory);
  }

  return memory;
}

export const forgetEditor = (document: WorkspaceFile): void => {
  memories.delete(document);
};

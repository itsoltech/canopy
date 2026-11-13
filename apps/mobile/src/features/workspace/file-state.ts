import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import type { ThreadFileState } from "../files/useThreadFile";
import type { FileConfirmationKind } from "../files/FileConfirmation";

export function workspaceFileState(
  view: Workspace,
  tab: WorkspaceTab,
  confirm: (kind: FileConfirmationKind) => void,
): ThreadFileState {
  const document = tab.document;

  return {
    file: document.file,
    lookup: document.lookup,
    text: document.text,
    draft: document.draft,
    dirty: document.dirty,
    editable: document.editable,
    editing: document.editing,
    loading: document.loading,
    busy: document.busy,
    error: document.error,
    setDraft: (text) => document.setDraft(text),
    reload: (selected) => {
      if (document.dirty) confirm("discard");
      else void document.load(selected);
    },
    edit: () => {
      view.keep(tab.id);
      document.edit();
    },
    discard: () => document.discard(),
    save: () => document.save(),
    remove: () => document.remove(),
  };
}

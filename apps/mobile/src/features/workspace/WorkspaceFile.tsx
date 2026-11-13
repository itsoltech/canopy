import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { fileName } from "@canopy/domain/file-references";
import { useContentPadding } from "../../ui/ScreenFrame";
import { FileActions } from "../files/FileActions";
import { FileConfirmation, type FileConfirmationKind } from "../files/FileConfirmation";
import { FilePreview } from "../files/FilePreview";
import { FileLookup } from "../files/FileLookup";
import type { ThreadFileState } from "../files/useThreadFile";
import { WorkspaceReader } from "./WorkspaceReader";
import { GoToLine } from "./GoToLine";

export function WorkspaceFile({ view, tab }: { view: Workspace; tab: WorkspaceTab }) {
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  const document = tab.document;
  const padding = useContentPadding(0);
  const [confirmation, setConfirmation] = useState<FileConfirmationKind>();
  const [go, setGo] = useState(false);

  useEffect(() => {
    if (!document.file) void document.load();

    return () => document.cancel();
  }, [document]);

  const viewer: ThreadFileState = {
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
      if (document.dirty) setConfirmation("discard");
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

  const name = fileName(document.path);

  const actions = (
    <FileActions
      viewer={viewer}
      onDiscard={() => (document.dirty ? setConfirmation("discard") : document.discard())}
      onDelete={() => setConfirmation("delete")}
    />
  );

  const textView = document.file && !document.file.binary && !document.editing;

  return (
    <View style={{ flex: 1, ...padding }}>
      {textView ? (
        <WorkspaceReader
          tab={tab}
          name={name}
          actions={actions}
          onKeep={() => view.keep(tab.id)}
          onLocate={() => setGo(true)}
        />
      ) : !document.file && document.lookup && !document.loading ? (
        <FileLookup file={document.lookup} name={name} onSelect={(path) => void document.load(path)} />
      ) : (
        <FilePreview
          viewer={viewer}
          name={name}
          detail={document.lookup?.relativePath || document.path}
          actions={actions}
          onDiscard={() => setConfirmation("discard")}
        />
      )}
      <FileConfirmation
        kind={confirmation}
        name={name}
        computer={document.lookup?.computer || "the thread’s computer"}
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => {
          if (confirmation === "delete")
            void document.remove().then((removed) => {
              if (removed) {
                setConfirmation(undefined);
                view.close(tab.id);
              }
            });
          else {
            document.discard();
            setConfirmation(undefined);
          }
        }}
      />
      <GoToLine document={document} visible={go} onClose={() => setGo(false)} />
    </View>
  );
}

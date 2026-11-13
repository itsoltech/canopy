import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { observeWorkspaceFile } from "@canopy/domain/workspace-changes";
import { Button } from "../../ui/Button";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import { fileName } from "@canopy/domain/file-references";
import { useContentPadding } from "../../ui/ScreenFrame";
import { FileActions } from "../files/FileActions";
import { FileConfirmation, type FileConfirmationKind } from "../files/FileConfirmation";
import { FilePreview } from "../files/FilePreview";
import { FileLookup } from "../files/FileLookup";
import { workspaceFileState } from "./file-state";
import { WorkspaceReader } from "./WorkspaceReader";
import { GoToLine } from "./GoToLine";
import { WorkspaceText } from "./WorkspaceText";
import { useAppActive } from "../../ui/active";
import { WorkspaceConflict } from "./WorkspaceConflict";

export function WorkspaceFile({ view, tab }: { view: Workspace; tab: WorkspaceTab }) {
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  const document = tab.document;
  const active = useAppActive();
  const padding = useContentPadding(0);
  const [confirmation, setConfirmation] = useState<FileConfirmationKind>();
  const [go, setGo] = useState(false);
  const [previewChanges, setPreviewChanges] = useState(false);
  const watchPath = document.file?.relativePath;
  useEffect(
    () => (active && watchPath ? observeWorkspaceFile(view.store, document) : undefined),
    [view.store, document, watchPath, active],
  );

  useEffect(() => {
    if (!document.editing) setPreviewChanges(false);
  }, [document.editing]);

  useEffect(() => {
    if (!active) return;

    if (!document.file) void document.load();

    return () => document.cancel();
  }, [document, active]);

  const viewer = workspaceFileState(view, tab, setConfirmation);

  const name = fileName(document.path);

  const actions = (
    <View style={{ gap: 8 }}>
      <FileActions
        viewer={viewer}
        onDiscard={() => (document.dirty ? setConfirmation("discard") : document.discard())}
        onDelete={() => setConfirmation("delete")}
      />
      {document.editing && (
        <Button
          size="sm"
          title={previewChanges ? "Keep editing" : "Preview changes"}
          disabled={document.busy}
          onPress={() => setPreviewChanges((value) => !value)}
        />
      )}
    </View>
  );

  const textView = document.file && !document.file.binary && !document.editing;

  return (
    <View style={{ flex: 1, ...padding }}>
      <WorkspaceConflict
        document={document}
        onDiscard={() => {
          if (document.dirty) setConfirmation("discard");
          else {
            document.discard();
            void document.load();
          }
        }}
      >
        {document.editing && previewChanges ? (
          <>
            <View style={{ padding: 12 }}>{actions}</View>
            <WorkspaceText document={document} draft={document.draft} />
          </>
        ) : textView ? (
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
      </WorkspaceConflict>
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
            const reload = document.changedOnDisk;
            document.discard();

            if (reload) void document.load();
            setConfirmation(undefined);
          }
        }}
      />
      <GoToLine document={document} visible={go} onClose={() => setGo(false)} />
    </View>
  );
}

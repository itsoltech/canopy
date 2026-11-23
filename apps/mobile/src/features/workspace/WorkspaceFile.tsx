import { useEffect, useState, useSyncExternalStore } from "react";
import { Keyboard, View } from "react-native";
import { observeWorkspaceFile } from "@canopy/domain/workspace-changes";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import type { Workspace, WorkspaceTab } from "@canopy/domain/workspace";
import type { WorkspaceFile as FileDocument } from "@canopy/domain/workspace-file";
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
import { isMarkdownFile, WorkspaceMarkdown } from "./WorkspaceMarkdown";
import { useAppActive } from "../../ui/active";
import { WorkspaceConflict } from "./WorkspaceConflict";
import { useOverview } from "../../state/overview";

interface WorkspaceFileProps {
  view: Workspace;
  tab: WorkspaceTab;
  removed?: boolean;
}

type FileMode = "edit" | "source" | "rendered";

const FILE_MODES: readonly { value: FileMode; label: string }[] = [
  { value: "edit", label: "Edit" },
  { value: "source", label: "Source" },
  { value: "rendered", label: "Rendered" },
];

function useFileAvailability(document: FileDocument, removed: boolean) {
  const overview = useOverview();
  const thread = overview.threads.find((item) => item.id === document.target.threadId);
  const worker = overview.workers.find((item) => item.id === thread?.workerId);
  useEffect(() => {
    document.availability(
      removed || thread?.worktree?.removedAt
        ? "This worktree was removed. Continue in a new worktree to edit files."
        : worker?.nodeId
          ? "Files on another computer are read only."
          : worker && !worker.online
            ? "This computer is offline. Reconnect it to edit files."
            : "",
    );
  }, [document, worker?.nodeId, worker?.online, thread?.worktree?.removedAt, removed]);
}

export function WorkspaceFile({ view, tab, removed = false }: WorkspaceFileProps) {
  useSyncExternalStore(view.store.subscribe, view.store.getVersion);
  const document = tab.document;
  useFileAvailability(document, removed);
  const active = useAppActive();
  const padding = useContentPadding(0);
  const [confirmation, setConfirmation] = useState<FileConfirmationKind>();
  const [go, setGo] = useState(false);
  const [mode, setMode] = useState<FileMode>("edit");
  const watchPath = document.file?.relativePath;
  useEffect(
    () => (active && watchPath ? observeWorkspaceFile(view.store, document) : undefined),
    [view.store, document, watchPath, active],
  );

  useEffect(() => {
    if (!active) return;

    if (!document.file) void document.load();

    return () => document.cancel();
  }, [document, active]);

  const viewer = workspaceFileState(view, tab, setConfirmation);
  const name = fileName(document.path);
  const markdown = isMarkdownFile(name);
  const rendered = viewer.editable && markdown && mode === "rendered";

  useEffect(() => {
    if (!document.editable && !markdown) setMode("edit");
  }, [document.editable, markdown]);

  function changeMode(next: FileMode) {
    if (next !== "edit") Keyboard.dismiss();
    setMode(next);
  }

  const actions = (
    <View style={{ gap: 8 }}>
      <FileActions
        viewer={viewer}
        saveDisabled={document.changedOnDisk}
        onDiscard={() => (document.dirty ? setConfirmation("discard") : document.discard())}
        onDelete={() => setConfirmation("delete")}
      />
      {markdown && viewer.editable ? (
        <Segmented options={FILE_MODES} value={mode} onChange={changeMode} />
      ) : document.editable ? (
        <Button
          size="sm"
          title={mode === "source" ? "Keep editing" : "Preview changes"}
          disabled={document.busy}
          onPress={() => changeMode(mode === "source" ? "edit" : "source")}
        />
      ) : null}
    </View>
  );

  const textView = document.file && !document.file.binary && !viewer.editable;

  const preview = rendered ? (
    <WorkspaceMarkdown text={viewer.draft} document={document} />
  ) : mode === "source" && (document.editable || (markdown && viewer.editable)) ? (
    <WorkspaceText document={document} draft={viewer.draft} />
  ) : undefined;

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
            preview={preview}
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

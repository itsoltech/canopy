import { useState } from "react";
import { fileName } from "@canopy/domain/file-references";
import { formatBytes } from "@canopy/domain/format";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { TextViewer } from "../viewers/TextViewer";
import { CopyAction } from "../viewers/copy-action";
import { FileActions } from "./FileActions";
import { FileConfirmation, type FileConfirmationKind } from "./FileConfirmation";
import { FilePreview } from "./FilePreview";
import { useThreadFile } from "./useThreadFile";

export function ThreadFileViewer({
  threadId,
  itemId,
  path,
  onClose,
}: {
  threadId: string;
  itemId: string;
  path: string;
  onClose: () => void;
}) {
  const viewer = useThreadFile(threadId, itemId, path);
  const [confirmation, setConfirmation] = useState<FileConfirmationKind>();
  const file = viewer.file;
  const name = fileName(path);
  const relative = viewer.lookup?.relativePath;
  const detail = [relative === name ? `./${name}` : relative, viewer.lookup?.computer].filter(Boolean).join(" · ");

  const close = () => {
    if (viewer.busy) return;

    if (viewer.dirty) setConfirmation("close");
    else onClose();
  };

  const actions = (
    <FileActions
      viewer={viewer}
      onDiscard={() => (viewer.dirty ? setConfirmation("discard") : viewer.discard())}
      onDelete={() => setConfirmation("delete")}
    />
  );

  const textView = file && !file.binary && !viewer.editing && !viewer.error && !viewer.loading;

  return (
    <>
      {textView ? (
        <TextViewer
          text={viewer.text}
          threadId={threadId}
          label={name}
          onClose={close}
          attachment
          markdown={/\.(md|markdown|mdx)$/i.test(name)}
          notice={`${detail} · ${formatBytes(file.size)}${file.truncated ? " · Showing the first 2 MB." : ""}`}
          extraActions={<CopyAction text={file.path} label="Copy path" />}
          toolbar={actions}
        />
      ) : (
        <FullScreenViewer
          title={name}
          onClose={close}
          actions={<CopyAction text={file?.path || path} label="Copy path" />}
        >
          <FilePreview
            viewer={viewer}
            name={name}
            detail={detail}
            actions={actions}
            onDiscard={() => setConfirmation("discard")}
          />
        </FullScreenViewer>
      )}
      <FileConfirmation
        kind={confirmation}
        name={relative || name}
        computer={viewer.lookup?.computer || "the thread’s computer"}
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => {
          const kind = confirmation;
          setConfirmation(undefined);

          if (kind === "delete") void viewer.remove().then((removed) => {
            if (removed) onClose();
          });
          else if (kind === "close") onClose();
          else if (viewer.error) viewer.reload();
          else viewer.discard();
        }}
      />
    </>
  );
}

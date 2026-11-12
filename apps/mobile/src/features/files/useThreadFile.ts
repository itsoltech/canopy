import { useEffect, useRef, useState } from "react";
import { FileResolution, type ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { attachmentFailure } from "../attachments/failure";
import { useAttachmentConnection } from "../attachments/useAttachmentConnection";
import { EDIT_BYTES, useFileMutation } from "./useFileMutation";

const PREVIEW_BYTES = 2 * 1024 * 1024;

/** A read is cancelable; mutations always use the resolved path and the hash of the displayed bytes. */
export function useThreadFile(threadId: string, itemId: string, path: string) {
  const { client } = useSession();
  const connection = useAttachmentConnection(threadId);
  const known = useRef({ path, sha256: "" });
  const [revision, setRevision] = useState(0);
  const [file, setFile] = useState<ui.ThreadFile>();
  const [lookup, setLookup] = useState<ui.ThreadFile>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const text = file && !file.binary ? new TextDecoder().decode(file.content) : "";
  const dirty = editing && draft !== text;
  const mutation = useFileMutation(threadId, file, (saved) => {
    setFile(saved);
    known.current = { path: saved.path, sha256: saved.sha256 };
    setEditing(false);
  });

  useEffect(() => {
    if (!client || editing || mutation.busy) return;

    const controller = new AbortController();
    setLoading(true);
    setError("");
    setFile(undefined);
    setLookup(undefined);
    void client.api
      .readThreadFile(
        { threadId, itemId, path: known.current.path, expectedSha256: known.current.sha256 },
        { signal: controller.signal, timeoutMs: 40_000 },
      )
      .then((response) => {
        if (controller.signal.aborted) return;

        if (response.content.length > PREVIEW_BYTES) throw new Error("Preview exceeds the byte limit");
        setLookup(response);

        if (response.resolution !== FileResolution.FOUND && response.resolution !== FileResolution.UNSPECIFIED)
          return;
        known.current = { path: response.path, sha256: response.sha256 };
        setFile(response);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(attachmentFailure(cause, "Could not open the file. Check the connection, then reload."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [client, threadId, itemId, revision, connection, editing, mutation.busy]);

  const reload = (selected?: string) => {
    if (selected) known.current = { path: selected, sha256: "" };
    mutation.clearError();
    setEditing(false);
    setRevision((value) => value + 1);
  };

  return {
    file,
    lookup,
    loading,
    editing,
    draft,
    dirty,
    text,
    reload,
    setDraft,
    error: error || mutation.error,
    busy: mutation.busy,
    editable: Boolean(file && !file.binary && !file.truncated && file.sha256 && file.size <= BigInt(EDIT_BYTES)),
    edit: () => {
      setDraft(text);
      setEditing(true);
    },
    discard: () => setEditing(false),
    save: () => mutation.mutate(draft),
    remove: () => mutation.mutate(),
  };
}

export type ThreadFileState = ReturnType<typeof useThreadFile>;

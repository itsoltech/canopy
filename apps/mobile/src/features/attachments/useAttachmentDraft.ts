import { useEffect, useRef, useState } from "react";
import { File } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useAppearance } from "../../state/appearance";
import { attachmentKind, type AttachmentKind } from "./attachment-display";
import { pasteImage, pickFiles, pickPhotos, type Picked } from "./pick-attachments";
import { useUpdateBlocker } from "../updates/useUpdateBlocker";

export interface DraftFile {
  key: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mimeType?: string;
  /** Local image or clipboard data URI, kept through upload success and failure. */
  previewUri?: string;
  /** Milliseconds, when the media picker supplies a video duration. */
  duration?: number;
  /** Native intake owns this preview copy; release it when the draft lets it go. */
  temporary?: boolean;
  /** Set once the gateway stored it (UploadAttachment). */
  attachment?: ui.Attachment;
  error?: string;
}

/** A file from a native paste or drop (modules/canopy-file-intake). */
export interface IntakeFile {
  uri?: string;
  name: string;
  size: number;
  mimeType?: string;
}

// The gateway's DEFAULT_ATTACHMENT_LIMITS (@canopy/domain) until GetSettings reports its own.
const fallback = { maxFileBytes: 20 * 1024 ** 2, maxMessageBytes: 50 * 1024 ** 2, maxFiles: 10 };

export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Files of the next message: each is uploaded as soon as it is picked; the message sends their ids.
 * Limits are checked before the upload, as the web composer does.
 */
export function useAttachmentDraft(
  onAdd?: (file: DraftFile) => void,
  options: {
    current?: { current: DraftFile[] };
    keepAlive?: boolean;
    botId?: string;
    imagesOnly?: boolean;
    onChange?: () => void;
  } = {},
) {
  const { client } = useSession();
  const { limits } = useAppearance();
  const [localFiles, setFiles] = useState<DraftFile[]>([]);
  // The same rows, readable at once by picks that land in one tick (several photos at a time).
  const local = useRef<DraftFile[]>([]);
  const current = options.current ?? local;
  const files = options.current ? current.current : localFiles;
  useUpdateBlocker(() => current.current.length > 0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;

      if (options.keepAlive) return;

      for (const file of current.current) discardPreview(file);
      current.current = [];
    };
  }, []);

  const apply = (next: (rows: DraftFile[]) => DraftFile[]) => {
    current.current = next(current.current);
    setFiles(current.current);
    options.onChange?.();
  };

  const max = draftLimits(limits);

  const patch = (key: string, change: Partial<DraftFile>) =>
    apply((rows) => rows.map((f) => (f.key === key ? { ...f, ...change } : f)));

  async function upload(picked: Picked) {
    // A system picker can return after its composer has gone away.
    if (!mounted.current && !options.keepAlive) return discard(picked);

    const key = Crypto.randomUUID();
    const total = current.current.reduce((sum, f) => sum + f.size, 0) + picked.size;

    const error =
      options.imagesOnly &&
      !(
        picked.kind === "image" &&
        (/^image\/(png|jpeg|gif|webp)$/.test(picked.mimeType ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(picked.name))
      )
        ? "Attach a PNG, JPEG, GIF or WebP image."
        : current.current.length >= max.maxFiles
          ? `Attach up to ${max.maxFiles} files.`
          : picked.size > max.maxFileBytes
            ? `Files can be up to ${fileSize(max.maxFileBytes)}.`
            : total > max.maxMessageBytes
              ? `A message can carry up to ${fileSize(max.maxMessageBytes)}.`
              : undefined;

    const file: DraftFile = {
      key,
      name: picked.name,
      size: picked.size,
      kind: picked.kind,
      mimeType: picked.mimeType,
      previewUri: picked.kind === "image" ? (picked.previewUri ?? picked.uri) : undefined,
      duration: picked.duration,
      temporary: picked.temporary,
      error,
    };

    apply((rows) => [...rows, file]);
    onAdd?.(file);

    if (error || !client) {
      if (!file.previewUri) discard(picked);

      return;
    }

    try {
      const data = picked.data ?? new Uint8Array(await read(picked));

      if (!current.current.some((f) => f.key === key)) return;

      const result = await client.api.uploadAttachment(
        { name: picked.name, data, botId: options.botId },
        { timeoutMs: 120_000 },
      );

      patch(key, { attachment: result.attachment });
    } catch {
      patch(key, { error: "Could not upload. Remove it and try again." });
    }
  }

  /** Files pasted into the text or dropped on the thread (copied by the native module, or only named when too large). */
  function addIntake(list: IntakeFile[]) {
    for (const file of list)
      void upload({
        uri: file.uri,
        name: file.name,
        size: file.size,
        kind: attachmentKind(file.name, file.mimeType),
        mimeType: file.mimeType,
        temporary: true,
      });
  }

  const uploading = files.some((f) => !f.attachment && !f.error);
  const failed = files.some((f) => f.error);

  return {
    files,
    ids: files.flatMap((f) => (f.attachment ? [f.attachment.id] : [])),
    pickPhotos: () => pickPhotos(upload, max.maxFiles - current.current.length, options.imagesOnly),
    pickFiles: () => pickFiles(upload, options.imagesOnly),
    pasteImage: () => pasteImage(upload),
    addIntake,
    /** The largest file the gateway takes: native pastes and drops copy nothing bigger. */
    maxFileBytes: max.maxFileBytes,
    imagesOnly: options.imagesOnly,
    remove: (key: string) =>
      apply((rows) => {
        for (const file of rows) if (file.key === key) discardPreview(file);

        return rows.filter((f) => f.key !== key);
      }),
    clear: () =>
      apply((rows) => {
        for (const file of rows) discardPreview(file);

        return [];
      }),
    /** Why the message cannot go yet. */
    blocker: uploading ? "Uploading files…" : failed ? "Remove the files that could not be attached." : undefined,
  };
}

async function read(picked: Picked) {
  if (!picked.uri) throw new Error("not copied");

  try {
    return await new File(picked.uri).arrayBuffer();
  } finally {
    // Native intake images remain readable by the thumbnail until remove, send or unmount.
    if (picked.kind !== "image") discard(picked);
  }
}

function discard(picked: Picked) {
  if (!picked.temporary || !picked.uri) return;

  try {
    new File(picked.uri).delete();
  } catch {
    /* Gone already; the module clears its folder on the next start. */
  }
}

function discardPreview(file: DraftFile) {
  if (!file.temporary || !file.previewUri) return;

  try {
    new File(file.previewUri).delete();
  } catch {
    /* Gone already; native intake clears stale copies on the next start. */
  }
}

function draftLimits(limits: ui.AttachmentLimits | undefined) {
  return limits?.maxFiles
    ? {
        maxFileBytes: Number(limits.maxFileBytes),
        maxMessageBytes: Number(limits.maxMessageBytes),
        maxFiles: limits.maxFiles,
      }
    : fallback;
}

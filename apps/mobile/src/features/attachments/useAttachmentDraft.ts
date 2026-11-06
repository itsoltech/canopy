import { useRef, useState } from "react";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useAppearance } from "../../state/appearance";

export interface DraftFile {
  key: string;
  name: string;
  size: number;
  kind: "image" | "file";
  /** Set once the gateway stored it (UploadAttachment). */
  attachment?: ui.Attachment;
  error?: string;
}

interface Picked {
  uri: string;
  name: string;
  size: number;
  kind: DraftFile["kind"];
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
export function useAttachmentDraft(onAdd?: (file: DraftFile) => void) {
  const { client } = useSession();
  const { limits } = useAppearance();
  const [files, setFiles] = useState<DraftFile[]>([]);
  // The same rows, readable at once by picks that land in one tick (several photos at a time).
  const current = useRef<DraftFile[]>([]);

  const apply = (next: (rows: DraftFile[]) => DraftFile[]) => {
    current.current = next(current.current);
    setFiles(current.current);
  };

  const max = limits?.maxFiles
    ? {
        maxFileBytes: Number(limits.maxFileBytes),
        maxMessageBytes: Number(limits.maxMessageBytes),
        maxFiles: limits.maxFiles,
      }
    : fallback;

  const patch = (key: string, change: Partial<DraftFile>) =>
    apply((rows) => rows.map((f) => (f.key === key ? { ...f, ...change } : f)));

  async function upload(picked: Picked) {
    const key = Crypto.randomUUID();
    const total = current.current.reduce((sum, f) => sum + f.size, 0) + picked.size;

    const error =
      current.current.length >= max.maxFiles
        ? `Attach up to ${max.maxFiles} files.`
        : picked.size > max.maxFileBytes
          ? `Files can be up to ${fileSize(max.maxFileBytes)}.`
          : total > max.maxMessageBytes
            ? `A message can carry up to ${fileSize(max.maxMessageBytes)}.`
            : undefined;

    const file: DraftFile = { key, name: picked.name, size: picked.size, kind: picked.kind, error };

    apply((rows) => [...rows, file]);
    onAdd?.(file);

    if (error || !client) return;

    try {
      const data = new Uint8Array(await new File(picked.uri).arrayBuffer());
      const result = await client.api.uploadAttachment({ name: picked.name, data }, { timeoutMs: 120_000 });
      patch(key, { attachment: result.attachment });
    } catch {
      patch(key, { error: "Could not upload. Remove it and try again." });
    }
  }

  async function pickPhotos() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, max.maxFiles - current.current.length),
      quality: 1,
    });

    if (result.canceled) return;

    for (const asset of result.assets)
      void upload({
        uri: asset.uri,
        name: asset.fileName || `photo-${Date.now()}.jpg`,
        size: asset.fileSize ?? 0,
        kind: "image",
      });
  }

  async function pickFiles() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });

    if (result.canceled) return;

    for (const asset of result.assets)
      void upload({
        uri: asset.uri,
        name: asset.name,
        size: asset.size ?? 0,
        kind: asset.mimeType?.startsWith("image/") ? "image" : "file",
      });
  }

  const uploading = files.some((f) => !f.attachment && !f.error);
  const failed = files.some((f) => f.error);

  return {
    files,
    ids: files.flatMap((f) => (f.attachment ? [f.attachment.id] : [])),
    pickPhotos,
    pickFiles,
    remove: (key: string) => apply((rows) => rows.filter((f) => f.key !== key)),
    clear: () => apply(() => []),
    /** Why the message cannot go yet. */
    blocker: uploading ? "Uploading files…" : failed ? "Remove the files that could not be attached." : undefined,
  };
}

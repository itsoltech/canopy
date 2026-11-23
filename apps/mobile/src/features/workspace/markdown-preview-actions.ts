import { Linking } from "react-native";
import { base64Encode } from "@bufbuild/protobuf/wire";
import { fileLocation, fileLinkHrefOf } from "@canopy/domain/file-references";
import { num, parseObject, str } from "@canopy/domain/json";
import { safeHref } from "@canopy/domain/markdown";
import { workspaceImagePath } from "@canopy/domain/markdown-images";
import { workspaceImageContent } from "@canopy/domain/markdown-workspace-image";
import { FILE_PREVIEW_BYTES, type WorkspaceFile } from "@canopy/domain/workspace-file";
import type { Workspace } from "@canopy/domain/workspace";
import { copyText } from "../viewers/useCopyText";
import bundle from "./markdown-preview.generated.json";

const MERMAID_CHUNK = 512 * 1024;

export async function handlePreviewMessage(
  raw: string,
  document: WorkspaceFile,
  view: Workspace | undefined,
  signal: AbortSignal,
  ready: () => void,
): Promise<string | undefined> {
  if (raw.length > FILE_PREVIEW_BYTES * 6 + 256) return;
  const message = parseObject(raw);
  const action = str(message["action"]);

  if (action === "ready") {
    ready();

    return;
  }

  const id = num(message["id"]);

  if (!Number.isSafeInteger(id) || id < 1) return;
  const value = str(message["value"]);

  try {
    const result = await previewAction(action, value, document, view, signal);

    return JSON.stringify({ id, ok: result !== undefined, value: result });
  } catch {
    return JSON.stringify({ id, ok: false });
  }
}

async function previewAction(
  action: string,
  value: string,
  document: WorkspaceFile,
  view: Workspace | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (action === "copy") return value.length <= FILE_PREVIEW_BYTES && (await copyText(value)) ? "" : undefined;

  if (value.length > 4096) return;

  if (action === "mermaid") {
    const index = Number(value);

    if (Number.isSafeInteger(index) && index >= 0)
      return bundle.mermaid.slice(index * MERMAID_CHUNK, (index + 1) * MERMAID_CHUNK);

    return;
  }

  if (action === "image") {
    const path = workspaceImagePath(document.path, value);

    if (!path) return;
    const file = await document.api.read(document.target, path, "", signal);
    const image = workspaceImageContent(file);

    if (image && !signal.aborted) return `data:${image.mimeType};base64,${base64Encode(image.bytes)}`;

    return;
  }

  if (action === "external") {
    const href = safeHref(value);

    if (!href) return;
    await Linking.openURL(href);

    return "";
  }

  if (action !== "file" && action !== "copy-full-path" && action !== "copy-relative-path") return;
  const location = fileLocation(fileLinkHrefOf(value) ?? value);

  if (!location.path || location.path.includes("\0") || /[\r\n]/.test(location.path)) return;

  if (action === "file") {
    const { threadId, itemId } = document.target;
    const target = { threadId, ...location };
    view?.open(itemId ? { ...target, itemId } : target);

    return "";
  }

  const file = await document.api.read(document.target, location.path, "", signal);
  const path = action === "copy-full-path" ? file.path : file.relativePath;

  if (path && !signal.aborted && (await copyText(path))) return "";
}

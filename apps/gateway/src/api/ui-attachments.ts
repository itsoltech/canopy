import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function attachmentsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  "uploadAttachment" | "getAttachment" | "getThreadBlob" | "listMentionCatalog" | "searchFiles" | "searchThreads"
> {
  return {
    uploadAttachment: (request) =>
      guard(async () =>
        create(ui.UploadAttachmentResponseSchema, {
          attachment: await core.uploadAttachment(request.name, request.data),
        }),
      ),

    getAttachment: (request) =>
      guard(() => core.getAttachment(request.attachmentId, request.thumbnail, request.preview)),

    getThreadBlob: (request) => guard(() => core.getThreadBlob(request.threadId, request.sha256)),

    listMentionCatalog: (request) => guard(() => core.listMentionCatalog(request)),

    searchFiles: (request) => guard(() => core.searchFiles(request)),

    searchThreads: (request) => guard(() => core.searchThreads(request)),
  };
}

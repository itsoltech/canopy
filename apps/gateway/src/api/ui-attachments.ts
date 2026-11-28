import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { getThreadVisual } from "../core/visual-publication.ts";
import { coreState } from "../core/core-context.ts";
import { artifactBatches, localThreadArtifacts } from "../store/thread-artifacts.ts";
import { PLAIN } from "./routed-context.ts";
import { Invalid } from "../store/errors.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function attachmentsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "uploadAttachment"
  | "getAttachment"
  | "getThreadBlob"
  | "getVisual"
  | "listThreadArtifacts"
  | "listMentionCatalog"
  | "searchIssues"
  | "searchFiles"
  | "searchThreads"
> {
  return {
    uploadAttachment: (request) =>
      guard(async () => {
        if (request.botId) await core.bots.get(request.botId);

        return create(ui.UploadAttachmentResponseSchema, {
          attachment: await core.uploadAttachment(request.name, request.data),
        });
      }),

    getAttachment: (request) =>
      guard(() => core.getAttachment(request.attachmentId, request.thumbnail, request.preview, request)),

    getThreadBlob: (request) => guard(() => core.getThreadBlob(request.threadId, request.sha256)),

    getVisual: (request) => guard(() => getThreadVisual(core, request)),

    listThreadArtifacts: async function* (request) {
      const items = await guard(() => {
        if (!PLAIN.test(request.threadId)) throw new Invalid("Invalid thread ID");

        return core[coreState].actions.run(localThreadArtifacts(core[coreState].options.userId, request.threadId));
      });

      yield* artifactBatches(items);
    },

    listMentionCatalog: (request) => guard(() => core.listMentionCatalog(request)),

    searchFiles: (request) => guard(() => core.searchFiles(request)),

    searchIssues: (request, context) => guard(() => core.connectors.searchIssues(request, context.signal, core.github)),

    searchThreads: (request) => guard(() => core.searchThreads(request)),
  };
}

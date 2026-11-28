import type { GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Moving a thread with its session and files to another worker of this gateway (docs/thread-transfers.md). */
export function threadTransferHandlers(
  core: GatewayCore,
): Pick<UiHandlers, "previewThreadTransfer" | "startThreadTransfer" | "getThreadTransfer"> {
  return {
    previewThreadTransfer: (request) => guard(() => core.threadTransfers.preview(request)),
    startThreadTransfer: (request) => guard(() => core.threadTransfers.start(request)),
    getThreadTransfer: (request) => guard(() => core.threadTransfers.get(request)),
  };
}

import type { GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

type RewindHandlers = Pick<
  UiHandlers,
  "prepareThreadRewind" | "rewindThread" | "restoreThreadRewind" | "getThreadRewind"
>;

export function rewindHandlers(core: GatewayCore): RewindHandlers {
  return {
    prepareThreadRewind: (request) => guard(() => core.prepareThreadRewind(request)),
    rewindThread: (request) => guard(() => core.rewindThread(request)),
    restoreThreadRewind: (request) => guard(() => core.restoreThreadRewind(request)),
    getThreadRewind: (request) => guard(() => core.getThreadRewind(request)),
  };
}

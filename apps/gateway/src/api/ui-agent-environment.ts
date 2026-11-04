import type { GatewayCore } from "../core/core.ts";
import { workerGuard } from "../core/worker-administration.ts";
import type { UiHandlers } from "./ui-service.ts";

export function agentEnvironmentHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getAgentEnvironment"
  | "saveInstructionDocument"
  | "deleteInstructionDocument"
  | "setEnvironmentTags"
  | "previewAgentEnvironment"
  | "resolveEnvironmentDrift"
> {
  return {
    getAgentEnvironment: () => workerGuard(() => core.environment.snapshot()),
    saveInstructionDocument: (r) => workerGuard(() => core.environment.save(r)),
    deleteInstructionDocument: (r) => workerGuard(() => core.environment.remove(r)),
    setEnvironmentTags: (r) => workerGuard(() => core.environment.tags(r)),
    previewAgentEnvironment: (r) => workerGuard(() => core.environment.preview(r)),
    resolveEnvironmentDrift: (r) => workerGuard(() => core.environment.resolve(r)),
  };
}

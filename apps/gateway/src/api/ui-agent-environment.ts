import type { GatewayCore } from "../core/core.ts";
import { workerGuard } from "../core/worker-administration.ts";
import type { UiHandlers } from "./ui-service.ts";
import { setWorkerEnvironmentOverride, workerEnvironment } from "../agent-environment/worker-settings.ts";

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
  | "saveLibrarySkill"
  | "deleteLibrarySkill"
  | "resolveSkillDrift"
  | "previewSkillSource"
  | "addSkillSource"
  | "checkSkillSource"
  | "applySkillSource"
  | "previewMarketplace"
  | "saveMarketplace"
  | "deleteMarketplace"
  | "saveLibraryPlugin"
  | "deleteLibraryPlugin"
  | "resolvePluginDrift"
  | "getWorkerEnvironment"
  | "setWorkerEnvironmentOverride"
> {
  return {
    getWorkerEnvironment: (r) => workerGuard(() => workerEnvironment(core.environment, r.workerId)),
    setWorkerEnvironmentOverride: (r) => workerGuard(() => setWorkerEnvironmentOverride(core.environment, r)),
    getAgentEnvironment: (r) => workerGuard(() => core.environment.snapshot(r)),
    saveInstructionDocument: (r) => workerGuard(() => core.environment.save(r)),
    deleteInstructionDocument: (r) => workerGuard(() => core.environment.remove(r)),
    setEnvironmentTags: (r) => workerGuard(() => core.environment.tags(r)),
    previewAgentEnvironment: (r) => workerGuard(() => core.environment.preview(r)),
    resolveEnvironmentDrift: (r) => workerGuard(() => core.environment.resolve(r)),
    saveLibrarySkill: (r) => workerGuard(() => core.environment.skills.save(r)),
    deleteLibrarySkill: (r) => workerGuard(() => core.environment.skills.remove(r)),
    resolveSkillDrift: (r) => workerGuard(() => core.environment.skills.resolve(r)),
    previewSkillSource: (r) => workerGuard(() => core.environment.sources.preview(r)),
    addSkillSource: (r) => workerGuard(() => core.environment.sources.add(r)),
    checkSkillSource: (r) => workerGuard(() => core.environment.sources.check(r)),
    applySkillSource: (r) => workerGuard(() => core.environment.sources.apply(r)),
    previewMarketplace: (r) => workerGuard(() => core.environment.marketplaces.preview(r)),
    saveMarketplace: (r) => workerGuard(() => core.environment.marketplaces.save(r)),
    deleteMarketplace: (r) => workerGuard(() => core.environment.marketplaces.remove(r)),
    saveLibraryPlugin: (r) => workerGuard(() => core.environment.plugins.save(r)),
    deleteLibraryPlugin: (r) => workerGuard(() => core.environment.plugins.remove(r)),
    resolvePluginDrift: (r) => workerGuard(() => core.environment.plugins.resolve(r)),
  };
}

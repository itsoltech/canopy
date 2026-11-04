import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

export function providersHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "listModels"
  | "listProviderInstances"
  | "saveProviderInstance"
  | "deleteProviderInstance"
  | "setInstanceWorkers"
  | "setInstanceWorker"
  | "setInstanceModels"
  | "refreshProviders"
  | "startProviderLogin"
> {
  return {
    listModels: (request) =>
      guard(async () => create(ui.ListModelsResponseSchema, { workers: await core.listModels(request) })),

    listProviderInstances: () =>
      guard(async () =>
        create(ui.ListProviderInstancesResponseSchema, { instances: await core.listProviderInstances() }),
      ),

    saveProviderInstance: (request) =>
      guard(async () =>
        create(ui.SaveProviderInstanceResponseSchema, { instance: await core.saveProviderInstance(request) }),
      ),

    deleteProviderInstance: (request) =>
      guard(async () => {
        await core.deleteProviderInstance(request);

        return create(ui.DeleteProviderInstanceResponseSchema, {});
      }),

    setInstanceWorkers: (request) =>
      guard(async () =>
        create(ui.SetInstanceWorkersResponseSchema, { instance: await core.setInstanceWorkers(request) }),
      ),

    setInstanceWorker: (request) =>
      guard(async () =>
        create(ui.SetInstanceWorkerResponseSchema, { instance: await core.setInstanceWorker(request) }),
      ),

    setInstanceModels: (request) =>
      guard(async () =>
        create(ui.SetInstanceModelsResponseSchema, { instance: await core.setInstanceModels(request) }),
      ),

    refreshProviders: (request) => guard(() => core.refreshProviders(request)),

    startProviderLogin: (request) => guard(() => core.startProviderLogin(request)),
  };
}

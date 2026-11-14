import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { credentialGuard as guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";
import { Code, ConnectError } from "@connectrpc/connect";

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
  | "listProxies"
  | "saveProxy"
  | "deleteProxy"
  | "testProxy"
  | "refreshProxyAccounts"
  | "moveInstanceToProxy"
  | "getInstanceWorker"
> {
  return {
    getInstanceWorker: (request) =>
      guard(async () => {
        const instance = (await core.listProviderInstances()).find(
          (i) => i.harness === request.harness && i.id === request.id,
        );

        const worker = instance?.workers.find((w) => w.workerId === request.workerId);

        if (!worker) throw new ConnectError("Worker not found. Choose another worker.", Code.NotFound);

        return create(ui.GetInstanceWorkerResponseSchema, { worker, inheritedRuntime: instance?.runtime });
      }),
    listProxies: () => guard(async () => create(ui.ListProxiesResponseSchema, { proxies: await core.listProxies() })),
    saveProxy: (request) => guard(async () => create(ui.ProxyResponseSchema, { proxy: await core.saveProxy(request) })),
    deleteProxy: (request) =>
      guard(async () => {
        await core.deleteProxy(request);

        return create(ui.DeleteProxyResponseSchema);
      }),
    testProxy: (request) => guard(() => core.testProxy(request)),
    refreshProxyAccounts: (request) => guard(() => core.refreshProxyAccounts(request)),
    moveInstanceToProxy: (request) =>
      guard(async () =>
        create(ui.SaveProviderInstanceResponseSchema, { instance: await core.moveInstanceToProxy(request) }),
      ),
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

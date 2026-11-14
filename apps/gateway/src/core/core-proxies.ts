import { ui } from "@canopy/contracts";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { coreConfigsChanged, coreInstances } from "./core-providers.ts";

export interface CoreProxyMethods {
  listProxies(): Promise<ui.Proxy[]>;
  saveProxy(request: ui.SaveProxyRequest): Promise<ui.Proxy>;
  deleteProxy(request: ui.ProxyIdRequest): Promise<void>;
  testProxy(request: ui.ProxyIdRequest): Promise<ui.TestProxyResponse>;
  refreshProxyAccounts(request: ui.RefreshProxyAccountsRequest): Promise<ui.ProxyAccounts>;
  moveInstanceToProxy(request: ui.MoveInstanceToProxyRequest): Promise<ui.ProviderInstance>;
}

export const coreProxyMethods: CoreProxyMethods = {
  async listProxies(this: GatewayCore) {
    return this.proxyAccounts.decorate(await coreInstances(this, (s) => s.listProxies(this[coreState].options.userId)));
  },
  async saveProxy(this: GatewayCore, request) {
    const result = await coreInstances(this, (s) => s.saveProxy(this[coreState].options.userId, request));
    await coreConfigsChanged(this, result.changed);

    // A new key or URL reads again; the reply does not wait for the proxy.
    if (request.managementKey !== undefined || request.baseUrl !== result.proxy.baseUrl) {
      this.proxyAccounts.forget(result.proxy.id);

      if (result.proxy.managementKeySet) void this.proxyAccounts.refresh(result.proxy.id, true).catch(() => {});
    }

    return this.proxyAccounts.decorate([result.proxy])[0]!;
  },
  async deleteProxy(this: GatewayCore, request) {
    await coreInstances(this, (s) => s.deleteProxy(this[coreState].options.userId, request));
    this.proxyAccounts.forget(request.id);
  },
  refreshProxyAccounts(this: GatewayCore, request) {
    return this.proxyAccounts.refresh(request.id, request.force);
  },
  testProxy(this: GatewayCore, request) {
    return coreInstances(this, (s) => s.testProxy(this[coreState].options.userId, request));
  },
  async moveInstanceToProxy(this: GatewayCore, request) {
    const result = await coreInstances(this, (s) => s.moveInstanceToProxy(this[coreState].options.userId, request));
    await coreConfigsChanged(this, result.changed);

    return coreInstances(this, (s) => s.get(result.harness, result.id));
  },
};

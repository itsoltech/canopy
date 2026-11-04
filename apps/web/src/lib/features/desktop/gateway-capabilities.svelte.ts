import { getContext, setContext } from "svelte";
import { isJsonObject, isString } from "#lib/shared/json.ts";
import { requestJson } from "#lib/shared/http.ts";

const sections = {
  "/bots": ["ListBots", "GetBot", "SendBotMessage"],
  "/settings/providers": ["ListProviderInstances", "SaveProviderInstance"],
  "/settings/connectors": ["ListConnectors", "SaveConnectorAccount"],
  "/settings/workers": ["GetWorkerSetup", "CreateWorkerEnrollment"],
  "/settings/network": ["GetNetworkAccess", "UpdateNetworkAccess"],
  "/settings/mobile": ["GetMobileDevices", "CreateDesktopPairing"],
  "/settings/computers": ["GetComputers", "ManageComputer"],
  "/settings/schedules": ["ListSchedules", "CreateSchedule"],
  "/settings/projects": ["GetOverview", "CreateProject"],
};

export class GatewayCapabilities {
  state = $state("ready");
  message = $state("");
  methods = $state<string[]>();
  get incompatible() {
    return ["gateway-update", "app-update", "pairing"].includes(this.state);
  }
  supports(path: string) {
    const required =
      Object.entries(sections).find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? [];

    return !this.methods || required.every((method) => this.methods?.includes(method));
  }
  async reload() {
    try {
      const value = await requestJson("GET", "/api/gateway-capabilities", undefined, 5000);

      if (
        !isJsonObject(value) ||
        !isString(value["state"]) ||
        !isString(value["message"]) ||
        !Array.isArray(value["methods"])
      )
        return;
      this.state = value["state"];
      this.message = value["message"];
      this.methods = value["methods"].filter(isString);
    } catch {
      this.state = "unavailable";
    }
  }
  connect() {
    void this.reload();
    const timer = setInterval(() => void this.reload(), 5000);

    return () => clearInterval(timer);
  }
}

const KEY = Symbol("gateway-capabilities");
export const provideGatewayCapabilities = (value: GatewayCapabilities) => setContext(KEY, value);
export const useGatewayCapabilities = () => getContext<GatewayCapabilities | undefined>(KEY);

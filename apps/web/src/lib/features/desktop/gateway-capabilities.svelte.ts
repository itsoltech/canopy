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
  linkedComputers = $state(false);
  /** The gateway runs inside this desktop app (local mode): only the desktop role offers linked computers. */
  get ownGateway() {
    return this.linkedComputers;
  }
  get incompatible() {
    return ["gateway-update", "app-update", "pairing"].includes(this.state);
  }
  supports(path: string) {
    if (path === "/settings/computers" || path.startsWith("/settings/computers/"))
      if (!this.linkedComputers) return false;

    const required =
      Object.entries(sections).find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? [];

    return !this.methods || required.every((method) => this.methods?.includes(method));
  }
  unavailableMessage(path: string) {
    return path.startsWith("/settings/computers") && !this.linkedComputers
      ? "Linked computers are available only in the Canopy desktop app"
      : "Update Canopy on your gateway to use this feature";
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

      // An outage says nothing about feature support. Keep the last successful negotiation.
      if (this.state !== "unavailable") {
        this.methods = value["methods"].filter(isString);
        this.linkedComputers = value["linkedComputers"] === true;
      }
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

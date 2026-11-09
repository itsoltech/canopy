import { getContext, setContext } from "svelte";
import { isJsonObject, isString } from "#lib/shared/json.ts";
import { requestJson } from "#lib/shared/http.ts";
import { clearHistory } from "./history.ts";
import { threadCache } from "../threads/thread-cache.ts";
import { botCache } from "../bots/cache.ts";

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
  "/settings/import": ["ScanImport", "ListImportCandidates"],
};

/** Capabilities read again while visible, besides connection changes (ms). */
const FALLBACK_MS = 5 * 60_000;

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

      if (this.state === "pairing") {
        threadCache.clear();
        botCache.clear();
        clearHistory();
      }

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
  /**
   * Negotiates once, then again when the overview connection changes (AppShell), when the page returns after
   * a minute hidden, and every 5 minutes while visible as a fallback. Every gateway call stays authenticated.
   */
  connect() {
    void this.reload();
    let hiddenAt = 0;

    const timer = setInterval(() => {
      if (!document.hidden) void this.reload();
    }, FALLBACK_MS);

    const visibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60_000) void this.reload();
    };

    document.addEventListener("visibilitychange", visibility);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }
}

const KEY = Symbol("gateway-capabilities");
export const provideGatewayCapabilities = (value: GatewayCapabilities) => setContext(KEY, value);
export const useGatewayCapabilities = () => getContext<GatewayCapabilities | undefined>(KEY);

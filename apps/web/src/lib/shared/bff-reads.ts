import { ui } from "@canopy/contracts";

/** Read models maintained by this web app's BFF and pushed through the shared overview stream. */
const reads = new Set([
  "GetThreadPanel",
  "ListThreadPullRequests",
  "ListProxies",
  "ListModels",
  "ListBots",
  "GetUpdates",
]);

export const bffReadKey = (key: string) => reads.has(key.split(":")[0] ?? "");

export const bffReadSchema = (key: string) =>
  bffReadKey(key) ? ui.GatewayService.methods.find((method) => method.name === key.split(":")[0])?.output : undefined;

import { Code, ConnectError } from "@connectrpc/connect";

export type GatewayRole = "server" | "desktop";

export const DESKTOP_LINKS_ONLY = "Linked computers are available only in the Canopy desktop app";

/** Internal launch marker supplied by the desktop controller, never a user setting. */
export function gatewayRole(env: NodeJS.ProcessEnv): GatewayRole {
  return env["CANOPY_GATEWAY_ROLE"] === "desktop" ? "desktop" : "server";
}

export function requireDesktopRole(role: GatewayRole) {
  if (role !== "desktop") throw new ConnectError(DESKTOP_LINKS_ONLY, Code.FailedPrecondition);
}

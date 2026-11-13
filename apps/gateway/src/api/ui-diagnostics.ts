import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { diagnosticsGrants, setDiagnosticsGrant } from "../diagnostics/grants.ts";
import { mobileIdentity } from "../core/mobile-devices.ts";
import { createHash } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { credentialGuard } from "./ui-errors.ts";

export function diagnosticsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getDiagnostics"
  | "getComputerDiagnostics"
  | "getDiagnosticsGrants"
  | "setDiagnosticsGrant"
  | "submitDiagnostics"
  | "resetDiagnostics"
  | "prepareDiagnosticsReport"
  | "investigateDiagnostics"
> {
  return {
    getDiagnostics: (request) => core.diagnostics.overview(request),
    getComputerDiagnostics: (request) => core.diagnostics.computer(request),
    getDiagnosticsGrants: () => diagnosticsGrants(core),
    setDiagnosticsGrant: (request) => setDiagnosticsGrant(core, request),
    submitDiagnostics: async (request, context) => {
      if (context.protocolName === "canopy.link")
        throw new ConnectError("Client diagnostics stay on their authenticated home", Code.PermissionDenied);
      const device = context.values.get(mobileIdentity);
      const binding = context.requestHeader.get("canopy-diagnostics-client") ?? "";

      if (!device && !/^[A-Za-z0-9_-]{43}$/.test(binding))
        throw new ConnectError("Diagnostics sender is unavailable", Code.Unauthenticated);

      if (device && device.clientKind !== "desktop" && request.source !== "mobile")
        throw new ConnectError("Choose this client's diagnostic source", Code.PermissionDenied);

      const sender = createHash("sha256")
        .update(device ? `device:${device.deviceId}` : `browser:${binding}`)
        .digest("hex");

      return core.diagnostics.clients.submit(request, sender, !device || device.clientKind === "desktop");
    },
    resetDiagnostics: (request) => diagnosticsGuard(() => core.diagnostics.actions.reset(request)),
    prepareDiagnosticsReport: (request) => core.diagnostics.actions.report(request),
    investigateDiagnostics: (request) => diagnosticsGuard(() => core.diagnostics.actions.investigation(request)),
  };
}

/** Failed attachment writes may carry a report in driver parameters. Never log or echo the cause. */
async function diagnosticsGuard<A>(run: () => Promise<A>) {
  try {
    const result = await credentialGuard(async () => {
      try {
        return { value: await run() };
      } catch (cause) {
        if (cause instanceof ConnectError) return { error: cause };
        throw cause;
      }
    });

    if (result.error) throw result.error;

    return result.value!;
  } catch (error) {
    if (error instanceof ConnectError && error.code !== Code.Internal) throw error;
    throw new ConnectError("Could not complete the diagnostics action. Refresh diagnostics and retry.", Code.Internal);
  }
}

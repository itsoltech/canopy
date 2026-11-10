import type { GatewayCore } from "../core/core.ts";
import type { UiHandlers } from "./ui-service.ts";
import { diagnosticsGrants, setDiagnosticsGrant } from "../diagnostics/grants.ts";

export function diagnosticsHandlers(
  core: GatewayCore,
): Pick<UiHandlers, "getDiagnostics" | "getComputerDiagnostics" | "getDiagnosticsGrants" | "setDiagnosticsGrant"> {
  return {
    getDiagnostics: (request) => core.diagnostics.overview(request),
    getComputerDiagnostics: (request) => core.diagnostics.computer(request),
    getDiagnosticsGrants: () => diagnosticsGrants(core),
    setDiagnosticsGrant: (request) => setDiagnosticsGrant(core, request),
  };
}

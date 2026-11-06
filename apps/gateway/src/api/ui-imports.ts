import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Settings → Import (docs/import.md): scans and candidates on this computer's workers. */
export function importsHandlers(core: GatewayCore): Pick<UiHandlers, "scanImport" | "listImportCandidates"> {
  return {
    scanImport: (request) => guard(() => core.imports.scan(request)),
    listImportCandidates: (request) => guard(() => core.imports.listCandidates(request)),
  };
}

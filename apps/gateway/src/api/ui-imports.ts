import { type GatewayCore } from "../core/core.ts";
import { guard } from "./ui-errors.ts";
import type { UiHandlers } from "./ui-service.ts";

/** Settings → Import (docs/import.md): scans, candidates and import runs on this computer's workers. */
export function importsHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "scanImport"
  | "listImportCandidates"
  | "startImport"
  | "listImportRuns"
  | "getImportRun"
  | "cancelImportRun"
  | "resumeImportRun"
  | "undoImportRun"
> {
  const runs = core.imports.runs;

  return {
    scanImport: (request) => guard(() => core.imports.scan(request)),
    listImportCandidates: (request) => guard(() => core.imports.listCandidates(request)),
    startImport: (request) => guard(() => runs.start(request)),
    listImportRuns: () => guard(() => runs.list()),
    getImportRun: (request) => guard(() => runs.get(request)),
    cancelImportRun: (request) => guard(() => runs.cancel(request)),
    resumeImportRun: (request) => guard(() => runs.resume(request)),
    undoImportRun: (request) => guard(() => runs.undo(request)),
  };
}

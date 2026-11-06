import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/** Browser side of Settings → Import (docs/import.md): BFF routes under /api/imports. */

export async function scanImport(workerId: string): Promise<ui.ScanImportResponse> {
  const body = encode(ui.ScanImportRequestSchema, create(ui.ScanImportRequestSchema, { workerId }));

  return decode(ui.ScanImportResponseSchema, await requestJson("POST", "/api/imports/scan", body, 135_000));
}

export async function listImportCandidates(
  request: MessageInitShape<typeof ui.ListImportCandidatesRequestSchema>,
): Promise<ui.ListImportCandidatesResponse> {
  const body = encode(ui.ListImportCandidatesRequestSchema, create(ui.ListImportCandidatesRequestSchema, request));

  return decode(ui.ListImportCandidatesResponseSchema, await requestJson("POST", "/api/imports/candidates", body));
}

export async function startImport(
  request: MessageInitShape<typeof ui.StartImportRequestSchema>,
): Promise<ui.ImportRun> {
  const body = encode(ui.StartImportRequestSchema, create(ui.StartImportRequestSchema, request));

  return decode(ui.ImportRunSchema, await requestJson("POST", "/api/imports/start", body, 125_000));
}

export async function listImportRuns(): Promise<ui.ListImportRunsResponse> {
  return decode(ui.ListImportRunsResponseSchema, await requestJson("GET", "/api/imports/runs"));
}

export async function getImportRun(runId: string): Promise<ui.ImportRun> {
  const body = encode(ui.GetImportRunRequestSchema, create(ui.GetImportRunRequestSchema, { runId, items: true }));

  return decode(ui.ImportRunSchema, await requestJson("POST", "/api/imports/runs", body));
}

export async function importRunAction(runId: string, action: "cancel" | "resume" | "undo"): Promise<ui.ImportRun> {
  const body = encode(ui.ImportRunRequestSchema, create(ui.ImportRunRequestSchema, { runId }));

  return decode(
    ui.ImportRunSchema,
    await requestJson("POST", `/api/imports/runs/action?action=${action}`, body, 125_000),
  );
}

/** A new thread that starts with a note about an imported thread's history. */
export async function continueImportedThread(threadId: string): Promise<ui.Thread | undefined> {
  const body = encode(
    ui.ContinueImportedThreadRequestSchema,
    create(ui.ContinueImportedThreadRequestSchema, { threadId }),
  );

  return decode(ui.GetThreadResponseSchema, await requestJson("POST", "/api/imports/continue", body, 65_000)).thread;
}

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

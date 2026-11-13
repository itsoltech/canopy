import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";

/** Bounds public and linked snapshots off the hot path; method rows are never silently dropped. */
export function diagnosticsResponse(value: ui.ComputerDiagnostics, request: ui.ComputerDiagnosticsRequest) {
  if (value.notModified)
    return create(ui.ComputerDiagnosticsSchema, {
      computerId: value.computerId,
      revision: value.revision,
      sampledAtMs: value.sampledAtMs,
      sampleAgeMs: value.sampleAgeMs,
      windowMinutes: value.windowMinutes,
      notModified: true,
    });
  const budget = request.overviewOnly ? 16 * 1024 : 64 * 1024;

  while (toBinary(ui.ComputerDiagnosticsSchema, value).length > budget) {
    if (value.links.length) value.links.pop();
    else if (value.findings.length > 5) value.findings.pop();
    else throw new ConnectError("Diagnostics snapshot exceeds budget", Code.ResourceExhausted);
    value.droppedSamples++;
  }

  return value;
}

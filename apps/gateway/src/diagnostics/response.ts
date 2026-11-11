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
  // The local window cache is shared by readers and persistence; shed only this response.
  value = create(ui.ComputerDiagnosticsSchema, {
    ...value,
    calls: value.calls.map((call) => create(ui.DiagnosticsCallSchema, { ...call, database: [...call.database] })),
    gatewayMeasures: [...value.gatewayMeasures],
    database: [...value.database],
    links: [...value.links],
    findings: [...value.findings],
  });

  while (toBinary(ui.ComputerDiagnosticsSchema, value).length > budget) {
    const call = value.calls.findLast((row) => row.database.length);

    if (call) call.database.pop();
    else if (value.gatewayMeasures.some((row) => row.metricId >= 2000))
      value.gatewayMeasures.splice(
        value.gatewayMeasures.findLastIndex((row) => row.metricId >= 2000),
        1,
      );
    else if (value.database.length) value.database.pop();
    else if (value.links.length) value.links.pop();
    else if (value.findings.length > 5) value.findings.pop();
    else throw new ConnectError("Diagnostics snapshot exceeds budget", Code.ResourceExhausted);
    value.droppedSamples++;
  }

  return value;
}

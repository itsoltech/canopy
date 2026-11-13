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
      epoch: value.epoch,
      epochStartedAtMs: value.epochStartedAtMs,
      notModified: true,
      tracing: value.tracing,
      tracingSupported: value.tracingSupported,
    });
  const budget = request.overviewOnly ? 16 * 1024 : 64 * 1024;
  // The local window cache is shared by readers and persistence; shed only this response.
  value = create(ui.ComputerDiagnosticsSchema, {
    ...value,
    calls: value.calls.map((call) => create(ui.DiagnosticsCallSchema, { ...call, database: [...call.database] })),
    gatewayMeasures: [...value.gatewayMeasures],
    clientMeasures: [...value.clientMeasures],
    database: [...value.database],
    links: value.links.map((link) => create(ui.DiagnosticsLinkSchema, { ...link, measures: [...link.measures] })),
    findings: [...value.findings],
  });

  const initial = toBinary(ui.ComputerDiagnosticsSchema, value).length;
  // A changed droppedSamples varint needs at most twelve bytes including its tag.
  let upperBound = initial > budget ? initial + 16 : initial;

  while (upperBound > budget) {
    const call = value.calls.findLast((row) => row.database.length);
    let removedBytes = 0;

    if (call) {
      const removed = call.database.pop()!;
      removedBytes = toBinary(
        ui.DiagnosticsCallSchema,
        create(ui.DiagnosticsCallSchema, { database: [removed] }),
      ).length;
    } else if (value.gatewayMeasures.some((row) => row.metricId >= 2000)) {
      const removed = value.gatewayMeasures.splice(
        value.gatewayMeasures.findLastIndex((row) => row.metricId >= 2000),
        1,
      );

      removedBytes = toBinary(
        ui.ComputerDiagnosticsSchema,
        create(ui.ComputerDiagnosticsSchema, { gatewayMeasures: removed }),
      ).length;
    } else if (value.clientMeasures.length) {
      const removed = value.clientMeasures.pop()!;
      removedBytes = toBinary(
        ui.ComputerDiagnosticsSchema,
        create(ui.ComputerDiagnosticsSchema, { clientMeasures: [removed] }),
      ).length;
    } else if (value.database.length) {
      const removed = value.database.pop()!;
      removedBytes = toBinary(
        ui.ComputerDiagnosticsSchema,
        create(ui.ComputerDiagnosticsSchema, { database: [removed] }),
      ).length;
    } else if (value.links.some((link) => link.measures.length)) {
      const link = value.links.findLast((row) => row.measures.length)!;
      const removed = link.measures.pop()!;
      link.droppedSamples++;
      removedBytes = Math.max(
        0,
        toBinary(ui.DiagnosticsLinkSchema, create(ui.DiagnosticsLinkSchema, { measures: [removed] })).length - 12,
      );
    } else if (value.links.length) {
      const removed = value.links.pop()!;
      removedBytes = toBinary(
        ui.ComputerDiagnosticsSchema,
        create(ui.ComputerDiagnosticsSchema, { links: [removed] }),
      ).length;
    } else if (value.findings.length > 5) {
      const removed = value.findings.pop()!;
      removedBytes = toBinary(
        ui.ComputerDiagnosticsSchema,
        create(ui.ComputerDiagnosticsSchema, { findings: [removed] }),
      ).length;
    } else throw new ConnectError("Diagnostics snapshot exceeds budget", Code.ResourceExhausted);
    // Enclosing message length prefixes only shrink: this remains a conservative bound.
    upperBound -= removedBytes;
    value.droppedSamples++;
  }

  return value;
}

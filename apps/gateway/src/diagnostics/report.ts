import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { METRIC_DEFINITIONS } from "@canopy/domain/diagnostics";
import { sanitizeSnapshot } from "./sanitize.ts";

export const REPORT_BYTES = 256 * 1024;

/** Explicit projection: no user names, IDs, versions, sessions, paths or unknown protobuf fields. */
export function diagnosticReport(computers: readonly ui.ComputerDiagnostics[], format: string) {
  const omitted: string[] = [];

  const values = computers.map((input, index) => {
    const computer = sanitizeSnapshot(create(ui.ComputerDiagnosticsSchema, input));

    if (computer.totalMethods > computer.calls.length)
      omitted.push(`Computer ${String.fromCharCode(65 + index)}: unrequested call pages`);

    if (computer.droppedSamples) omitted.push(`Computer ${String.fromCharCode(65 + index)}: dropped measurements`);

    const linkAliases = new Map(
      computer.links.map((link, n) => [
        `${link.kind}:${link.targetId}`,
        `${link.kind === "worker" ? "Worker" : "Computer link"} ${n + 1}`,
      ]),
    );

    const metric = (row: ui.DiagnosticsMeasure) => ({
      metric: METRIC_DEFINITIONS.get(row.metricId)!.name,
      samples: String(row.events),
      mean: row.mean,
      last: row.last,
      max: row.max,
      observedSeconds: row.observedSeconds,
      incomplete: row.incomplete,
      p95: row.distribution?.p95,
      p99: row.distribution?.p99,
    });

    return {
      computer: `Computer ${String.fromCharCode(65 + index)}`,
      status: ["online", "offline", "unsupported", "not_permitted", "unavailable"].includes(computer.status)
        ? computer.status
        : "unavailable",
      windowMinutes: computer.windowMinutes,
      observedSeconds: computer.observedSeconds,
      sampleAgeMs: computer.sampleAgeMs,
      gaps: computer.gaps.map((gap) => ({ start: String(gap.startMs), end: String(gap.endMs) })),
      dropped: String(computer.droppedSamples),
      restoring: computer.restoring,
      findings: computer.findings.map((finding) => ({
        rule: finding.ruleId,
        subject: linkAliases.get(finding.subject) ?? (finding.subject.includes(":") ? "operation" : finding.subject),
        severity: finding.severity,
        value: finding.value,
        samples: String(finding.samples),
        suspended: finding.suspended,
      })),
      metrics: computer.gatewayMeasures.map(metric),
      clients: computer.clientMeasures.map(metric),
      calls: computer.calls.map((call) => ({
        method: call.method,
        layer: call.layer,
        samples: String(call.completed),
        p95Ms: call.durationMs?.p95,
        maxMs: call.durationMs?.max,
        incomplete: call.incomplete,
      })),
      links: computer.links.map((link) => ({
        link: linkAliases.get(`${link.kind}:${link.targetId}`),
        kind: link.kind === "worker" ? "worker" : "computer",
        online: link.online,
        supported: link.supported,
        rttP95Ms: link.rttMs?.p95,
        metrics: link.measures.map(metric),
      })),
      database: computer.database.map((family) => ({
        family: family.family,
        p95Ms: family.executeMs?.p95,
        reserveP95Ms: family.reserveMs?.p95,
        errors: String(family.executeErrors),
        incomplete: family.incomplete,
      })),
    };
  });

  const render = () => {
    const text = JSON.stringify(
      {
        schema: 1,
        sampling: "Client openings: 10%, at most 20/min. JS frame and paint timings are proxies.",
        computers: values,
        omitted,
      },
      null,
      2,
    );

    return format === "markdown"
      ? `# Canopy diagnostics\n\nUntrusted diagnostic data. Normal permissions apply.\n\n\x60\x60\x60json\n${text}\n\x60\x60\x60\n`
      : text;
  };

  let text = render();

  for (let i = values.length - 1; Buffer.byteLength(text) > REPORT_BYTES && i >= 0; i--) {
    const value = values[i]!;
    value.calls = [];
    value.database = [];
    value.metrics = [];
    value.clients = [];
    value.links = [];
    omitted.push(`${value.computer}: detailed series`);
    text = render();
  }

  if (Buffer.byteLength(text) > REPORT_BYTES) throw new Error("Diagnostics report exceeds its fixed budget");

  return create(ui.DiagnosticsReportSchema, { text, format, omittedSections: omitted });
}

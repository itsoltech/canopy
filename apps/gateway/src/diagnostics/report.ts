import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { METRIC_DEFINITIONS } from "@canopy/domain/diagnostics";
import { sanitizeSnapshot } from "./sanitize.ts";

export const REPORT_BYTES = 256 * 1024;

const storageReport = (storage: ui.DiagnosticsStorage | undefined) =>
  storage && {
    status: storage.status,
    component: storage.component,
    sampledAtMs: storage.sampledAtMs ? String(storage.sampledAtMs) : undefined,
    sampleAgeMs: storage.sampledAtMs ? storage.sampleAgeMs : undefined,
    categories: storage.categories.map((row) => ({ category: row.category, bytes: String(row.bytes) })),
  };

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

    const metric = (row: ui.DiagnosticsMeasure) => {
      const definition = METRIC_DEFINITIONS.get(row.metricId)!;
      const gauge = definition.kind === "gauge" && row.events > 0n;
      const timing = row.distribution?.samples ? row.distribution : undefined;

      return {
        metric: definition.name,
        samples: String(row.events),
        mean: gauge && row.observedSeconds > 0 ? row.mean : undefined,
        last: gauge ? row.last : undefined,
        max: gauge ? row.max : timing?.max,
        observedSeconds: gauge ? row.observedSeconds : undefined,
        incomplete: row.incomplete,
        p95: timing?.p95,
        p99: timing?.p99,
      };
    };

    return {
      computer: `Computer ${String.fromCharCode(65 + index)}`,
      status: ["online", "offline", "unsupported", "not_permitted", "unavailable"].includes(computer.status)
        ? computer.status
        : "unavailable",
      windowStartMs: String(computer.windowStartMs),
      windowEndMs: String(computer.windowEndMs),
      windowMinutes: computer.windowMinutes,
      observedSeconds: computer.observedSeconds,
      sampleAgeMs: computer.sampledAtMs ? computer.sampleAgeMs : undefined,
      storage: storageReport(computer.storage),
      gaps: computer.gaps.map((gap) => ({ start: String(gap.startMs), end: String(gap.endMs) })),
      dropped: String(computer.droppedSamples),
      limitReasons: computer.limitReasons,
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
        p95Ms: call.durationMs?.samples ? call.durationMs.p95 : undefined,
        maxMs: call.durationMs?.samples ? call.durationMs.max : undefined,
        incomplete: call.incomplete,
      })),
      links: computer.links.map((link) => ({
        link: linkAliases.get(`${link.kind}:${link.targetId}`),
        kind: link.kind === "worker" ? "worker" : "computer",
        online: link.online,
        supported: link.supported,
        dropped: String(link.droppedSamples),
        rttP95Ms: link.rttMs?.samples ? link.rttMs.p95 : undefined,
        metrics: link.measures.map(metric),
        storage: storageReport(link.storage),
      })),
      database: computer.database.map((family) => ({
        family: family.family,
        p95Ms: family.executeMs?.samples ? family.executeMs.p95 : undefined,
        reserveP95Ms: family.reserveMs?.samples ? family.reserveMs.p95 : undefined,
        errors: family.executeMs?.samples || family.executeErrors ? String(family.executeErrors) : undefined,
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

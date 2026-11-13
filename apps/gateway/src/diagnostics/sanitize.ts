import { ui } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { DATABASE_FAMILIES, METRIC_DEFINITIONS, GOVERNOR_KINDS, GOVERNOR_PRIORITIES } from "@canopy/domain/diagnostics";
import { RPC_METHODS, LINKED_METHODS, COMMAND_METHODS } from "./registry.ts";

const methods = new Map(
  [...RPC_METHODS, ...LINKED_METHODS, ...COMMAND_METHODS].map((value) => [`${value.layer}:${value.name}`, value]),
);

const families = new Set<string>(DATABASE_FAMILIES.map((value) => value.name));

const governors = new Set(
  GOVERNOR_KINDS.flatMap((kind) => GOVERNOR_PRIORITIES.map((priority) => `${kind}:${priority}`)),
);

function percentile(value: ui.DiagnosticsPercentiles | undefined) {
  if (
    !value ||
    ![value.p50, value.p95, value.p99, value.max, value.sum].every((number) => Number.isFinite(number) && number >= 0)
  )
    return;

  return create(ui.DiagnosticsPercentilesSchema, {
    samples: value.samples,
    p50: value.p50,
    p95: value.p95,
    p99: value.p99,
    max: value.max,
    sum: value.sum,
    overflowQuantiles: value.overflowQuantiles & 7,
  });
}

function database(values: ui.DiagnosticsDatabaseFamily[]) {
  const seen = new Set<string>();

  return values.slice(0, 10).flatMap((value) => {
    if (!families.has(value.family) || seen.has(value.family)) return [];
    seen.add(value.family);

    return [
      create(ui.DiagnosticsDatabaseFamilySchema, {
        family: value.family,
        reserveMs: percentile(value.reserveMs),
        executeMs: percentile(value.executeMs),
        releaseMs: percentile(value.releaseMs),
        transactionMs: percentile(value.transactionMs),
        reserveErrors: value.reserveErrors,
        executeErrors: value.executeErrors,
        releaseErrors: value.releaseErrors,
        transactionErrors: value.transactionErrors,
        incomplete: value.incomplete,
      }),
    ];
  });
}

function findingSubject(value: ui.DiagnosticsFinding, links: Set<string>) {
  switch (value.ruleId) {
    case "rpc_slow":
    case "rpc_errors":
      return methods.has(value.subject);
    case "link_slow":
      return links.has(value.subject);
    case "event_loop":
    case "db_pool":
      return value.subject === "gateway";
    case "db_slow":
      return families.has(value.subject);
    case "governor_wait":
      return governors.has(value.subject);
    default:
      return false;
  }
}

/** Authenticated peers still cannot introduce arbitrary text labels into collected metrics. */
export function sanitizeSnapshot(value: ui.ComputerDiagnostics) {
  const calls: ui.DiagnosticsCall[] = [];
  const seen = new Set<string>();

  for (const call of value.calls) {
    const key = `${call.layer}:${call.method}`;
    const method = methods.get(key);

    if (!method || seen.has(key) || call.codes.length > 17 || call.messageKinds.length > 8) {
      value.droppedSamples++;
      continue;
    }

    seen.add(key);
    call.stream = method.stream;
    call.database = database(call.database);
    calls.push(call);
  }

  value.calls = calls;
  value.database = database(value.database);
  const metricIds = new Set<number>();
  value.gatewayMeasures = value.gatewayMeasures.slice(0, METRIC_DEFINITIONS.size).flatMap((measure) => {
    if (
      !METRIC_DEFINITIONS.has(measure.metricId) ||
      metricIds.has(measure.metricId) ||
      ![measure.mean, measure.last, measure.max, measure.observedSeconds].every(
        (number) => Number.isFinite(number) && number >= 0,
      )
    ) {
      value.droppedSamples++;

      return [];
    }

    metricIds.add(measure.metricId);

    return [
      create(ui.DiagnosticsMeasureSchema, {
        metricId: measure.metricId,
        distribution: percentile(measure.distribution),
        mean: measure.mean,
        last: measure.last,
        max: measure.max,
        observedSeconds: measure.observedSeconds,
        events: measure.events,
        errors: measure.errors,
        sampledAtMs: measure.sampledAtMs,
        historical: measure.historical,
        incomplete: measure.incomplete,
      }),
    ];
  });
  const links = new Set(value.links.map((link) => `${link.kind}:${link.targetId}`));
  value.findings = value.findings.filter(
    (finding) =>
      ["warning", "critical"].includes(finding.severity) &&
      findingSubject(finding, links) &&
      Number.isFinite(finding.value) &&
      Number.isFinite(finding.threshold),
  );

  return value;
}

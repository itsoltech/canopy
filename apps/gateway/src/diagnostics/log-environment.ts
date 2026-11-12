import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { METRIC_DEFINITIONS } from "@canopy/domain/diagnostics";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import type { GatewayCore } from "../core/core.ts";

const rules = new Set([
  "rpc_slow",
  "rpc_errors",
  "link_slow",
  "event_loop",
  "db_pool",
  "db_slow",
  "governor_wait",
  "worker_backlog",
  "worker_cpu",
  "worker_disk",
  "sync_refresh",
]);

const nonnegative = (number: number) => (Number.isFinite(number) && number >= 0 ? number : 0);

export function logEnvironment(core: GatewayCore) {
  const value = core.diagnostics.local(create(ui.ComputerDiagnosticsRequestSchema, { windowMinutes: 15, limit: 16 }));

  return safeLogEnvironment(
    create(ui.DiagnosticsLogEnvironmentSchema, {
      version: CANOPY_VERSION,
      os: process.platform,
      arch: process.arch,
      uptimeSeconds: process.uptime(),
      collectedAtMs: BigInt(Date.now()),
      sampleAgeMs: value.sampleAgeMs,
      measures: value.gatewayMeasures,
      findings: value.findings,
    }),
  );
}

/** Re-project at both boundaries, including unknown fields and malicious version/name strings. */
export function safeLogEnvironment(value: ui.DiagnosticsLogEnvironment) {
  return {
    schema: 1,
    version: /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(value.version) ? value.version : "unknown",
    os: ["linux", "darwin", "win32"].includes(value.os) ? value.os : "unknown",
    arch: ["x64", "arm64"].includes(value.arch) ? value.arch : "unknown",
    uptimeSeconds: nonnegative(value.uptimeSeconds),
    collectedAtMs: value.collectedAtMs > 0n ? String(value.collectedAtMs) : "0",
    sampleAgeMs: nonnegative(value.sampleAgeMs),
    measures: value.measures
      .slice(0, 64)
      .filter((m) => METRIC_DEFINITIONS.has(m.metricId))
      .map((m) => ({
        metricId: m.metricId,
        last: nonnegative(m.last),
        mean: nonnegative(m.mean),
        max: nonnegative(m.max),
        incomplete: m.incomplete,
        observedSeconds: nonnegative(m.observedSeconds),
      })),
    findings: value.findings
      .slice(0, 5)
      .filter((f) => rules.has(f.ruleId))
      .map((f) => ({
        ruleId: f.ruleId,
        severity: ["info", "warning", "critical"].includes(f.severity) ? f.severity : "info",
        value: nonnegative(f.value),
        threshold: nonnegative(f.threshold),
        suspended: f.suspended,
      })),
  };
}

export function logEnvironmentMessage(core: GatewayCore) {
  const value = logEnvironment(core);

  return create(ui.DiagnosticsLogEnvironmentSchema, {
    ...value,
    collectedAtMs: BigInt(value.collectedAtMs),
    measures: value.measures,
    findings: value.findings,
  });
}

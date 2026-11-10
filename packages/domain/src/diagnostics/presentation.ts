import type { ui } from "@canopy/contracts";

export const diagnosticsRanges = [
  { value: "1", label: "1 min" },
  { value: "15", label: "15 min" },
  { value: "60", label: "1 h" },
  { value: "1440", label: "24 h" },
];

export const diagnosticsSorts = [
  { value: "rate", label: "Calls/min" },
  { value: "p50", label: "p50" },
  { value: "p95", label: "p95" },
  { value: "p99", label: "p99" },
  { value: "max", label: "Max" },
  { value: "errors", label: "Errors" },
  { value: "active", label: "In flight" },
  { value: "method", label: "Method" },
];

export const diagnosticsKinds = [
  { value: "unary", label: "Unary calls" },
  { value: "stream", label: "Streams" },
];

/** Only the current pages' identities, without retaining metric history. */
export class DiagnosticsPages {
  readonly keys = new Map<string, string[]>();

  remember(key: string, value: ui.ComputerDiagnostics) {
    if (!this.keys.has(key) && value.calls.length) {
      if (this.keys.size >= 8) this.keys.delete(this.keys.keys().next().value!);
      this.keys.set(key, value.calls.map(callKey));
    }

    return value;
  }
}

export const grpcCodes = [
  "OK",
  "Canceled",
  "Unknown",
  "InvalidArgument",
  "DeadlineExceeded",
  "NotFound",
  "AlreadyExists",
  "PermissionDenied",
  "ResourceExhausted",
  "FailedPrecondition",
  "Aborted",
  "OutOfRange",
  "Unimplemented",
  "Internal",
  "Unavailable",
  "DataLoss",
  "Unauthenticated",
];

export function errorCount(call: ui.DiagnosticsCall) {
  return call.codes.reduce((total, count, index) => total + (index ? count : 0n), 0n);
}

export function callKey(call: ui.DiagnosticsCall) {
  return `${call.layer}:${call.method}`;
}

export function sortCalls(calls: readonly ui.DiagnosticsCall[], sort: string) {
  const score = (call: ui.DiagnosticsCall) => {
    switch (sort) {
      case "rate":
        return call.callsPerMinute;
      case "errors":
        return Number(errorCount(call));
      case "active":
        return call.inFlight;
      case "p50":
        return call.durationMs?.p50 ?? 0;
      case "p99":
        return call.durationMs?.p99 ?? 0;
      case "max":
        return call.durationMs?.max ?? 0;
      default:
        return call.durationMs?.p95 ?? 0;
    }
  };

  return [...calls].sort(
    (a, b) => (sort === "method" ? 0 : score(b) - score(a)) || callKey(a).localeCompare(callKey(b)),
  );
}

export function duration(value: number | undefined) {
  if (value === undefined) return "Not measured";

  if (value < 1) return `${(value * 1000).toFixed(0)} µs`;

  return value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`;
}

export function measured(
  value: ui.DiagnosticsPercentiles | undefined,
  quantile: "p50" | "p95" | "p99" | "max" = "p95",
) {
  return value?.samples
    ? `${value.overflowQuantiles & { p50: 1, p95: 2, p99: 4, max: 0 }[quantile] ? "≥ " : ""}${duration(value[quantile])}`
    : "Not measured";
}

export function bytes(value: ui.DiagnosticsPercentiles | undefined) {
  if (!value?.samples) return "Not measured";

  const prefix = value.overflowQuantiles & 2 ? "≥ " : "";

  return `${prefix}${value.p95 < 1024 ? `${value.p95.toFixed(0)} B` : `${(value.p95 / 1024).toFixed(1)} KiB`}`;
}

export function byteRate(value: ui.DiagnosticsPercentiles | undefined, seconds: number) {
  if (!value?.samples || !seconds) return "Not measured";
  const rate = value.sum / seconds;

  return rate < 1024 ? `${rate.toFixed(0)} B/s` : `${(rate / 1024).toFixed(1)} KiB/s`;
}

export function messageClasses(call: ui.DiagnosticsCall, direction: "request" | "response") {
  const offset = direction === "request" ? 0 : 4;

  return ["Snapshot", "Delta", "Heartbeat", "Control"]
    .map((label, index) => `${label}: ${call.messageKinds[offset + index] ?? 0n}`)
    .join(" · ");
}

export function health(computer: ui.ComputerDiagnostics) {
  if (computer.restoring) return "Restoring diagnostics";

  if (computer.status === "unsupported") return "Update to see diagnostics";

  if (computer.status === "not_permitted") return "Not permitted";

  if (computer.findings.some((finding) => finding.severity === "critical" && !finding.suspended))
    return "Needs attention";

  if (computer.findings.some((finding) => !finding.suspended)) return "Check findings";

  if (
    computer.observedSeconds < 600 ||
    computer.droppedSamples ||
    computer.status !== "online" ||
    computer.findings.some((finding) => finding.suspended)
  )
    return "Not enough data";

  return "No issues found";
}

export function freshness(computer: ui.ComputerDiagnostics) {
  if (!computer.sampledAtMs) return "No saved snapshot";
  const age = computer.sampleAgeMs / 1000;

  return `Updated ${age < 60 ? `${Math.floor(age)} s` : `${Math.floor(age / 60)} min`} ago${computer.status === "online" ? "" : " · Last known data"}${computer.ageUncertain ? " · Age is approximate" : ""}`;
}

export function diagnosticsUnavailable(computer: ui.ComputerDiagnostics): [string, string] {
  if (computer.status === "unsupported")
    return ["Update to see diagnostics", "Update this computer to collect performance data."];

  if (computer.status === "not_permitted") return ["Not permitted", "Allow diagnostics access on this computer."];

  if (computer.status === "offline")
    return ["No saved call details", "Reconnect this computer to collect performance data."];

  return ["Loading diagnostics…", "Waiting for this computer’s snapshot."];
}

export function findingText(finding: ui.DiagnosticsFinding) {
  if (finding.ruleId === "rpc_errors")
    return `${finding.subject.split("/").at(-1)} has ${finding.value.toFixed(1)}% server or transport errors over 15 min. Check gateway load and investigate this method.`;

  return finding.ruleId === "link_slow"
    ? `Link round-trip is ${duration(finding.value)} at p95 over 15 min. Check this computer’s network and gateway connection.`
    : `${finding.subject.split("/").at(-1)} p95 is ${duration(finding.value)} over 15 min. Check gateway load and investigate this method.`;
}

/** Both observers describe one computer link; keep the worst evidence and name its observers. */
export function diagnosticsFindings(computers: readonly ui.ComputerDiagnostics[]) {
  const values = new Map<
    string,
    { computer: ui.ComputerDiagnostics; finding: ui.DiagnosticsFinding; observers: string[] }
  >();

  for (const computer of computers)
    for (const finding of computer.findings) {
      const pair = finding.ruleId === "link_slow" && finding.subject.startsWith("computer:");

      const scope = pair
        ? [computer.computerId, finding.subject.slice(9)].sort().join(":")
        : `${computer.computerId}:${finding.subject}`;

      const key = `${finding.ruleId}:${scope}`;
      const previous = values.get(key);
      const observers = [...(previous?.observers ?? []), computer.name];

      if (!previous || finding.value > previous.finding.value) values.set(key, { computer, finding, observers });
      else previous.observers = observers;
    }

  return [...values.values()].sort(
    (a, b) => Number(b.finding.severity === "critical") - Number(a.finding.severity === "critical"),
  );
}

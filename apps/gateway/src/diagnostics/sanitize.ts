import { ui } from "@canopy/contracts";
import { RPC_METHODS, LINKED_METHODS, COMMAND_METHODS } from "./registry.ts";

const methods = new Map(
  [...RPC_METHODS, ...LINKED_METHODS, ...COMMAND_METHODS].map((value) => [`${value.layer}:${value.name}`, value]),
);

const rules = new Set(["rpc_slow", "rpc_errors", "link_slow"]);

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
    calls.push(call);
  }

  value.calls = calls;
  const links = new Set(value.links.map((link) => `${link.kind}:${link.targetId}`));
  value.findings = value.findings.filter(
    (finding) =>
      rules.has(finding.ruleId) &&
      ["warning", "critical"].includes(finding.severity) &&
      (finding.ruleId === "link_slow" ? links.has(finding.subject) : methods.has(finding.subject)),
  );

  return value;
}

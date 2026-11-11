import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { gatewayEvidence } from "./gateway-findings.ts";

export type Evidence = {
  ruleId: string;
  subject: string;
  value: number;
  threshold: number;
  samples: bigint;
  critical: boolean;
  duringSync?: boolean;
  fresh?: boolean;
};

const FAILURES = [2, 4, 8, 10, 13, 14, 15];

export class Findings {
  readonly states = new Map<string, ui.DiagnosticsFinding>();
  #observedDrops = 0n;
  #completeMinutes = 15;

  restore(values: ui.DiagnosticsFinding[]) {
    for (const value of values.slice(0, 64))
      this.states.set(
        `${value.ruleId}:${value.subject}`,
        create(ui.DiagnosticsFindingSchema, {
          ...value,
          entering: 0,
          leaving: 0,
          suspended: true,
        }),
      );
  }

  evaluate(snapshot: ui.ComputerDiagnostics, recent = snapshot) {
    this.#completeMinutes =
      snapshot.droppedSamples === this.#observedDrops ? Math.min(15, this.#completeMinutes + 1) : 0;
    this.#observedDrops = snapshot.droppedSamples;
    const evidence: Evidence[] = gatewayEvidence(snapshot, recent);

    for (const call of snapshot.calls) {
      if (call.stream || call.layer === "command" || /Import|Update|Install|Generate|Clone|Move|Ssh/.test(call.method))
        continue;
      const p95 = call.durationMs?.p95 ?? 0;
      const failures = FAILURES.reduce((sum, code) => sum + (call.codes[code] ?? 0n), 0n);
      const ratio = call.completed ? Number(failures) / Number(call.completed) : 0;

      if (call.completed >= 100n)
        evidence.push({
          ruleId: "rpc_slow",
          subject: `${call.layer}:${call.method}`,
          value: p95,
          threshold: 1000,
          samples: call.completed,
          critical: p95 > 3000 && call.slow >= 5n,
        });

      if (call.completed >= 100n && (failures >= 10n || this.states.has(`rpc_errors:${call.layer}:${call.method}`)))
        evidence.push({
          ruleId: "rpc_errors",
          subject: `${call.layer}:${call.method}`,
          value: ratio * 100,
          threshold: 5,
          samples: call.completed,
          critical: ratio > 0.05 && failures >= 10n,
        });
    }

    for (const link of snapshot.links)
      if (link.supported && link.online && (link.rttMs?.samples ?? 0n) >= 30n)
        evidence.push({
          ruleId: "link_slow",
          subject: `${link.kind}:${link.targetId}`,
          value: link.rttMs!.p95,
          threshold: 500,
          samples: link.rttMs!.samples,
          critical: link.rttMs!.p95 > 2000,
        });
    const fresh = new Set<string>();

    for (const value of evidence) {
      const key = `${value.ruleId}:${value.subject}`;
      fresh.add(key);
      const previous = this.states.get(key);

      const activity =
        value.fresh ??
        (value.ruleId === "link_slow"
          ? recent.links.some(
              (link) => `${link.kind}:${link.targetId}` === value.subject && (link.rttMs?.samples ?? 0n) > 0n,
            )
          : recent.calls.some((call) => `${call.layer}:${call.method}` === value.subject && call.completed > 0n));

      const enough =
        activity &&
        snapshot.observedSeconds >= (value.fresh === undefined ? 600 : 180) &&
        !snapshot.restoring &&
        this.#completeMinutes >= (value.fresh === undefined ? 15 : 3);

      const slow = snapshot.calls.find((call) => `${call.layer}:${call.method}` === value.subject)?.slow ?? 0n;
      const above = (value.value > value.threshold && (value.ruleId !== "rpc_slow" || slow >= 5n)) || value.critical;

      if (!above && !previous) continue;

      if (!previous && this.states.size >= 64) continue;
      const entering = enough && above ? Math.min(3, (previous?.entering ?? 0) + 1) : 0;

      const leaving =
        enough && value.value < value.threshold * 0.7 && !value.critical
          ? Math.min(5, (previous?.leaving ?? 0) + 1)
          : 0;

      if (leaving >= 5) {
        this.states.delete(key);
        continue;
      }

      this.states.set(
        key,
        create(ui.DiagnosticsFindingSchema, {
          ...value,
          severity: value.critical ? "critical" : "warning",
          observedSeconds: snapshot.observedSeconds,
          entering,
          leaving,
          suspended: !enough,
          active: entering >= 3 || Boolean(previous?.active && leaving < 5),
        }),
      );
    }

    for (const [key, finding] of this.states)
      if (!fresh.has(key)) {
        finding.suspended = true;
        finding.entering = 0;
        finding.leaving = 0;
      }
  }

  snapshot() {
    return [...this.states.values()]
      .filter((value) => value.active)
      .sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"));
  }
}

import type { ui } from "@canopy/contracts";
import { GOVERNOR_KINDS, GOVERNOR_PRIORITIES, governorMetric } from "@canopy/domain/diagnostics";
import type { Evidence } from "./findings.ts";

/** Minute evidence requires fresh samples; restored gauges never imply current saturation. */
export function gatewayEvidence(snapshot: ui.ComputerDiagnostics, recent: ui.ComputerDiagnostics): Evidence[] {
  if (!snapshot.gatewayMeasuresSupported) return [];
  const metrics = new Map(recent.gatewayMeasures.map((value) => [value.metricId, value]));

  const fresh = (id: number) =>
    Boolean(metrics.get(id)?.events && !metrics.get(id)?.historical && !metrics.get(id)?.incomplete);

  const evidence: Evidence[] = [];
  const loop = metrics.get(1)?.distribution;

  if (loop && loop.samples >= 1000n)
    evidence.push({
      ruleId: "event_loop",
      subject: "gateway",
      value: loop.p99,
      threshold: 100,
      samples: loop.samples,
      critical: loop.p99 > 500,
      fresh: fresh(1),
      duringSync: Boolean(metrics.get(20)?.events || metrics.get(31)?.events),
    });
  const waiting = metrics.get(7);

  if (waiting)
    evidence.push({
      ruleId: "db_pool",
      subject: "gateway",
      value: waiting.mean,
      threshold: 0.5,
      samples: waiting.events,
      critical: waiting.mean > 5,
      fresh: fresh(7) && waiting.observedSeconds >= 30,
    });

  for (const family of recent.database) {
    const timing = family.executeMs;

    if (timing && timing.samples >= 30n)
      evidence.push({
        ruleId: "db_slow",
        subject: family.family,
        value: timing.p95,
        threshold: 100,
        samples: timing.samples,
        critical: timing.p95 > 1000,
        fresh: recent.observedSeconds >= 30 && !family.incomplete,
      });
  }

  for (const kind of GOVERNOR_KINDS)
    for (const priority of GOVERNOR_PRIORITIES) {
      const waitId = governorMetric(kind, priority, "wait");
      const wait = metrics.get(waitId)?.distribution;
      const admissions = metrics.get(governorMetric(kind, priority, "admitted"))?.events ?? 0n;

      if (wait && admissions >= 30n)
        evidence.push({
          ruleId: "governor_wait",
          subject: `${kind}:${priority}`,
          value: (metrics.get(38)?.mean ?? 0) > 0 ? wait.p95 : 0,
          threshold: 1000,
          samples: admissions,
          critical: false,
          fresh: fresh(waitId),
        });
    }

  return evidence;
}

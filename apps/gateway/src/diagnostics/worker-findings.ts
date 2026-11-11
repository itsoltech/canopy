import type { ui } from "@canopy/contracts";
import type { Evidence } from "./findings.ts";

export function workerEvidence(
  history: ui.ComputerDiagnostics,
  snapshot: ui.ComputerDiagnostics,
  previous: Map<string, number>,
): Evidence[] {
  const result: Evidence[] = [];
  const known = new Set(snapshot.links.map((link) => `${link.kind}:${link.targetId}`));

  for (const key of previous.keys()) if (!known.has(key)) previous.delete(key);

  for (const link of snapshot.links) {
    if (!link.online || !link.measuresSupported) continue;
    const values = new Map(link.measures.map((row) => [row.metricId, row]));

    const fresh = (id: number) =>
      Boolean(values.get(id)?.events && !values.get(id)?.historical && !values.get(id)?.incomplete);

    const subject = `${link.kind}:${link.targetId}`;
    const backlog = values.get(100);
    const age = values.get(102);

    if (backlog && age && fresh(100) && fresh(102)) {
      const old = previous.get(subject);

      if (previous.has(subject) || previous.size < 16) previous.set(subject, backlog.last);
      result.push({
        ruleId: "worker_backlog",
        subject,
        value: old !== undefined && backlog.last > old ? age.last : 0,
        threshold: 30_000,
        samples: backlog.events,
        critical: old !== undefined && backlog.last > old && age.last > 300_000,
        fresh: old !== undefined,
      });
    }

    const cpu = history.links
      .find((row) => row.targetId === link.targetId && row.kind === link.kind)
      ?.measures.find((row) => row.metricId === 2);

    if (cpu && cpu.observedSeconds >= 300)
      result.push({
        ruleId: "worker_cpu",
        subject,
        value: cpu.mean,
        threshold: 90,
        samples: cpu.events,
        critical: false,
        fresh: fresh(2) && !cpu.incomplete,
        recovering: cpu.mean < 70,
      });

    const free = values.get(120),
      total = values.get(121);

    if (free && total?.last)
      result.push({
        ruleId: "worker_disk",
        subject,
        value: free.last < 2 * 1024 ** 3 ? 100 * (1 - free.last / total.last) : 0,
        threshold: 90,
        samples: free.events,
        critical: false,
        fresh: fresh(120) && fresh(121),
        recovering: free.last / total.last > 0.15 || free.last > 3 * 1024 ** 3,
      });

    const revisions = values.get(210),
      watches = values.get(220);

    if (revisions && watches && watches.mean >= 3)
      result.push({
        ruleId: "sync_refresh",
        subject,
        value:
          (values.get(221)?.events ?? 0n) > (values.get(222)?.events ?? 0n)
            ? Number(revisions.events) / watches.mean / Math.max(1, watches.observedSeconds / 60)
            : 0,
        threshold: 3,
        samples: revisions.events,
        critical: false,
        fresh: fresh(210) && fresh(220) && watches.observedSeconds >= 30,
      });
  }

  return result;
}

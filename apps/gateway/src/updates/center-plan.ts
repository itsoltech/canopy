import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { cliUpdateActionable } from "@canopy/domain/release/update-actions";
import { compareVersions } from "@canopy/updater";

export const newerVersion = (target: string, current: string): boolean => {
  try {
    return compareVersions(target, current) > 0;
  } catch {
    return false;
  }
};

/** Build from the authenticated snapshot only. Each action revalidates ownership and availability. */
export function updatePlan(snapshot: ui.UpdatesSnapshot): ui.UpdateRun {
  const steps: ui.UpdateStep[] = [];

  // A bundled gateway and worker update with the desktop app; their agent CLIs stay separate steps.
  if (
    !snapshot.gatewayBundled &&
    snapshot.gatewayInstallKind === "binary" &&
    newerVersion(snapshot.availableVersion, snapshot.gatewayVersion)
  )
    steps.push(
      create(ui.UpdateStepSchema, {
        kind: "gateway",
        label: "Gateway",
        version: snapshot.availableVersion,
        fromVersion: snapshot.gatewayVersion,
        state: "queued",
      }),
    );
  const target = steps[0]?.version || snapshot.gatewayVersion;

  for (const worker of snapshot.workers) {
    if (!worker.bundled && worker.installKind === "binary" && newerVersion(target, worker.version))
      steps.push(
        create(ui.UpdateStepSchema, {
          kind: "worker",
          workerId: worker.workerId,
          label: worker.name,
          version: target,
          fromVersion: worker.version,
          state: "queued",
        }),
      );
  }

  for (const worker of snapshot.cliWorkers) {
    if (!snapshot.workers.some((w) => w.workerId === worker.id)) continue;

    for (const cli of worker.cliTools) {
      // Managed installations expose instructions and remain individual decisions.
      if (!cli.tool || !cliUpdateActionable(cli)) continue;
      steps.push(
        create(ui.UpdateStepSchema, {
          kind: "cli",
          workerId: worker.id,
          provider: cli.tool.provider,
          label: `${worker.name} · ${cli.tool.provider === Provider.CLAUDE ? "Claude Code" : cli.tool.provider === Provider.CODEX ? "Codex" : "Grok"}`,
          version: cli.latest?.version || "",
          fromVersion: cli.tool.version,
          state: "queued",
        }),
      );
    }
  }

  for (const worker of snapshot.workers) {
    if (
      worker.installKind === "desktop" &&
      !worker.bundled &&
      worker.desktop?.connected &&
      !worker.desktop.disabledReason &&
      newerVersion(worker.desktop.availableVersion, worker.desktop.version)
    )
      steps.push(
        create(ui.UpdateStepSchema, {
          kind: "desktop",
          workerId: worker.workerId,
          label: `${worker.name} · Canopy app`,
          version: worker.desktop.availableVersion,
          fromVersion: worker.desktop.version,
          state: "queued",
        }),
      );
  }

  // Linked computers last: this computer's link stays up while each one restarts, one at a time.
  for (const computer of snapshot.computers) {
    const app = computer.updates?.app;

    if (
      computer.remoteUpdate &&
      computer.presence === "connected" &&
      app?.connected &&
      !app.disabledReason &&
      newerVersion(app.availableVersion, app.version)
    )
      steps.push(
        create(ui.UpdateStepSchema, {
          kind: "computer",
          nodeId: computer.nodeId,
          label: `${computer.name} · Canopy app`,
          version: app.availableVersion,
          fromVersion: app.version,
          state: "queued",
        }),
      );
  }

  return create(ui.UpdateRunSchema, { id: crypto.randomUUID(), state: steps.length ? "running" : "succeeded", steps });
}

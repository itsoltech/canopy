import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { cliUpdateActionable } from "./update-actions.ts";
import { newerAppVersion } from "./remote-update-state.ts";

/** A downloaded package stays actionable when a feed check omits availableVersion. */
export function appUpdateTarget(app: ui.DesktopUpdateState | undefined): string {
  if (!app) return "";

  return (
    [app.updaterVersion, app.availableVersion, app.phase === "failed" ? app.targetVersion : ""].find((version) =>
      newerAppVersion(version, app.version),
    ) || ""
  );
}

export function appUpdateAvailable(app: ui.DesktopUpdateState | undefined): boolean {
  return !!app && (!!appUpdateTarget(app) || app.ready || app.updaterPhase === "downloaded");
}

/** Shared eligibility for every Update all control and the owner gateway's durable plan. */
export function bulkUpdateSteps(snapshot: ui.UpdatesSnapshot): ui.UpdateStep[] {
  const steps: ui.UpdateStep[] = [];

  const add = (step: MessageInitShape<typeof ui.UpdateStepSchema>) =>
    steps.push(create(ui.UpdateStepSchema, { state: "queued", ...step }));

  const homes = [
    { home: snapshot, nodeId: "", name: "" },
    ...snapshot.computers.flatMap((computer) =>
      computer.remoteUpdate && computer.updates
        ? [{ home: computer.updates, nodeId: computer.nodeId, name: computer.name }]
        : [],
    ),
  ];

  if (!snapshot.gatewayBundled && newerAppVersion(snapshot.availableVersion, snapshot.gatewayVersion))
    add({
      kind: "gateway",
      label: "Gateway",
      version: snapshot.availableVersion,
      fromVersion: snapshot.gatewayVersion,
      ...(snapshot.gatewayInstallKind !== "binary" && {
        state: "skipped",
        reason: snapshot.gatewayReason || "Update the gateway with its installer.",
      }),
    });
  const gateway = steps.find((step) => step.kind === "gateway" && step.state === "queued");

  for (const { home, nodeId, name } of homes) {
    const target = nodeId ? home.gatewayVersion : gateway?.version || home.gatewayVersion;

    for (const worker of home.workers) {
      if (worker.bundled || worker.installKind === "desktop" || !newerAppVersion(target, worker.version)) continue;
      add({
        kind: "worker",
        workerId: worker.workerId,
        nodeId,
        label: name ? `${name} · ${worker.name}` : worker.name,
        version: target,
        fromVersion: worker.version,
        ...(worker.installKind !== "binary" && {
          state: "skipped",
          reason: worker.reason || "Update this worker with its installer.",
        }),
      });
    }
  }

  for (const { home, nodeId, name } of homes) {
    for (const worker of home.cliWorkers) {
      if (!home.workers.some((item) => item.workerId === worker.id)) continue;

      for (const cli of worker.cliTools) {
        if (!cli.tool || !cli.updateAvailable || cli.blockedReason.includes("owner")) continue;

        const provider =
          cli.tool.provider === Provider.CLAUDE
            ? "Claude Code"
            : cli.tool.provider === Provider.CODEX
              ? "Codex"
              : "Grok";

        add({
          kind: "cli",
          workerId: worker.id,
          nodeId,
          provider: cli.tool.provider,
          label: `${name ? `${name} · ` : ""}${worker.name} · ${provider}`,
          version: cli.latest?.version || "",
          fromVersion: cli.tool.version,
          ...(!cliUpdateActionable(cli) && {
            state: "skipped",
            reason: cli.managedBy
              ? `Update this agent CLI with ${cli.managedBy}.`
              : cli.tool.detail || "Update this agent CLI with its installer.",
          }),
        });
      }
    }
  }

  for (const worker of snapshot.workers) {
    if (worker.bundled || worker.installKind !== "desktop" || !appUpdateAvailable(worker.desktop)) continue;
    add({
      kind: "desktop",
      workerId: worker.workerId,
      label: `${worker.name} · Canopy app`,
      version: appUpdateTarget(worker.desktop),
      fromVersion: worker.desktop?.version || "",
      ...(worker.desktop?.connected &&
        worker.desktop.disabledReason && { state: "skipped", reason: worker.desktop.disabledReason }),
    });
  }

  // Keep our gateway alive until every linked computer returns from its restart.
  for (const computer of snapshot.computers) {
    const app = computer.updates?.app;

    if (!appUpdateAvailable(app)) continue;
    add({
      kind: "computer",
      nodeId: computer.nodeId,
      label: `${computer.name} · Canopy app`,
      version: appUpdateTarget(app),
      fromVersion: app?.version || computer.version,
      ...((!computer.remoteUpdate || (app?.connected && app.disabledReason)) && {
        state: "skipped",
        reason: app?.disabledReason || computer.reason || "Update Canopy on that computer.",
      }),
    });
  }

  if (snapshot.gatewayBundled && appUpdateAvailable(snapshot.app))
    add({
      kind: "app",
      label: `${snapshot.computerName || "This computer"} · Canopy app`,
      version: appUpdateTarget(snapshot.app),
      fromVersion: snapshot.app?.version || "",
      ...((!snapshot.appUpdateSupported || (snapshot.app?.connected && snapshot.app.disabledReason)) && {
        state: "skipped",
        reason: snapshot.app?.disabledReason || "Update this computer from its own window.",
      }),
    });

  return steps.filter(
    (step, index) =>
      steps.findIndex(
        (other) =>
          other.kind === step.kind &&
          other.nodeId === step.nodeId &&
          other.workerId === step.workerId &&
          other.provider === step.provider,
      ) === index,
  );
}

export const bulkUpdatesAvailable = (snapshot: ui.UpdatesSnapshot): boolean =>
  bulkUpdateSteps(snapshot).some((step) => step.state === "queued");

import { create, clone } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { newerVersion, updatePlan } from "./center-plan.ts";

export interface UpdateCenterOptions {
  read(): Promise<ui.UpdateRun | undefined>;
  write(run: ui.UpdateRun): Promise<void>;
  snapshot(): Promise<ui.UpdatesSnapshot>;
  manage(request: ui.ManageUpdatesRequest): Promise<ui.UpdatesSnapshot>;
  install(request: ui.InstallCliRequest): Promise<ui.InstallCliResponse>;
  desktop(request: ui.ManageUpdatesRequest): Promise<void>;
}

/** One serialized, durable chain. Acknowledgement is not completion; reports/version confirm each step. */
export class UpdateCenter {
  private operation: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly options: UpdateCenterOptions) {}

  start() {
    this.timer ??= setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 2000);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private serialize(action: () => Promise<void>) {
    const next = this.operation.then(action);
    this.operation = next.catch(() => undefined);

    return next;
  }
  begin() {
    return this.serialize(async () => {
      if ((await this.options.read())?.state === "running")
        throw new ConnectError("Update all is already running", Code.FailedPrecondition);
      const snapshot = await this.options.snapshot();
      const run = updatePlan(snapshot);

      if (!run.steps.length)
        throw new ConnectError(
          "No updates Canopy can install. Update externally managed items with their installer.",
          Code.FailedPrecondition,
        );

      if (run.steps.some((s) => ["gateway", "worker"].includes(s.kind)) && !snapshot.admin)
        throw new ConnectError(
          "An administrator must update the gateway and binary workers first",
          Code.PermissionDenied,
        );
      await this.options.write(run);
    }).then(() => this.tick());
  }
  tick() {
    return this.serialize(async () => {
      const run = await this.options.read();

      if (run?.state !== "running") return;
      const step = run.steps.find((s) => s.state !== "succeeded");

      if (!step) {
        run.state = "succeeded";
        await this.options.write(run);

        return;
      }

      try {
        const snapshot = await this.options.snapshot();

        if (step.state === "queued") {
          // Persist before sending. A crash never replays an unconfirmed CLI install or desktop restart.
          step.state = "running";
          step.startedAt = new Date().toISOString();
          await this.options.write(run);
          await this.launch(step, snapshot);
        } else if (await this.complete(step, snapshot)) step.state = "succeeded";

        if (Date.now() - Date.parse(step.startedAt) > 35 * 60_000)
          throw new Error("Timed out waiting for completion. Retry Update all after checking this item.");
      } catch (cause) {
        step.state = cause instanceof ConnectError && cause.code === Code.FailedPrecondition ? "blocked" : "failed";
        step.reason =
          cause instanceof ConnectError ? cause.rawMessage : cause instanceof Error ? cause.message : "Update failed";
        run.state = step.state;
        run.reason = `${step.label}: ${step.reason.replace(/\.$/, "")}. Later updates have not started.`;
      }

      await this.options.write(run);
    });
  }

  private async launch(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot) {
    if (step.kind === "gateway") {
      if (snapshot.gatewayInstallKind !== "binary")
        throw new ConnectError(
          snapshot.gatewayReason || "Update the gateway with its installer.",
          Code.FailedPrecondition,
        );

      if (snapshot.availableVersion !== step.version)
        throw new Error("The selected gateway release changed; check for updates and retry");
      await this.options.manage(create(ui.ManageUpdatesRequestSchema, { action: "gateway" }));
    } else if (step.kind === "worker") {
      if (snapshot.gatewayVersion !== step.version)
        throw new Error("Update the gateway to the selected worker version first");
      await this.options.manage(create(ui.ManageUpdatesRequestSchema, { action: "worker", workerId: step.workerId }));
    } else if (step.kind === "cli") {
      if (!step.version)
        throw new ConnectError("Check the latest CLI version before installing", Code.FailedPrecondition);
      const worker = snapshot.workers.find((w) => w.workerId === step.workerId);

      if (!worker || worker.compatibility !== "compatible")
        throw new Error("Worker and gateway protocols are incompatible; update the worker first");
      await this.options.install(
        create(ui.InstallCliRequestSchema, { workerId: step.workerId, provider: step.provider, version: step.version }),
      );
    } else if (step.kind === "desktop") {
      await this.options.desktop(create(ui.ManageUpdatesRequestSchema, { action: "desktop", workerId: step.workerId }));
    } else throw new Error("Unknown update kind");
  }

  private async complete(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot): Promise<boolean> {
    if (step.kind === "gateway") {
      if (snapshot.gatewayVersion === step.version) return true;

      if (snapshot.gatewayState === "failed") throw new Error(snapshot.gatewayReason || "Gateway update failed");

      return false;
    }

    const worker = snapshot.workers.find((w) => w.workerId === step.workerId);

    if (!worker) throw new Error("Worker no longer belongs to this update scope");

    if (step.kind === "worker") {
      if (worker.state === "failed") throw new Error(worker.reason || "Worker update failed");

      if (worker.version === step.version && worker.connected) {
        if (worker.compatibility !== "compatible")
          throw new Error("The updated worker is incompatible with the gateway protocol");

        return true;
      }
    } else if (step.kind === "cli") {
      const cli = snapshot.cliWorkers
        .find((w) => w.id === step.workerId)
        ?.cliTools.find((t) => t.tool?.provider === step.provider);

      if (cli?.tool?.install?.state === "failed") throw new Error(cli.tool.install.error || "CLI install failed");

      if (cli?.tool?.install?.state === "running") return false;

      if (cli?.tool?.version && !newerVersion(step.version, cli.tool.version)) return true;

      if (Date.now() - Date.parse(step.startedAt) > 60_000)
        throw new Error("CLI install was interrupted or has not reported a result; check the worker and retry");
    } else if (step.kind === "desktop") {
      if (worker.desktop?.phase === "failed") throw new Error(worker.desktop.reason || "Desktop update failed");

      return worker.desktop?.phase === "succeeded";
    }

    return false;
  }

  async status(snapshot?: ui.UpdatesSnapshot) {
    const run = await this.options.read();

    if (run && ["failed", "blocked"].includes(run.state)) {
      const failed = run.steps.filter((step) => ["failed", "blocked"].includes(step.state));
      const current = snapshot ?? (await this.options.snapshot());

      // Hide only the obsolete external-gateway failure; real failures keep their history.
      if (
        current.gatewayInstallKind !== "binary" &&
        failed.length === 1 &&
        failed[0]?.kind === "gateway" &&
        failed[0].reason.includes("Managed externally") &&
        !updatePlan(current).steps.length
      )
        return undefined;
    }

    return run ? clone(ui.UpdateRunSchema, run) : undefined;
  }
}

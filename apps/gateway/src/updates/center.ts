import { create, clone } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { plannedUpdateRun } from "@canopy/domain/release/update-plan";
import { knownUpdateOffline } from "@canopy/domain/release/update-offline";
import { remoteStepCurrent, remoteStepDismissed } from "./remote-outcome.ts";
import {
  dependencyFailureReason,
  pendingUpdate,
  retryUpdateSteps,
  UPDATE_CONCURRENCY,
  updateDependencies,
  updatesConflict,
} from "./center-scheduling.ts";
import { UpdateReconnects } from "./center-offline.ts";
import { computerUpdated } from "./computer-completion.ts";
import { cliStepComplete, requeueBusyCli, stepCli, uncertainCliLaunch, waitForCli } from "./center-cli.ts";

const UPDATE_TIMEOUT_MS = 35 * 60_000;

export interface UpdateCenterOptions {
  read(): Promise<ui.UpdateRun | undefined>;
  write(run: ui.UpdateRun): Promise<void>;
  snapshot(): Promise<ui.UpdatesSnapshot>;
  manage(request: ui.ManageUpdatesRequest, nodeId?: string): Promise<ui.UpdatesSnapshot>;
  install(request: ui.InstallCliRequest, nodeId?: string): Promise<ui.InstallCliResponse>;
  app?(): Promise<string>;
  desktop(request: ui.ManageUpdatesRequest): Promise<string | void>;
  /** Asks a linked computer for an app update; returns the request id there. */
  computer(nodeId: string): Promise<string>;
}

interface UpdateLaunch {
  step: ui.UpdateStep;
  settled: boolean;
  error?: Error;
}

/** Durable bounded scheduling. Acknowledgement is not completion; reports/version confirm each step. */
export class UpdateCenter {
  private operation: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private readonly reconnects = new UpdateReconnects();
  private readonly launching = new Map<string, UpdateLaunch>();
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
  private serialize<A>(action: () => Promise<A>): Promise<A> {
    const next = this.operation.then(action);
    this.operation = next.then(
      () => {},
      () => {},
    );

    return next;
  }
  /**
   * Plans, persists and launches the first steps before it answers, so the caller's first snapshot already shows
   * them running. Returns the snapshot it planned from (undefined when a run was already going).
   */
  async begin(confirmRestart = false): Promise<ui.UpdatesSnapshot | undefined> {
    if ((await this.options.read())?.state === "running") return undefined;

    const snapshot = await this.serialize(async () => {
      if ((await this.options.read())?.state === "running") return undefined;
      const snapshot = await this.options.snapshot();
      const run = plannedUpdateRun(snapshot, crypto.randomUUID());

      if (!run.steps.some((step) => step.state === "queued"))
        throw new ConnectError(
          run.steps.some((step) => knownUpdateOffline(step, snapshot))
            ? "No updates Canopy can install on the online computers. Reconnect an offline computer and try again."
            : "No updates Canopy can install. Update externally managed items with their installer.",
          Code.FailedPrecondition,
        );

      if (!confirmRestart && run.steps.some((step) => step.kind === "app" && step.state === "queued"))
        throw new ConnectError("Confirm the computer restart before updating all.", Code.FailedPrecondition);
      await this.options.write(run);

      return snapshot;
    });

    if (snapshot) await this.tick(snapshot).catch(() => undefined);

    return snapshot;
  }
  /** `planned`: a snapshot read moments ago in the same operation, so the first launch does not read it again. */
  tick(planned?: ui.UpdatesSnapshot) {
    return (this.ticking ??= this.serialize(async () => {
      const run = await this.options.read();

      if (run?.state !== "running") return;
      const snapshot = planned ?? (await this.options.snapshot());
      const contended = new Set<ui.UpdateStep>();

      for (const [index, step] of run.steps.entries()) {
        if (step.state !== "running") continue;
        const key = `${run.id}/${index}`;
        const launch = this.launching.get(key);
        const settled = launch?.settled;

        try {
          if (settled) step.requestId = launch.step.requestId;

          if (settled && requeueBusyCli(step, launch.error)) contended.add(step);
          else if ((!launch || settled || step.kind === "cli") && (await this.complete(step, snapshot)))
            this.succeed(step);
          else if (this.reconnects.deferOrSkip(step, key, run, snapshot)) continue;
          else if (settled && launch.error && !uncertainCliLaunch(step, launch.error)) throw launch.error;

          if (step.state === "running" && Date.now() - Date.parse(step.startedAt) > UPDATE_TIMEOUT_MS)
            throw new Error("Timed out waiting for completion. Retry Update all after checking this item.");
        } catch (cause) {
          this.fail(step, cause);
        }

        if (settled) this.launching.delete(key);
      }

      this.releaseOfflineLaunches(run, snapshot);

      for (const [index, step] of run.steps.entries()) {
        if (step.state !== "queued" || contended.has(step)) continue;

        if (this.reconnects.deferOrSkip(step, `${run.id}/${index}`, run, snapshot)) continue;
        const dependencies = updateDependencies(step, run.steps);

        if (dependencies.some(pendingUpdate)) continue;

        const dependency = dependencies.find(
          (item) =>
            (["failed", "blocked"].includes(item.state) ||
              (item.state === "dismissed" && !remoteStepCurrent(item, snapshot))) &&
            !knownUpdateOffline(item, snapshot),
        );

        if (dependency && ["worker", "cli"].includes(step.kind)) {
          this.fail(step, new ConnectError(dependencyFailureReason(dependency), Code.FailedPrecondition));
          continue;
        }

        const active = run.steps.filter((item) => item.state === "running");

        if (this.activeSlots(run) >= UPDATE_CONCURRENCY || active.some((item) => updatesConflict(step, item, snapshot)))
          continue;

        // An acknowledgement still in flight holds its slot even if its report timed out.
        if (
          [...this.launching.values()].some(
            (item) =>
              !item.settled && (updatesConflict(step, item.step, snapshot) || ["app", "gateway"].includes(step.kind)),
          )
        )
          continue;

        try {
          if (waitForCli(step, snapshot, UPDATE_TIMEOUT_MS)) continue;
          const install = step.kind === "cli" ? stepCli(step, snapshot)?.install : undefined;
          const following = install?.state === "running" && install.targetVersion === step.version;

          step.state = "running";
          step.startedAt ||= new Date().toISOString();

          if (step.kind === "cli") step.requestId = following ? install.installId : crypto.randomUUID();

          // Persist every reservation before sending; restart never replays an uncertain install.
          await this.options.write(run);

          if (await this.complete(step, snapshot, true)) this.succeed(step);
          else if (!following) {
            const launch: UpdateLaunch = {
              step: clone(ui.UpdateStepSchema, step),
              settled: false,
            };

            this.launching.set(`${run.id}/${index}`, launch);
            void this.launch(launch.step, snapshot)
              .catch((cause: Error) => {
                launch.error = cause;
              })
              .finally(() => {
                launch.settled = true;
              });
          }
        } catch (cause) {
          this.fail(step, cause);
        }
      }

      if (!run.steps.some(pendingUpdate)) {
        this.reconnects.clear();
        const failed = run.steps.find((item) => ["failed", "blocked"].includes(item.state));
        run.state = failed?.state || "succeeded";
        run.reason = failed ? "Some updates failed. Retry the failed items." : "";
      }

      if (run.state === "running" && run.steps.some((step) => ["failed", "blocked"].includes(step.state)))
        run.reason = "Some updates failed. Other updates continue.";
      await this.options.write(run);
    }).finally(() => {
      this.ticking = undefined;
    }));
  }

  private releaseOfflineLaunches(run: ui.UpdateRun, snapshot: ui.UpdatesSnapshot) {
    const active = new Set(
      run.steps.flatMap((step, index) => (step.state === "running" ? [`${run.id}/${index}`] : [])),
    );

    // Keep tracking an expected restart: its acknowledgement may still carry the request id.
    for (const [key, launch] of this.launching)
      if (!active.has(key) && knownUpdateOffline(launch.step, snapshot)) this.launching.delete(key);
  }

  private activeSlots(run: ui.UpdateRun): number {
    const slots = new Set(run.steps.flatMap((step, index) => (step.state === "running" ? [`${run.id}/${index}`] : [])));

    for (const [key, launch] of this.launching) {
      if (!launch.settled) slots.add(key);
      else if (!slots.has(key)) this.launching.delete(key);
    }

    return slots.size;
  }

  private succeed(step: ui.UpdateStep) {
    step.state = "succeeded";
    step.finishedAt = new Date().toISOString();
  }

  private fail(step: ui.UpdateStep, cause: unknown) {
    step.state = cause instanceof ConnectError && cause.code === Code.FailedPrecondition ? "blocked" : "failed";
    step.finishedAt = new Date().toISOString();
    step.reason =
      cause instanceof ConnectError ? cause.rawMessage : cause instanceof Error ? cause.message : "Update failed";
  }

  private async launch(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot) {
    const home =
      step.nodeId && step.kind !== "computer"
        ? snapshot.computers.find((item) => item.nodeId === step.nodeId)?.updates
        : snapshot;

    if (!home) throw new ConnectError("This computer is unavailable. Reconnect it and retry.", Code.FailedPrecondition);

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
      if (home.gatewayVersion !== step.version)
        throw new Error("Update the gateway to the selected worker version first");
      await this.options.manage(
        create(ui.ManageUpdatesRequestSchema, { action: "worker", workerId: step.workerId }),
        step.nodeId,
      );
    } else if (step.kind === "cli") {
      if (!step.version)
        throw new ConnectError("Check the latest CLI version before installing", Code.FailedPrecondition);
      const worker = home.workers.find((w) => w.workerId === step.workerId);

      if (!worker || worker.compatibility !== "compatible")
        throw new ConnectError(
          "Worker and gateway protocols are incompatible; update the worker first",
          Code.FailedPrecondition,
        );
      await this.options.install(
        create(ui.InstallCliRequestSchema, {
          workerId: step.workerId,
          provider: step.provider,
          version: step.version,
          installId: step.requestId,
        }),
        step.nodeId,
      );
    } else if (step.kind === "desktop") {
      step.requestId =
        (await this.options.desktop(
          create(ui.ManageUpdatesRequestSchema, { action: "desktop", workerId: step.workerId }),
        )) ?? "";
    } else if (step.kind === "computer") {
      step.requestId = await this.options.computer(step.nodeId);
    } else if (step.kind === "app") {
      if (!this.options.app) throw new Error("Update this Canopy app from its own window.");
      step.requestId = await this.options.app();
    } else throw new Error("Unknown update kind");
  }

  private async complete(step: ui.UpdateStep, snapshot: ui.UpdatesSnapshot, beforeLaunch = false): Promise<boolean> {
    if (step.kind === "gateway") {
      if (snapshot.gatewayVersion === step.version) return true;

      if (!beforeLaunch && snapshot.gatewayState === "failed")
        throw new Error(snapshot.gatewayReason || "Gateway update failed");

      return false;
    }

    if (step.kind === "computer")
      return beforeLaunch ? remoteStepCurrent(step, snapshot) : computerUpdated(step, snapshot);

    if (step.kind === "app") {
      if (remoteStepCurrent(step, snapshot)) return true;

      if (!beforeLaunch && snapshot.app?.phase === "failed")
        throw new Error(snapshot.app.reason || "App update failed");

      return false;
    }

    const home = step.nodeId ? snapshot.computers.find((item) => item.nodeId === step.nodeId)?.updates : snapshot;

    if (step.nodeId && snapshot.computers.find((item) => item.nodeId === step.nodeId)?.presence !== "connected")
      return false;

    if (!home) return false;
    const worker = home.workers.find((w) => w.workerId === step.workerId);

    if (!worker) throw new Error("Worker no longer belongs to this update scope");

    if (step.kind === "worker") {
      if (!beforeLaunch && worker.state === "failed") throw new Error(worker.reason || "Worker update failed");

      if (worker.version === step.version && worker.connected) {
        if (worker.compatibility !== "compatible")
          throw new Error("The updated worker is incompatible with the gateway protocol");

        return true;
      }
    } else if (step.kind === "cli") {
      return cliStepComplete(step, snapshot, beforeLaunch);
    } else if (step.kind === "desktop") {
      if (remoteStepCurrent(step, snapshot)) return true;

      if (!beforeLaunch && remoteStepDismissed(step, snapshot))
        throw new Error("The app update was dismissed. Request it again to continue.");

      if (!beforeLaunch && worker.desktop?.phase === "failed")
        throw new Error(worker.desktop.reason || "Desktop update failed");

      return false;
    }

    return false;
  }

  async status(snapshot?: ui.UpdatesSnapshot) {
    const run = await this.options.read();

    // Slow command acknowledgements must not hide the durable progress from readers or a second click.
    if (run?.state === "running") return clone(ui.UpdateRunSchema, run);

    return this.serialize(() => this.currentStatus(snapshot));
  }

  private async currentStatus(snapshot?: ui.UpdatesSnapshot) {
    const run = await this.options.read();

    if (run && ["failed", "blocked"].includes(run.state)) {
      const failed = run.steps.filter((step) => ["failed", "blocked"].includes(step.state));
      const current = snapshot ?? (await this.options.snapshot());

      let resolved = false;

      for (const step of failed) {
        const dismissed = remoteStepDismissed(step, current);

        if (
          !dismissed &&
          !remoteStepCurrent(step, current) &&
          !(step.kind === "cli" && cliStepComplete(step, current, true))
        )
          continue;

        if (dismissed) step.state = "dismissed";
        else this.succeed(step);
        step.reason = "";
        resolved = true;
      }

      if (resolved) {
        const remaining = run.steps.find((step) => ["failed", "blocked"].includes(step.state));
        run.state =
          remaining?.state ??
          (run.steps.every((step) => ["succeeded", "skipped"].includes(step.state)) ? "succeeded" : "superseded");
        run.reason = remaining ? `${remaining.label}: ${remaining.reason}` : "";
        await this.options.write(run);
      }

      // Hide only the obsolete external-gateway failure; real failures keep their history.
      if (
        current.gatewayInstallKind !== "binary" &&
        failed.length === 1 &&
        failed[0]?.kind === "gateway" &&
        failed[0].reason.includes("Managed externally") &&
        !plannedUpdateRun(current, "").steps.some((step) => step.state === "queued")
      )
        return undefined;
    }

    return run ? clone(ui.UpdateRunSchema, run) : undefined;
  }

  retry(requestId: string, index: number, confirmRestart = false) {
    return this.requeue(requestId, (run) => (run.steps[index] ? [run.steps[index]] : []), confirmRestart);
  }

  /** Retry failed: every failed or blocked step of the current stopped run, in one durable change. */
  retryFailed(requestId: string, confirmRestart = false) {
    return this.requeue(
      requestId,
      (run) => run.steps.filter((step) => ["failed", "blocked"].includes(step.state)),
      confirmRestart,
    );
  }

  private requeue(requestId: string, choose: (run: ui.UpdateRun) => ui.UpdateStep[], confirmRestart: boolean) {
    return this.serialize(async () => {
      const run = await this.options.read();
      const steps = run && run.id === requestId && run.state !== "running" ? choose(run) : [];

      if (!run || !steps.length || steps.some((step) => !["failed", "blocked"].includes(step.state)))
        throw new ConnectError("Choose a failed update from the current results.", Code.FailedPrecondition);

      const snapshot = await this.options.snapshot();
      const plan = plannedUpdateRun(snapshot, "").steps;
      const skipped = new Map<ui.UpdateStep, string>();
      const retry = retryUpdateSteps(run.steps, steps);

      for (const step of retry) {
        const offline = knownUpdateOffline(step, snapshot);

        if (offline) {
          skipped.set(step, offline);
          continue;
        }

        const current = plan.find(
          (item) =>
            item.kind === step.kind &&
            item.workerId === step.workerId &&
            item.nodeId === step.nodeId &&
            item.provider === step.provider,
        );

        if (current?.state === "skipped") {
          if (steps.includes(step)) throw new ConnectError(current.reason, Code.FailedPrecondition);
          skipped.set(step, current.reason);
        }
      }

      if (!confirmRestart && retry.some((step) => step.kind === "app" && !skipped.has(step)))
        throw new ConnectError("Confirm the computer restart before retrying its app.", Code.FailedPrecondition);

      // Keep the selected versions and successful history. Every launch checks the current owner and target again.
      for (const step of retry) {
        step.state = skipped.has(step) ? "skipped" : "queued";
        step.reason = skipped.get(step) ?? "";
        step.startedAt = "";
        step.finishedAt = skipped.has(step) ? new Date().toISOString() : "";
        step.requestId = "";
      }

      run.state = "running";
      run.reason = "";
      await this.options.write(run);
    }).then(() => this.tick().catch(() => undefined));
  }

  dismiss(requestId: string, acknowledge?: (step: ui.UpdateStep) => Promise<void>) {
    return this.serialize(async () => {
      const run = await this.options.read();

      if (!run || run.id !== requestId || !["failed", "blocked"].includes(run.state))
        throw new ConnectError("Choose the current stopped updates to dismiss.", Code.FailedPrecondition);

      for (const step of run.steps) {
        if (!["failed", "blocked"].includes(step.state)) continue;
        await acknowledge?.(step);
        step.state = "dismissed";
        step.reason = "";
      }

      run.state = "dismissed";
      run.reason = "";
      await this.options.write(run);
    });
  }
}

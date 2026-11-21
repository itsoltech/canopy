import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import { homes, linkedDownloading } from "@canopy/domain/release/computer-update";
import {
  canopyUpdateAction,
  canopyUpdateSnapshot,
  updateControlMessage,
  updateGatewayMessage,
} from "@canopy/domain/release/update-actions";
import { workerUpdateSignature } from "@canopy/domain/update-checks";
import { hasUnsentWork } from "./unsent-work.ts";
import { plannedUpdateRun } from "@canopy/domain/release/update-plan";
import {
  binaryUpdateStatus,
  furthestStatus,
  gatewayUpdateLifecycle,
  runStatuses,
  updateBadge,
  updateInProgress,
  updateTargetKey,
  type UpdateStatus,
} from "@canopy/domain/release/update-status";

type ManageInput = MessageInitShape<typeof ui.ManageUpdatesRequestSchema>;

/** What the user just asked for, shown at once and replaced by the gateway's answer (or reverted by its error). */
interface Optimistic {
  run: ui.UpdateRun | undefined;
  rows: ReadonlyMap<string, UpdateStatus>;
}

/** While something updates (a run, a worker, a linked download): its progress arrives with each read. */
const BUSY_RELOAD_MS = 2000;

/** A gateway that does not push update center changes (older): one visible read a minute. */
const FALLBACK_RELOAD_MS = 60_000;

/** Merges a burst of change notices into one read. */
const SOON_MS = 150;

type UpdateEvents = {
  readonly pushed: ReadonlySet<string>;
  subscribe(listener: (update: ui.OverviewUpdate) => void): () => void;
};

export class UpdatesState {
  snapshot = $state<ui.UpdatesSnapshot>();
  error = $state("");
  pending = $state("");
  optimistic = $state<Optimistic>();
  /** The run rows follow: the gateway's while it runs, otherwise the one just requested. */
  run = $derived(
    this.snapshot?.run?.state === "running" ? this.snapshot.run : (this.optimistic?.run ?? this.snapshot?.run),
  );
  #statuses = $derived(runStatuses(this.run));
  #loading: Promise<void> | undefined;
  #recovering = $state(false);
  #generation = 0;
  #users = 0;
  #stop: (() => void) | undefined;
  #schedule: ((delay?: number) => void) | undefined;
  #events: UpdateEvents | undefined;
  /** A row's badge: the further of its own state, its run step and what the user just started. */
  rowStatus(key: string, own: UpdateStatus | string): UpdateStatus | string {
    return furthestStatus(furthestStatus(own, this.#statuses.get(key)), this.optimistic?.rows.get(key));
  }
  get gatewayTransition(): boolean {
    return this.#recovering || gatewayUpdateLifecycle(this.snapshot?.gatewayState);
  }
  /** An action is pending, Update all is running, or the gateway cannot take update requests. */
  get active(): boolean {
    return !!this.pending || this.run?.state === "running" || this.gatewayTransition;
  }
  /** Only this target's pending action or active plan step reserves its controls. */
  targetBusy(key: string): boolean {
    return (
      this.optimistic?.rows.has(key) === true ||
      (this.run?.state === "running" &&
        this.run.steps.some((step) => updateTargetKey(step) === key && ["queued", "running"].includes(step.state)))
    );
  }
  /** An updating worker or restarting computer cannot run a CLI installer. */
  cliBlocked(workerId: string, nodeId = ""): boolean {
    const computer = this.snapshot?.computers.find((item) => item.nodeId === nodeId);
    const home = nodeId ? computer?.updates : this.snapshot;
    const worker = home?.workers.find((item) => item.workerId === workerId);

    return (
      this.gatewayTransition ||
      this.targetBusy(updateTargetKey({ kind: "worker", nodeId, workerId })) ||
      updateBusy(worker?.state ?? "") ||
      ["waiting_idle", "restarting"].includes(worker?.desktop?.phase ?? "") ||
      home?.gatewayState === "restarting" ||
      gatewayUpdateLifecycle(home?.gatewayState) ||
      ["waiting_idle", "restarting"].includes(home?.app?.phase ?? "") ||
      (!!computer && computer.presence !== "connected")
    );
  }
  /** A row's failed step in the stopped run, for its Retry; -1 without one. */
  failedStep(key: string): number {
    const run = this.snapshot?.run;

    if (!run || run.state === "running") return -1;

    return run.steps.findIndex((step) => ["failed", "blocked"].includes(step.state) && updateTargetKey(step) === key);
  }
  /** Reads keep going while an action is pending; one that started before the action's answer is dropped. */
  reload(): Promise<void> {
    return (this.#loading ??= this.#read().finally(() => {
      this.#loading = undefined;
    }));
  }
  async #read(): Promise<void> {
    const generation = this.#generation;
    const path = this.#busy() ? "/api/updates?refresh=1" : "/api/updates";

    try {
      const snapshot = decode(ui.UpdatesSnapshotSchema, await requestJson("GET", path));

      if (generation === this.#generation) {
        this.snapshot = canopyUpdateSnapshot(snapshot);
        this.#recovering = false;
        this.error = "";
      }
    } catch (error) {
      if (generation === this.#generation && !this.#recovering)
        this.error = error instanceof Error ? error.message : "Could not load updates";
    }
  }
  /**
   * Keeps the snapshot current until the returned stop function runs; every panel shares one schedule. Reads
   * follow pushed changes (`follow`); only an update in progress reads every 2 s. A gateway without pushed
   * updates gets one read a minute. Nothing reads while the page is hidden.
   */
  poll(): () => void {
    if (this.#users++ === 0) this.#stop = this.#start();

    return () => {
      if (--this.#users > 0) return;
      this.#stop?.();
      this.#stop = undefined;
    };
  }
  /** Reads again soon after the overview stream reports a change the update center shows. Returns the stop. */
  follow(events: UpdateEvents): () => void {
    this.#events = events;
    const workers = new Map<string, string>();

    return events.subscribe((update) => {
      const change = update.change;

      if (change.case === "worker") {
        const signature = workerUpdateSignature(change.value);
        const previous = workers.get(change.value.id);
        workers.set(change.value.id, signature);

        if (previous === undefined || previous === signature) return;
      } else if (
        !["updatesChanged", "desktopUpdate", "gatewayDeparture", "computer", "workerRemoved", "feeds"].includes(
          change.case ?? "",
        ) &&
        !(change.case === "linkedReadCompleted" && change.value === "GetComputerUpdates")
      )
        return;

      this.#schedule?.(SOON_MS);
    });
  }
  #busy(): boolean {
    const snapshot = this.snapshot;

    return (
      !!this.pending ||
      this.gatewayTransition ||
      (!!snapshot &&
        (snapshot.checking ||
          updateBusy(snapshot.gatewayState) ||
          snapshot.run?.state === "running" ||
          homes(snapshot).some(({ home }) =>
            home.workers.some((w) => !workerUpdateOffline(w) && updateBusy(w.state)),
          ) ||
          updateBusy(snapshot.app?.phase ?? "") ||
          ["checking", "downloading"].includes(snapshot.app?.updaterPhase ?? "") ||
          linkedDownloading(snapshot)))
    );
  }
  #start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;

    const schedule = (delay?: number) => {
      clearTimeout(timer);

      const next =
        delay ?? (this.#busy() ? BUSY_RELOAD_MS : this.#events?.pushed.has("updates") ? undefined : FALLBACK_RELOAD_MS);

      if (next !== undefined && !stopped) timer = setTimeout(() => void tick(), next);
    };

    const tick = async () => {
      if (document.hidden) return;
      await this.reload();
      schedule();
    };

    const visibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > FALLBACK_RELOAD_MS) schedule(0);
      else schedule();
    };

    this.#schedule = schedule;
    document.addEventListener("visibilitychange", visibility);
    schedule(0);

    return () => {
      stopped = true;
      clearTimeout(timer);
      this.#schedule = undefined;
      document.removeEventListener("visibilitychange", visibility);
    };
  }
  /** `target`: the row the action belongs to (`updateTargetKey`), shown as Starting until the answer arrives. */
  async manage(input: ManageInput, target = ""): Promise<void> {
    if (this.pending || this.gatewayTransition) return;

    if (input.confirmRestart && hasUnsentWork()) {
      this.error = "Send or discard your drafts and files before updating this computer.";

      return;
    }

    this.#generation++;
    this.pending = input.workerId || input.nodeId || input.action || "update";
    this.error = "";
    this.optimistic = this.#expect(input, target);
    const action = canopyUpdateAction(input.action);

    try {
      const snapshot = decode(
        ui.UpdatesSnapshotSchema,
        await requestJson(
          "POST",
          "/api/updates",
          encode(ui.ManageUpdatesRequestSchema, create(ui.ManageUpdatesRequestSchema, { ...input, action })),
          150_000,
        ),
      );

      this.snapshot = canopyUpdateSnapshot(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update action failed";
      this.error = updateGatewayMessage(action, message) || message;
      this.#recovering = !!updateControlMessage(message);
    } finally {
      this.#generation++;
      this.pending = "";
      this.optimistic = undefined;
    }

    if (this.#recovering) {
      await this.#loading;
      await this.reload();
    }

    this.#schedule?.();
  }
  #expect(input: ManageInput, target: string): Optimistic | undefined {
    const snapshot = this.snapshot;

    if (input.action === "update_all" && snapshot) return { run: plannedUpdateRun(snapshot, ""), rows: new Map() };

    const steps = snapshot?.run?.steps ?? [];
    let retried: ui.UpdateStep[] = [];

    if (input.action === "retry_failed") retried = steps.filter((step) => ["failed", "blocked"].includes(step.state));

    if (input.action === "retry_step") retried = steps.filter((_, index) => index === (input.updateStepIndex ?? 0));

    const rows = new Map<string, UpdateStatus>([
      ...retried.map((step) => [updateTargetKey(step), "starting"] as const),
      ...(target ? [[target, "starting"] as const] : []),
    ]);

    return rows.size ? { run: undefined, rows } : undefined;
  }
}

/** The tab's one update center: the sidebar indicator and every updates panel share it. */
export const updateCenter = new UpdatesState();

export const workerUpdateOffline = (worker: ui.WorkerUpdate): boolean =>
  !worker.connected && !["restarting", "reconnecting"].includes(worker.state);

export function updateBusy(state: string): boolean {
  const status = binaryUpdateStatus(state);

  return status === "queued" || updateInProgress(status ?? "");
}

export function updateStateLabel(state: string, compatible: boolean): string {
  const status = binaryUpdateStatus(state);

  return status
    ? updateBadge(status).label
    : ({ succeeded: "Up to date", managed_externally: "Managed externally", ahead: "Newer than gateway" }[state] ??
        (compatible ? "Compatible" : "Update required"));
}

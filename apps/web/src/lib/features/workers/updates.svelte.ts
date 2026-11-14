import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";
import { linkedDownloading } from "@canopy/domain/release/computer-update";
import { workerUpdateSignature } from "@canopy/domain/update-checks";
import { hasUnsentWork } from "./unsent-work.ts";
import { plannedUpdateRun } from "@canopy/domain/release/update-plan";
import { furthestStatus, runStatuses, updateTargetKey, type UpdateStatus } from "@canopy/domain/release/update-status";

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
  #loading = false;
  #generation = 0;
  #users = 0;
  #stop: (() => void) | undefined;
  #soon: (() => void) | undefined;
  #events: UpdateEvents | undefined;
  /** A row's badge: the further of its own state, its run step and what the user just started. */
  rowStatus(key: string, own: UpdateStatus | string): UpdateStatus | string {
    return furthestStatus(furthestStatus(own, this.#statuses.get(key)), this.optimistic?.rows.get(key));
  }
  /** An action is pending or Update all runs: row actions wait (this computer restarts last). */
  get active(): boolean {
    return !!this.pending || this.run?.state === "running";
  }
  /** A row's failed step in the stopped run, for its Retry; -1 without one. */
  failedStep(key: string): number {
    const run = this.snapshot?.run;

    if (!run || run.state === "running") return -1;

    return run.steps.findIndex((step) => ["failed", "blocked"].includes(step.state) && updateTargetKey(step) === key);
  }
  /** Reads keep going while an action is pending; one that started before the action's answer is dropped. */
  async reload(): Promise<void> {
    if (this.#loading) return;
    this.#loading = true;
    const generation = this.#generation;

    try {
      const snapshot = decode(ui.UpdatesSnapshotSchema, await requestJson("GET", "/api/updates"));

      if (generation === this.#generation) {
        this.snapshot = snapshot;
        this.error = "";
      }
    } catch (error) {
      if (generation === this.#generation)
        this.error = error instanceof Error ? error.message : "Could not load updates";
    } finally {
      this.#loading = false;
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

      this.#soon?.();
    });
  }
  #busy(): boolean {
    const snapshot = this.snapshot;

    return (
      !!this.pending ||
      (!!snapshot &&
        (snapshot.checking ||
          updateBusy(snapshot.gatewayState) ||
          snapshot.run?.state === "running" ||
          snapshot.workers.some((w) => updateBusy(w.state)) ||
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

    this.#soon = () => schedule(SOON_MS);
    document.addEventListener("visibilitychange", visibility);
    schedule(0);

    return () => {
      stopped = true;
      clearTimeout(timer);
      this.#soon = undefined;
      document.removeEventListener("visibilitychange", visibility);
    };
  }
  /** `target`: the row the action belongs to (`updateTargetKey`), shown as Starting until the answer arrives. */
  async manage(input: ManageInput, target = ""): Promise<void> {
    if (this.pending) return;

    if (input.confirmRestart && hasUnsentWork()) {
      this.error = "Send or discard your drafts and files before updating this computer.";

      return;
    }

    this.#generation++;
    this.pending = input.workerId || input.nodeId || input.action || "update";
    this.error = "";
    this.optimistic = this.#expect(input, target);

    try {
      this.snapshot = decode(
        ui.UpdatesSnapshotSchema,
        await requestJson(
          "POST",
          "/api/updates",
          encode(ui.ManageUpdatesRequestSchema, create(ui.ManageUpdatesRequestSchema, input)),
          150_000,
        ),
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Update action failed";
    } finally {
      this.#generation++;
      this.pending = "";
      this.optimistic = undefined;
    }
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

export const updateBusy = (state: string) => ["queued", "waiting_idle", "downloading", "restarting"].includes(state);

export const updateStateLabel = (state: string, compatible: boolean) =>
  ({
    queued: "Queued",
    waiting_idle: "Waiting for idle",
    downloading: "Updating",
    restarting: "Restarting",
    failed: "Failed",
    succeeded: "Up to date",
    managed_externally: "Managed externally",
    ahead: "Newer than gateway",
  })[state] ?? (compatible ? "Compatible" : "Update required");

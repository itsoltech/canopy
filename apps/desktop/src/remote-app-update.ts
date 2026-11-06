import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { gt, valid } from "semver";
import { createHash } from "node:crypto";
import type { DesktopUpdateStatus } from "@canopy/ui/desktop";

export interface RemoteUpdateBoundary {
  status(): DesktopUpdateStatus;
  check(): Promise<DesktopUpdateStatus>;
  drain(value: boolean): Promise<boolean>;
  /** `requestedBy`: the linked computer that asked (local mode); empty for the gateway owner. */
  notify(requestedBy: string): void;
  prepareRestart?(): Promise<DesktopUpdateStatus | undefined>;
  restart(): void;
  report(state: ui.DesktopUpdateState): Promise<void>;
}

/** Download progress alone goes to the gateway at most this often; any other change goes at once. */
export const PROGRESS_REPORT_MS = 1000;

/** The app's own updater as linked computers see it, apart from any requested update (docs/updates.md). */
const updater = (update: DesktopUpdateStatus) => ({
  updaterPhase: update.phase,
  updaterVersion: update.updateVersion ?? "",
  updaterProgress: update.phase === "downloading" ? Math.max(0, Math.min(100, update.progress ?? 0)) : 0,
  updaterError: (update.error || (update.phase === "error" ? update.message : "")).slice(0, 1000),
});

/** Main-process policy around the normal updater. The file survives lost replies and app restarts. */
export class RemoteAppUpdate {
  get active() {
    return this.running;
  }
  private state = create(ui.DesktopUpdateStateSchema, { phase: "idle" });
  private force = false;
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private path: string;
  private historyError = "";
  private reported = { at: 0, key: "" };
  private trailing: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly basePath: string,
    private readonly boundary: RemoteUpdateBoundary,
  ) {
    this.path = basePath;
    this.restore();
  }
  selectDevice(deviceId: string) {
    if (this.running) throw new Error("Wait for the requested app update to finish.");
    this.path = `${this.basePath}.${createHash("sha256").update(deviceId).digest("hex")}`;
    this.restore();
  }
  private restore() {
    this.state = create(ui.DesktopUpdateStateSchema, { phase: "idle" });
    this.historyError = "";

    try {
      if (existsSync(this.path))
        this.state = fromJsonString(ui.DesktopUpdateStateSchema, readFileSync(this.path, "utf8"));
    } catch {
      this.historyError = "Remote update history is unreadable. Repair the local history before retrying.";

      return;
    }

    if (this.state.requestId && !["succeeded", "failed"].includes(this.state.phase)) {
      const version = this.boundary.status().version;
      this.state.phase =
        this.state.phase === "restarting" && version === this.state.targetVersion ? "succeeded" : "failed";
      this.state.reason =
        this.state.phase === "failed" ? "The app restarted before the update completed. Request it again." : "";
      this.persist();
    }
  }
  private persist() {
    if (this.historyError) return;
    this.state.revision++;
    writeFileSync(`${this.path}.new`, toJsonString(ui.DesktopUpdateStateSchema, this.state), { mode: 0o600 });
    renameSync(`${this.path}.new`, this.path);
  }
  /** What the journal keeps: the requested update. The updater's live state is never written. */
  private durable() {
    const update = this.boundary.status();

    return {
      ...this.state,
      version: update.version,
      channel: update.channel,
      availableVersion: this.running
        ? this.state.availableVersion
        : (update.updateVersion ?? this.state.availableVersion),
      disabledReason: this.historyError || (update.phase === "disabled" ? update.message : ""),
      ready: update.phase === "downloaded",
    };
  }
  snapshot() {
    return { ...this.durable(), ...updater(this.boundary.status()) };
  }
  async publish() {
    const next = this.durable();

    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = create(ui.DesktopUpdateStateSchema, next);
      this.persist();
    }

    await this.report();
  }
  /** Reports the current state; while only the progress moves, at most once per PROGRESS_REPORT_MS, then the last. */
  private report(): Promise<void> {
    const state = this.snapshot();
    const key = JSON.stringify({ ...state, progress: 0, updaterProgress: 0 });
    const wait = this.reported.at + PROGRESS_REPORT_MS - Date.now();

    if (key === this.reported.key && wait > 0) {
      this.trailing ??= setTimeout(() => {
        this.trailing = undefined;
        void this.report().catch(() => {});
      }, wait);

      return Promise.resolve();
    }

    clearTimeout(this.trailing);
    this.trailing = undefined;
    this.reported = { at: Date.now(), key };

    return this.boundary.report(state);
  }
  changed() {
    if (!this.running || !["checking", "downloading"].includes(this.state.phase)) return;
    const update = this.boundary.status();

    if (update.phase !== "downloading") return;
    this.state.progress = update.progress ?? 0;
    this.state.phase = "downloading";
    this.state.availableVersion = update.updateVersion ?? this.state.availableVersion;
    this.state.targetVersion = this.state.availableVersion;
    this.persist();
    void this.report().catch(() => {});
  }
  async command(command: ui.DesktopUpdateCommand) {
    // Fail closed without overwriting unreadable history or replaying an unknown completed request.
    if (this.historyError) return;

    if (command.requestId === this.state.requestId) {
      if (command.force && this.running) {
        this.force = true;
        await this.pollIdle();
      }

      await this.publish().catch(() => {});

      return;
    }

    if (this.running) return;
    this.running = true;
    this.force = false;
    this.state = create(ui.DesktopUpdateStateSchema, { requestId: command.requestId, phase: "checking" });
    this.persist();
    this.boundary.notify(command.requestedBy);

    try {
      await this.publish().catch(() => {});
      const update = await this.boundary.check();
      this.state.targetVersion = update.updateVersion ?? "";

      if (update.phase !== "downloaded") throw new Error(update.message);

      if (!valid(update.updateVersion) || !valid(update.version) || !gt(update.updateVersion!, update.version))
        throw new Error("Remote updates require a strictly newer signed release.");
      this.state.availableVersion = update.updateVersion!;
      this.state.targetVersion = update.updateVersion!;
      this.state.phase = "waiting_idle";
      this.state.reason = "Will restart after the current turns.";
      this.persist();
      await this.publish().catch(() => {});
      this.timer = setInterval(() => void this.pollIdle(), 1000);
      await this.pollIdle();
    } catch (error) {
      await this.fail(error instanceof Error ? error.message : "Desktop update failed.");
    }
  }
  private polling = false;
  private async pollIdle() {
    if (this.polling || this.state.phase !== "waiting_idle") return;
    this.polling = true;

    try {
      const idle = await this.boundary.drain(true);

      if (!idle && !this.force) return;
      // Periodic/manual checks may have replaced the ready download while the worker drained.
      // Freeze the updater before reporting the exact version this restart installs.
      const update = this.boundary.prepareRestart ? await this.boundary.prepareRestart() : this.boundary.status();

      if (
        !update ||
        update.phase !== "downloaded" ||
        !valid(update.updateVersion) ||
        !valid(update.version) ||
        !gt(update.updateVersion!, update.version)
      )
        throw new Error("No newer app update is ready");
      this.state.targetVersion = update.updateVersion!;
      this.state.availableVersion = update.updateVersion!;
      this.state.phase = "restarting";
      this.state.reason = "Restarting Canopy app; it will reconnect automatically.";
      this.persist();
      // Persist locally before quitting; a disconnected gateway must not strand the update.
      await this.publish().catch(() => {});
      this.stop();
      this.boundary.restart();
    } catch {
      await this.fail("Could not confirm the desktop worker is idle. Retry the update.");
    } finally {
      this.polling = false;
    }
  }
  private async fail(reason: string) {
    this.stop();
    this.running = false;
    this.state.phase = "failed";
    this.state.reason = reason;
    this.persist();
    await this.boundary.drain(false).catch(() => {});
    await this.publish().catch(() => {});
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    clearTimeout(this.trailing);
    this.trailing = undefined;
  }
}

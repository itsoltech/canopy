import type { DesktopStatus, DesktopUpdateStatus } from "@canopy/ui/desktop";

/** Each mounted consumer owns its bridge subscription; updater work stays in main. */
export class DesktopUpdatesState {
  status = $state<DesktopUpdateStatus>();
  pending = $state(false);
  error = $state("");
  restarting = $state(false);
  remote = $state(false);
  workerId = $state<string>();

  connect() {
    const bridge = window.canopyDesktop;

    if (!bridge?.updates) return;
    let active = true;

    const receive = (value: DesktopUpdateStatus) => {
      if (active) this.status = value;
    };

    const off = bridge.onUpdates(receive);

    const receiveStatus = (value: DesktopStatus) => {
      if (!active) return;
      this.remote = value.mode === "remote";
      this.workerId = value.workerId;
    };

    const offStatus = bridge.onStatus(receiveStatus);

    void bridge
      .status()
      .then(receiveStatus)
      .catch(() => {});
    void bridge
      .updates()
      .then(receive)
      .catch(() => {
        if (active) this.error = "Could not read app update status. Check for updates to try again.";
      });

    return () => {
      active = false;
      off();
      offStatus();
    };
  }

  async run() {
    if (!this.status?.stagedVersion && this.status?.phase !== "downloaded") return this.check();
    const bridge = window.canopyDesktop;

    if (!bridge || this.restarting) return;
    this.restarting = true;

    try {
      await bridge.restartToUpdate();
    } catch {
      this.error = "The app update failed. Check again to retry.";
    } finally {
      this.restarting = false;
    }
  }

  async check() {
    const bridge = window.canopyDesktop;

    if (!bridge || this.pending) return;
    this.pending = true;
    this.error = "";

    try {
      this.status = await bridge.checkForUpdates();
    } catch {
      this.error = "The app update failed. Check again to retry.";
    } finally {
      this.pending = false;
    }
  }
}

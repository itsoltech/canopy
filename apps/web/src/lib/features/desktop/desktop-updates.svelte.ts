import type { DesktopUpdateStatus } from "@canopy/ui/desktop";

/** Each mounted consumer owns its bridge subscription; updater work stays in main. */
export class DesktopUpdatesState {
  status = $state<DesktopUpdateStatus>();
  pending = $state(false);
  error = $state("");

  connect() {
    const bridge = window.canopyDesktop;

    if (!bridge?.updates) return;
    let active = true;

    const receive = (value: DesktopUpdateStatus) => {
      if (active) this.status = value;
    };

    const off = bridge.onUpdates(receive);
    void bridge
      .updates()
      .then(receive)
      .catch(() => {
        if (active) this.error = "App update status could not be loaded.";
      });

    return () => {
      active = false;
      off();
    };
  }

  async run() {
    const bridge = window.canopyDesktop;

    if (!bridge || this.pending) return;
    this.pending = true;
    this.error = "";

    try {
      if (this.status?.phase === "downloaded") await bridge.restartToUpdate();
      else this.status = await bridge.checkForUpdates();
    } catch {
      this.error = "The app update failed. Check again to retry.";
    } finally {
      this.pending = false;
    }
  }
}

import { toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
import { LocalDesktopControl } from "../../../apps/desktop/src/local-control.ts";
import { RemoteAppUpdate } from "../../../apps/desktop/src/remote-app-update.ts";
import type { TestGateway } from "./gateway.ts";

/** Real desktop control and durable policy; only the platform updater and worker drain are scripted. */
export class LocalApp {
  status: DesktopUpdateStatus;
  idle = false;
  restarts = 0;
  checks = 0;
  readonly notified: string[] = [];
  readonly reports: ui.DesktopUpdateState[] = [];
  readonly control: LocalDesktopControl;
  readonly coordinator: RemoteAppUpdate;
  private readonly loop: Promise<void>;
  private download: (() => void) | undefined;

  constructor(gateway: TestGateway, journal: string, version = "1.0.0", available = "1.1.0") {
    this.status = {
      version,
      channel: "nightly",
      buildChannel: "nightly",
      phase: "idle",
      message: "Update available",
      updateVersion: available,
      changingChannel: false,
    };
    this.control = new LocalDesktopControl(gateway.api, gateway.workerId, (command) => {
      if (command.check) void this.coordinator.publish();
      else void this.coordinator.command(command);
    });
    this.coordinator = new RemoteAppUpdate(journal, {
      status: () => this.status,
      check: async () => {
        this.checks++;
        this.status = { ...this.status, phase: "checking" };
        await this.coordinator.publish();
        await new Promise<void>((resolve) => {
          this.download = resolve;
        });
        this.status = { ...this.status, phase: "downloading", progress: 42 };
        this.coordinator.changed();
        await this.coordinator.publish();
        await new Promise<void>((resolve) => {
          this.download = resolve;
        });
        this.status = { ...this.status, phase: "downloaded", progress: 100, stagedVersion: available };

        return this.status;
      },
      drain: async () => this.idle,
      notify: (by) => this.notified.push(by),
      restart: () => {
        this.restarts++;
      },
      report: (state) => {
        this.reports.push(state);

        return this.control.report(toJsonString(ui.DesktopUpdateStateSchema, state));
      },
    });
    void this.coordinator.publish();
    this.loop = this.control.run();
  }

  advance() {
    this.download?.();
    this.download = undefined;
  }

  async stop() {
    this.coordinator.stop();
    this.control.stop();
    await this.loop;
  }
}

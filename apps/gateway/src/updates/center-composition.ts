import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "../core/core.ts";
import { coreWorkers } from "../core/core-providers.ts";
import { coreState } from "../core/core-context.ts";
import { UpdateCenter } from "./center.ts";
import { UpdateRunStore } from "./run-store.ts";
import { linkedUpdates, requestComputerUpdate } from "./linked.ts";

/** With `linked`, linked computers' apps too; a linked computer asking for this one's snapshot gets it without. */
export async function updatesSnapshot(core: GatewayCore, linked = true) {
  const value = await core.updates.snapshot();
  value.departure = await core.departures.snapshot();
  const states = await core.desktopControl.states();
  value.cliWorkers = await coreWorkers(core);

  for (const worker of value.workers) {
    // The local-mode worker never opens desktop control: the app updates it with itself.
    if (worker.installKind !== "desktop" || worker.bundled) continue;
    worker.desktop =
      states.find((s) => s.workerId === worker.workerId) ??
      create(ui.DesktopUpdateStateSchema, {
        workerId: worker.workerId,
        disabledReason: "Pair this desktop app, or update it manually to enable remote updates.",
      });
  }

  if (core.role === "desktop") {
    value.app = core.appControl.snapshot();
    value.appUpdateSupported = core.appControl.supportsUpdates;
    value.computerName = core.computers?.hello().name || "This computer";

    if (linked) value.computers = await linkedUpdates(core);
  }

  return value;
}

export function createUpdateCenter(core: GatewayCore) {
  const { runtime, userId } = core[coreState].options;
  const store = new UpdateRunStore(runtime, userId);

  return new UpdateCenter({
    read: () => store.read(),
    write: (run) => store.write(run),
    snapshot: () => updatesSnapshot(core),
    manage: (request) => core.updates.manage(request),
    install: (request) => core.installCli(request),
    desktop: async (request) => {
      await core.desktopControl.manage(request);
    },
    computer: async (nodeId) => {
      const snapshot = await requestComputerUpdate(core, nodeId, "app");

      return snapshot.app?.requestId ?? "";
    },
  });
}

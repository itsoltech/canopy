import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { Schema } from "effect";
import { pinnedOrigins } from "@canopy/transport";
import type { DesktopMigrationStatus, DesktopMigrationTarget } from "@canopy/ui/desktop";
import type { ControllerArguments, ControllerResult } from "./controller.ts";
import { saveRemoteClient } from "./client-vault.ts";
import { deviceRegistration, migrationDevice, removeMigrationDevice } from "./migration-device-vault.ts";
import { joinApproval, migrationKind } from "./runtime/migration-state.ts";
import { migrationSshTarget } from "./runtime/migration-ssh.ts";
import type { DesktopClientCredential } from "./remote-client.ts";

const decodeTarget = Schema.decodeUnknownSync(
  Schema.Struct({
    kind: migrationKind,
    invitation: Schema.String.check(Schema.isMaxLength(253)),
  }),
);

const activation = Schema.Struct({
  approval: Schema.optional(joinApproval),
  selectedPeerIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(Schema.isMaxLength(1000)),
  ),
});

const decodeActivation = Schema.decodeUnknownSync(activation);

interface MigrationIpcOptions {
  directory: string;
  origin: string;
  rpc: (action: string, args?: ControllerArguments) => Promise<ControllerResult>;
  authorize: (event: IpcMainInvokeEvent) => void;
  avoidRestart: () => boolean;
  onSwitch: (client: DesktopClientCredential) => Promise<void>;
}

export function registerMigrationIpc(options: MigrationIpcOptions) {
  let busy = false;
  const read = () => options.rpc("migration-status");

  const authorize = (event: IpcMainInvokeEvent) => {
    options.authorize(event);

    if (!event.senderFrame) throw new Error("Open gateway migration in Canopy Desktop");
    const url = new URL(event.senderFrame.url);

    if (url.origin !== options.origin || url.pathname !== "/desktop/migration")
      throw new Error("Open gateway migration in Canopy Desktop");
  };

  const run =
    <Argument>(use: (event: IpcMainInvokeEvent, argument: Argument) => Promise<ControllerResult | undefined>) =>
    async (event: IpcMainInvokeEvent, argument: Argument) => {
      authorize(event);

      if (busy || options.avoidRestart()) throw new Error("Wait for the other desktop operation to finish");
      busy = true;

      try {
        const result = (await use(event, argument)) ?? (await read());
        const switched = await completeSwitch(options, result);

        return status(switched);
      } finally {
        busy = false;
      }
    };

  ipcMain.handle("canopy:migration-status", async (event) => {
    options.authorize(event);

    return status(await read());
  });
  ipcMain.handle(
    "canopy:migration-prepare",
    run(async (event, raw: DesktopMigrationTarget) => {
      const input = decodeTarget(raw);
      const invitation = migrationSshTarget(input.invitation);
      const message = "Run a migration trial?";
      const detail = `Canopy connects to “${invitation}” over SSH. Continue only if you recognize the server and its operator.`;

      if (!(await confirm(event, message, detail, "Run trial"))) return;
      authorize(event);

      return options.rpc("migration-prepare", { migrationTarget: { ...input, invitation } });
    }),
  );
  ipcMain.handle(
    "canopy:migration-activate",
    run(async (event, raw: typeof activation.Type) => {
      const { approval, selectedPeerIds } = decodeActivation(raw);
      const current = await read();
      const migration = status(current);
      const runId = current.migrationRunId;

      if (!runId || !migration.target || !["prepared", "fenced"].includes(migration.phase))
        throw new Error("Prepare this migration before continuing");
      const join = migration.kind === "join";

      const message = join
        ? approval
          ? "Join the shared server?"
          : "Pause this gateway for the final review?"
        : "Move this gateway?";

      const action = join ? (approval ? "Join server" : "Pause gateway") : "Move gateway";

      const detail =
        join && !approval
          ? "Canopy waits for active work to finish before stopping your Local gateway. You can then review the data to import."
          : `“${migration.target}” becomes the home for this computer’s Canopy data. The worker keeps running here.`;

      if (!(await confirm(event, message, detail, action))) return;
      authorize(event);
      const device = await migrationDevice(options.directory, runId, true);

      return options.rpc("migration-activate", {
        migrationApproval: approval,
        migrationDevice: deviceRegistration(device),
        migrationSelectedPeers: selectedPeerIds,
      });
    }),
  );
  ipcMain.handle(
    "canopy:migration-recover",
    run(() => options.rpc("migration-recover")),
  );
  ipcMain.handle(
    "canopy:migration-abort",
    run(async (event) => {
      const current = await read();

      if (!status(current).canAbort) throw new Error("This migration can no longer be aborted");

      if (
        !(await confirm(
          event,
          "Cancel this migration?",
          "Canopy checks the destination’s status before resuming Local mode.",
          "Cancel migration",
        ))
      )
        return;
      authorize(event);
      const result = await options.rpc("migration-abort");

      if (status(result).phase === "idle" && current.migrationRunId)
        removeMigrationDevice(options.directory, current.migrationRunId);

      return result;
    }),
  );
}

function status(result: ControllerResult): DesktopMigrationStatus {
  if (!result.migration) throw new Error("Could not read the gateway migration status");

  return result.migration;
}

async function completeSwitch(options: MigrationIpcOptions, result: ControllerResult) {
  const { migrationDestination: target, migrationRunId } = result;

  if (!target || !migrationRunId || status(result).phase !== "switching") return result;
  const device = await migrationDevice(options.directory, migrationRunId, false);

  if (device.id !== target.deviceId) throw new Error("The Desktop credential belongs to a different migration");

  const client = {
    token: device.token,
    deviceId: device.id,
    fingerprint: target.routes.fingerprint,
    addresses: pinnedOrigins(target.routes.addresses),
  };

  const config = { mode: "remote" as const, gatewayUrl: target.profile, workerGatewayUrl: target.profile };
  await saveRemoteClient(options.directory, config, client);
  await options.onSwitch(client);
  const complete = await options.rpc("migration-complete", { remoteClient: client });

  if (status(complete).phase === "completed") removeMigrationDevice(options.directory, migrationRunId);

  return complete;
}

async function confirm(event: IpcMainInvokeEvent, message: string, detail: string, accept: string) {
  const parent = BrowserWindow.fromWebContents(event.sender);

  if (!parent) return false;

  const result = await dialog.showMessageBox(parent, {
    message,
    detail,
    type: "warning",
    buttons: ["Cancel", accept],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  return result.response === 1;
}

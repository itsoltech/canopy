import { createInterface } from "node:readline";
import { DesktopRuntime, type RuntimePaths, type Secrets } from "./runtime/runtime.ts";
import type {
  DesktopMigrationApproval,
  DesktopMigrationStatus,
  DesktopMigrationTarget,
  DesktopStatus,
} from "@canopy/ui/desktop";
import { configuration, type ConfigurationInput } from "./runtime/config.ts";
import type { DesktopClientCredential } from "./remote-client.ts";
import { RemoteDesktopControl } from "./remote-control.ts";
import { LocalDesktopControl, localControlTarget } from "./local-control.ts";
import { toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { DesktopGatewayMigration } from "./runtime/migration-desktop.ts";
import type { MigrationJournal } from "./runtime/migration-state.ts";

export interface ControllerArguments {
  directory?: string;
  paths?: RuntimePaths;
  secrets?: Secrets;
  webToken?: string;
  configuration?: ConfigurationInput;
  state?: string;
  targetVersion?: string | undefined;
  remoteClient?: DesktopClientCredential | undefined;
  draining?: boolean;
  updateState?: string;
  migrationTarget?: DesktopMigrationTarget;
  migrationDevice?: NonNullable<MigrationJournal["device"]>;
  migrationApproval?: DesktopMigrationApproval | undefined;
  migrationSelectedPeers?: readonly string[] | undefined;
}

type ControllerRequest = { id: number } & (
  | { action: "initialize"; directory: string; paths: RuntimePaths; secrets: Secrets; webToken: string }
  | { action: "restore"; remoteClient?: DesktopClientCredential }
  | { action: "configure"; configuration: ConfigurationInput; remoteClient?: DesktopClientCredential }
  | { action: "presence"; state: string; targetVersion?: string }
  | { action: "worker-drain"; draining: boolean }
  | { action: "remote-update-state"; updateState: string }
  | { action: "migration-status" | "migration-recover" | "migration-abort" }
  | { action: "migration-prepare"; migrationTarget: DesktopMigrationTarget }
  | {
      action: "migration-activate";
      migrationDevice: NonNullable<MigrationJournal["device"]>;
      migrationApproval?: DesktopMigrationApproval;
      migrationSelectedPeers?: readonly string[];
    }
  | { action: "migration-complete"; remoteClient: DesktopClientCredential }
);

export interface ControllerResult {
  origin?: string;
  status?: DesktopStatus;
  pids?: number[];
  idle?: boolean;
  migration?: DesktopMigrationStatus;
  migrationRunId?: string | undefined;
  migrationDestination?: { routes: NonNullable<MigrationJournal["routes"]>; profile: string; deviceId: string };
}

export interface ControllerResponse {
  event?: "status" | "remote-update";
  command?: string;
  status?: DesktopStatus;
  id?: number | undefined;
  result?: ControllerResult;
  error?: string;
}

// stdout is a private protocol pipe. Sidecar stdout/stderr only goes to redacted files.
const send = (message: ControllerResponse) => process.stdout.write(JSON.stringify(message) + "\n");
let runtime: DesktopRuntime | undefined;
let ending = false;
let queue = Promise.resolve();
let control: RemoteDesktopControl | LocalDesktopControl | undefined;
let updateState = "";
let migration: DesktopGatewayMigration | undefined;

function connectControl() {
  control?.stop();
  control = undefined;
  const remote = runtime?.remoteControl();
  const current = runtime;
  const status = current?.status;

  const local =
    current && status?.mode === "local" && status.phase === "running" && status.gatewayUrl
      ? localControlTarget(current.directory, () => current.client())
      : undefined;

  const forward = (command: ui.DesktopUpdateCommand) =>
    send({ event: "remote-update", command: toJsonString(ui.DesktopUpdateCommandSchema, command) });

  if (remote) control = new RemoteDesktopControl(remote.client, remote.directory, forward);
  // Local mode: linked computers ask for app updates through this app's own gateway.
  else if (local) control = new LocalDesktopControl(local.client, local.workerId, forward);
  else return;

  if (updateState) void control.report(updateState).catch(() => {});
  void control.run();
}

async function stop() {
  if (ending) return;
  ending = true;
  control?.stop();
  migration?.stop();

  // Bound cleanup even when a startup/enrollment operation has not settled yet.
  const deadline = setTimeout(() => {
    runtime?.killOwned();
    process.exit(1);
  }, 30_000);

  runtime?.cancelStartup();
  await queue.catch(() => {});
  await runtime?.stop();
  clearTimeout(deadline);
  process.exit(0);
}

process.once("exit", () => runtime?.killOwned());

process.once("SIGTERM", () => void stop());

process.once("SIGINT", () => void stop());

const lines = createInterface({ input: process.stdin });

lines.once("close", () => void stop()); // Electron died or closed its pipe: no orphan services.

lines.on("line", (line) => {
  let request: ControllerRequest;

  try {
    // SAFETY: stdin is the private pipe from bundled Electron main, which constructs ControllerRequest.
    request = JSON.parse(line) as ControllerRequest;
  } catch {
    send({ error: "Invalid controller request" });

    return;
  }

  if (request.action === "migration-status" && migration && !ending) {
    try {
      send({ id: request.id, result: migration.status() });
    } catch {
      send({ id: request.id, error: "Could not read the gateway migration record" });
    }

    return;
  }

  // Sleep cannot wait behind enrollment, a download or another queued configuration operation.
  if (request.action === "presence" && runtime && !ending) {
    void runtime
      .presence(request.state, request.targetVersion)
      .then(() => send({ id: request.id, result: {} }))
      .catch(() => send({ id: request.id, error: "Presence announcement did not complete" }));

    return;
  }

  queue = queue.then(async () => {
    let id: number | undefined;

    try {
      id = request.id;

      if (ending) throw new Error("Desktop is stopping");

      if (request.action === "initialize" && !runtime) {
        runtime = new DesktopRuntime(
          request.directory,
          request.paths,
          request.secrets,
          (status) => send({ event: "status", status }),
          undefined,
          request.webToken,
        );
        runtime.hostWebInThisProcess();
        migration = new DesktopGatewayMigration(runtime, request.secrets.secretsKey);
        const origin = await runtime.initialize(false);
        send({ id, result: { origin, status: runtime.status } });
      } else if (request.action === "restore" && runtime) {
        if (migration?.startupHeld()) runtime.holdMigration();
        else await runtime.restore(request.remoteClient);
        connectControl();
        send({ id, result: { status: runtime.status } });
      } else if (request.action === "configure" && runtime) {
        if (migration?.pending()) throw new Error("Finish the gateway migration before changing desktop mode");
        const config = configuration(request.configuration);

        if (!runtime.configurationUnchanged(config, request.remoteClient)) {
          control?.stop();
          await runtime.configure(config, request.remoteClient);
          connectControl();
        }

        send({ id, result: { pids: runtime.pids } });
      } else if (request.action === "presence" && runtime) {
        await runtime.presence(request.state, request.targetVersion);
        send({ id, result: {} });
      } else if (request.action === "worker-drain" && runtime) {
        send({ id, result: { idle: await runtime.drainWorker(request.draining) } });
      } else if (request.action === "remote-update-state") {
        updateState = request.updateState;
        await control?.report(updateState).catch(() => {});
        send({ id, result: {} });
      } else if (migration && request.action === "migration-prepare") {
        send({ id, result: await migration.prepare(request.migrationTarget) });
      } else if (migration && request.action === "migration-activate") {
        control?.stop();
        send({
          id,
          result: await migration.activate(
            request.migrationDevice,
            request.migrationApproval,
            request.migrationSelectedPeers,
          ),
        });
      } else if (migration && request.action === "migration-recover") {
        send({ id, result: await migration.recover() });
      } else if (migration && request.action === "migration-abort") {
        const result = await migration.abort();

        if (result.migration.phase === "idle") connectControl();
        send({ id, result });
      } else if (migration && request.action === "migration-complete") {
        const result = await migration.complete(request.remoteClient);

        if (result.migration.phase === "completed") connectControl();
        send({ id, result });
      } else throw new Error("Invalid desktop controller request");
    } catch (error) {
      send({
        id,
        error:
          runtime?.logs.redact(error instanceof Error ? error.message : "Desktop operation failed") ??
          "Desktop startup failed",
      });
    }
  });
});

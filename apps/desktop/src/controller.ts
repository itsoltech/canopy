import { createInterface } from "node:readline";
import { DesktopRuntime, type RuntimePaths, type Secrets } from "./runtime/runtime.ts";
import type { DesktopStatus } from "@canopy/ui/desktop";
import { configuration, type ConfigurationInput } from "./runtime/config.ts";
import type { DesktopClientCredential } from "./remote-client.ts";
import { RemoteDesktopControl } from "./remote-control.ts";
import { LocalDesktopControl, localControlTarget } from "./local-control.ts";
import { toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export interface ControllerArguments {
  directory?: string;
  paths?: RuntimePaths;
  secrets?: Secrets;
  configuration?: ConfigurationInput;
  state?: string;
  remoteClient?: DesktopClientCredential | undefined;
  draining?: boolean;
  updateState?: string;
}

type ControllerRequest = { id: number } & (
  | { action: "initialize"; directory: string; paths: RuntimePaths; secrets: Secrets }
  | { action: "restore"; remoteClient?: DesktopClientCredential }
  | { action: "configure"; configuration: ConfigurationInput; remoteClient?: DesktopClientCredential }
  | { action: "presence"; state: string }
  | { action: "worker-drain"; draining: boolean }
  | { action: "remote-update-state"; updateState: string }
);

export interface ControllerResult {
  origin?: string;
  status?: DesktopStatus;
  pids?: number[];
  idle?: boolean;
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
  queue = queue.then(async () => {
    let id: number | undefined;

    try {
      // SAFETY: stdin is a private pipe from the bundled Electron main process, which constructs ControllerRequest.
      const request = JSON.parse(line) as ControllerRequest;

      id = request.id;

      if (ending) throw new Error("Desktop is stopping");

      if (request.action === "initialize" && !runtime) {
        runtime = new DesktopRuntime(request.directory, request.paths, request.secrets, (status) =>
          send({ event: "status", status }),
        );
        const origin = await runtime.initialize(false);
        send({ id, result: { origin, status: runtime.status } });
      } else if (request.action === "restore" && runtime) {
        await runtime.restore(request.remoteClient);
        connectControl();
        send({ id, result: { status: runtime.status } });
      } else if (request.action === "configure" && runtime) {
        const config = configuration(request.configuration);

        if (!runtime.configurationUnchanged(config, request.remoteClient)) {
          control?.stop();
          await runtime.configure(config, request.remoteClient);
          connectControl();
        }

        send({ id, result: { pids: runtime.pids } });
      } else if (request.action === "presence" && runtime) {
        await runtime.presence(request.state);
        send({ id, result: {} });
      } else if (request.action === "worker-drain" && runtime) {
        send({ id, result: { idle: await runtime.drainWorker(request.draining) } });
      } else if (request.action === "remote-update-state") {
        updateState = request.updateState;
        await control?.report(updateState).catch(() => {});
        send({ id, result: {} });
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

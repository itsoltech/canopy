import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { type GatewayCore } from "../core/core.ts";
import { workerGuard } from "../core/worker-administration.ts";
import { workerInstall } from "../updates/install.ts";
import { updatesSnapshot } from "../updates/center-composition.ts";
import { guard } from "./ui-errors.ts";
import { linkedUpdates, requestComputerUpdate } from "../updates/linked.ts";
import { mobileIdentity } from "../core/mobile-devices.ts";

/** The app control channel belongs to the desktop app's own bundled gateway and its service token, never a device. */
function localAppOnly(core: GatewayCore, context: HandlerContext) {
  if (core.role !== "desktop" || context.values.get(mobileIdentity))
    throw new ConnectError("Only the Canopy app on this computer can open its control channel", Code.PermissionDenied);
}

import type { UiHandlers } from "./ui-service.ts";

export function workersHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "fetchWorkerInstall"
  | "workerSsh"
  | "getUpdates"
  | "manageUpdates"
  | "getWorkerSetup"
  | "createWorkerEnrollment"
  | "revokeWorkerEnrollment"
  | "renameWorker"
  | "rotateWorkerCredential"
  | "revokeWorker"
  | "archiveWorker"
  | "installCli"
  | "checkCliUpdates"
  | "setWorkerCliUpdateSettings"
  | "watchAppControl"
  | "reportAppControl"
> {
  const snapshot = async () => {
    const value = await updatesSnapshot(core);
    value.run = await core.updateCenter.status(value);

    return value;
  };

  return {
    workerSsh: (request, context) => core.workerSsh.run(request, context.signal),
    fetchWorkerInstall: (request, context) => workerInstall(core.updates, request, context.signal),

    getUpdates: snapshot,

    manageUpdates: async (request) => {
      if (request.action === "update_all") {
        await core.updateCenter.begin();

        return snapshot();
      }

      // One linked computer's app checks its own feed; it installs nothing, so Update all may be running.
      if (request.action === "computer_check") {
        await requestComputerUpdate(core, request.nodeId, "check");

        return snapshot();
      }

      if (request.action !== "check" && (await core.updateCenter.status())?.state === "running")
        throw new ConnectError(
          "Update all is running. Wait for it to finish before starting another update.",
          Code.FailedPrecondition,
        );

      if (request.action === "desktop") {
        await core.desktopControl.manage(request);

        return snapshot();
      }

      if (request.action === "computer") {
        await requestComputerUpdate(core, request.nodeId, "app");

        return snapshot();
      }

      // Linked computers' apps check their own feeds too; one that doesn't answer is left out.
      const linked =
        request.action === "check"
          ? linkedUpdates(core).then((computers) =>
              Promise.allSettled(
                computers.filter((c) => c.updates).map((c) => requestComputerUpdate(core, c.nodeId, "check")),
              ),
            )
          : undefined;

      try {
        await core.updates.manage(request);
      } finally {
        await linked;
      }

      return snapshot();
    },

    watchAppControl: (hello, context) => {
      localAppOnly(core, context);

      return core.appControl.watch(hello, context.signal);
    },
    reportAppControl: async (report, context) => {
      localAppOnly(core, context);
      await core.appControl.report(report);

      return create(ui.DesktopAckSchema);
    },

    getWorkerSetup: () =>
      workerGuard(async () => {
        const setup = await core.workers.setup();
        const updates = await core.updates.snapshot();
        setup.gatewayVersion = updates.gatewayVersion;
        setup.channel = updates.channel;

        return setup;
      }),

    createWorkerEnrollment: (r) => workerGuard(() => core.workers.create(r.name, r.tags)),

    revokeWorkerEnrollment: (r) =>
      workerGuard(async () => {
        await core.workers.revokeEnrollment(r.id);

        return create(ui.WorkerOperationResponseSchema);
      }),

    renameWorker: (r) =>
      workerGuard(async () => {
        await core.workers.manage(r.workerId, "rename", r.name);

        return create(ui.WorkerOperationResponseSchema);
      }),

    rotateWorkerCredential: (r) =>
      workerGuard(async () =>
        create(ui.RotateWorkerCredentialResponseSchema, {
          credential: await core.workers.manage(r.workerId, "rotate"),
        }),
      ),

    revokeWorker: (r) =>
      workerGuard(async () => {
        await core.workers.manage(r.workerId, "revoke");

        return create(ui.WorkerOperationResponseSchema);
      }),

    archiveWorker: (r) =>
      workerGuard(async () => {
        await core.workers.manage(r.workerId, "archive");

        return create(ui.WorkerOperationResponseSchema);
      }),

    installCli: (request) => guard(() => core.installCli(request)),

    checkCliUpdates: (request) => guard(() => core.checkCliUpdates(request)),
    setWorkerCliUpdateSettings: (request) =>
      guard(async () => {
        await core.setWorkerCliUpdateSettings(request);

        return create(ui.WorkerOperationResponseSchema);
      }),
  };
}

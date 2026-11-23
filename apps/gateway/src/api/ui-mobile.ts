import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { coreState } from "../core/core-context.ts";
import { type GatewayCore } from "../core/core.ts";
import { mobileGuard, mobileIdentity } from "../core/mobile-devices.ts";
import type { UiHandlers } from "./ui-service.ts";
import { serviceIdentity } from "./auth.ts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { DESKTOP_CLIENT_PROTOCOL, MIN_DESKTOP_CLIENT_PROTOCOL } from "@canopy/domain/release/protocol";

function ownerDevice(core: GatewayCore, context: HandlerContext) {
  const identity = context.values.get(mobileIdentity);

  return identity?.userId === core[coreState].options.userId ? identity : undefined;
}

function phoneIdentity(core: GatewayCore, context: HandlerContext) {
  const identity = ownerDevice(core, context);

  return identity?.clientKind === "mobile" ? identity : undefined;
}

function pairedPhone(core: GatewayCore, context: HandlerContext) {
  const identity = phoneIdentity(core, context);

  if (!identity) throw new ConnectError("Mobile device token required", Code.Unauthenticated);

  return identity.deviceId;
}

const mayConfigurePushRelay = (core: GatewayCore, context: HandlerContext) =>
  core.mobilePush.settingsEditable &&
  (context.values.get(serviceIdentity) || ownerDevice(core, context)?.clientKind === "desktop");

async function pushRelayGuard<A>(core: GatewayCore, context: HandlerContext, run: () => A | Promise<A>) {
  if (!mayConfigurePushRelay(core, context))
    throw new ConnectError("Push relay settings require gateway administration access", Code.PermissionDenied);

  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("Could not access push relay settings. Try again.", Code.FailedPrecondition);
  }
}

export function mobileHandlers(
  core: GatewayCore,
): Pick<
  UiHandlers,
  | "getMobileDevices"
  | "createMobilePairing"
  | "createDesktopPairing"
  | "getClientCapabilities"
  | "revokeMobilePairing"
  | "revokeMobileDevice"
  | "unpairMobileDevice"
  | "setMobilePushSubscription"
  | "beginManagedMobilePush"
  | "completeManagedMobilePush"
  | "resolveMobilePush"
  | "getPushRelaySettings"
  | "updatePushRelaySettings"
> {
  return {
    getClientCapabilities: async (_request, context) =>
      create(ui.ClientCapabilitiesSchema, {
        gatewayVersion: CANOPY_VERSION,
        gatewayRole: core.role,
        linkedComputers: core.role === "desktop",
        offerOnboarding: core.offerOnboarding,
        archiveWorkerFilter: true,
        mobilePush: core.mobilePush.manualAvailable && !!phoneIdentity(core, context),
        managedMobilePush: core.mobilePush.managedAvailable && !!phoneIdentity(core, context),
        localPushRelaySettings:
          core.role === "desktop" && core.mobilePush.settingsEditable && context.values.get(serviceIdentity),
        pushRelaySettings: mayConfigurePushRelay(core, context),
        // The identity's name only: a full computers snapshot (routes, peers, notices) is not needed here.
        gatewayName: core.computers?.hello().name || "your gateway",
        minProtocol: MIN_DESKTOP_CLIENT_PROTOCOL,
        maxProtocol: DESKTOP_CLIENT_PROTOCOL,
        methods: ui.GatewayService.methods.map((method) => method.name),
        routes: core.mobile.networkRoutes(),
      }),

    createDesktopPairing: () => mobileGuard(() => core.mobile.create("desktop")),
    getMobileDevices: () => mobileGuard(() => core.mobile.list()),

    createMobilePairing: () => mobileGuard(() => core.mobile.create()),
    getPushRelaySettings: (_request, context) => pushRelayGuard(core, context, () => core.mobilePush.relaySettings()),
    updatePushRelaySettings: (request, context) =>
      pushRelayGuard(core, context, () => core.mobilePush.updateRelaySettings(request)),
    setMobilePushSubscription: (request, context) =>
      mobileGuard(() => core.mobilePush.subscribe(pairedPhone(core, context), request)),
    beginManagedMobilePush: (request, context) =>
      mobileGuard(() => core.mobilePush.beginManaged(pairedPhone(core, context), request, context.signal)),
    completeManagedMobilePush: (request, context) =>
      mobileGuard(() => core.mobilePush.completeManaged(pairedPhone(core, context), request, context.signal)),
    resolveMobilePush: (request, context) =>
      mobileGuard(() => core.mobilePush.resolve(pairedPhone(core, context), request.receiptId)),

    revokeMobilePairing: (r) =>
      mobileGuard(async () => {
        await core.mobile.revoke(r.id, "pairing");

        return create(ui.MobileOperationResponseSchema);
      }),

    revokeMobileDevice: (r) =>
      mobileGuard(async () => {
        await core.mobile.revoke(r.id, "device");

        return create(ui.MobileOperationResponseSchema);
      }),

    unpairMobileDevice: (_r, context) =>
      mobileGuard(async () => {
        const identity = context.values.get(mobileIdentity);

        if (!identity) throw new ConnectError("Device token required", Code.Unauthenticated);
        await core.mobile.revoke(identity.deviceId, "device");

        return create(ui.MobileOperationResponseSchema);
      }),
  };
}

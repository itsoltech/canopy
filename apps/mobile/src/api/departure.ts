import { create, equals, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { plannedGatewayDeparture } from "@canopy/domain/computer-presence";
import { reachedUpdateVersion } from "@canopy/domain/release/remote-update-state";
import { gatewayUpdateLifecycle } from "@canopy/domain/release/update-status";

export function plannedDeparture(value: ui.GatewayDeparture | undefined, now = Date.now()) {
  return plannedGatewayDeparture(value, now);
}

const pendingDeparture = (value: ui.GatewayDeparture) => ["updating", "restarting"].includes(value.state);

/** One connected gateway only: peer announcements must never pin this phone's route. */
export class MobileDeparture {
  private value: ui.GatewayDeparture | undefined;
  private resultUntil = 0;
  private listeners = new Set<() => void>();
  constructor(
    saved: string | undefined,
    readonly changed: () => void,
  ) {
    try {
      const value = saved ? fromJsonString(ui.GatewayDepartureSchema, saved, { ignoreUnknownFields: true }) : undefined;

      if (plannedDeparture(value)) this.value = value;
    } catch {
      /* A damaged optional checkpoint does not invalidate the device pairing. */
    }
  }
  snapshot = () => this.value;
  resultDeadline() {
    return this.resultUntil;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };
  serialized() {
    return this.value ? toJsonString(ui.GatewayDepartureSchema, this.value) : undefined;
  }
  reconcile(snapshot: ui.UpdatesSnapshot, observed: ui.GatewayDeparture | undefined) {
    const { departure, gatewayState, gatewayVersion } = snapshot;
    const previous = this.value;
    const transitioning = gatewayUpdateLifecycle(gatewayState);

    if (departure) {
      // A binary gateway marks a same-version handover as restarting before announcing it.
      // A ready read started after the announcement can retire its checkpoint without a version change.
      const handoverEnded =
        departure.state === "restarting" &&
        !departure.targetVersion &&
        snapshot.gatewayInstallKind === "binary" &&
        !snapshot.gatewayBundled &&
        previous === observed &&
        observed?.state === "restarting" &&
        observed.id === departure.id &&
        (gatewayState === "idle" || gatewayState === "succeeded");

      if (handoverEnded) {
        this.receive(create(ui.GatewayDepartureSchema, { ...departure, state: "dismissed", reason: "" }));

        return;
      }

      // An unchanged version above the target may still be about to perform an explicit downgrade.
      const installed =
        reachedUpdateVersion(gatewayVersion, departure.targetVersion) &&
        (gatewayVersion !== departure.version || gatewayVersion === departure.targetVersion);

      this.apply(departure, !transitioning && installed ? gatewayVersion : "");

      return;
    }

    if (transitioning || !previous || previous !== observed || !plannedDeparture(previous)) return;
    const succeeded = !previous.targetVersion || reachedUpdateVersion(gatewayVersion, previous.targetVersion);
    this.receive(
      create(ui.GatewayDepartureSchema, {
        ...previous,
        version: gatewayVersion,
        state: succeeded ? "succeeded" : "failed",
        reason: succeeded ? "" : "The computer returned without the requested update. Open Updates to retry.",
      }),
    );
  }
  receive(value: ui.GatewayDeparture) {
    this.apply(value);
  }

  private apply(value: ui.GatewayDeparture, confirmedVersion = "") {
    if (value.nodeId || !value.id) return;
    const previous = this.value;
    const pending = pendingDeparture(value);

    // A read started before recovery must not restore the outage after its terminal stream event.
    if (
      previous &&
      (previous.id !== value.id ? value.startedAtMs < previous.startedAtMs : pending && !pendingDeparture(previous))
    )
      return;

    if (!pending && previous?.id !== value.id) return;

    const completed = pending && Boolean(confirmedVersion);
    const now = Date.now();

    if (pending && !completed && !plannedDeparture(value, now)) return;

    const next = completed
      ? create(ui.GatewayDepartureSchema, { ...value, version: confirmedVersion, state: "succeeded", reason: "" })
      : value;

    if (previous && equals(ui.GatewayDepartureSchema, previous, next)) return;

    if (previous?.id !== next.id || previous.state !== next.state)
      this.resultUntil =
        previous?.id === next.id && ["succeeded", "failed", "rolled_back"].includes(next.state) ? now + 15_000 : 0;

    this.value = next;
    this.changed();

    for (const listener of this.listeners) listener();
  }
}

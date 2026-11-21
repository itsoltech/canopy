import { create, equals, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { plannedGatewayDeparture } from "@canopy/domain/computer-presence";
import { reachedUpdateVersion } from "@canopy/domain/release/remote-update-state";

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
    if (snapshot.departure) {
      this.receive(snapshot.departure, snapshot.gatewayVersion);

      return;
    }

    const previous = this.value;

    if (!previous || previous !== observed || !plannedDeparture(previous)) return;
    const succeeded = !previous.targetVersion || reachedUpdateVersion(snapshot.gatewayVersion, previous.targetVersion);
    this.receive(
      create(ui.GatewayDepartureSchema, {
        ...previous,
        version: snapshot.gatewayVersion,
        state: succeeded ? "succeeded" : "failed",
        reason: succeeded ? "" : "The computer returned without the requested update. Open Updates to retry.",
      }),
    );
  }
  receive(value: ui.GatewayDeparture, gatewayVersion = "") {
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

    // The running version can be newer than the checkpoint while startup is still reconciling it.
    // An unchanged version above the target may still be about to perform an explicit downgrade.
    const installed =
      pending &&
      reachedUpdateVersion(gatewayVersion, value.targetVersion) &&
      (gatewayVersion !== value.version || gatewayVersion === value.targetVersion);

    const now = Date.now();

    if (pending && !installed && !plannedDeparture(value, now)) return;

    const next = installed
      ? create(ui.GatewayDepartureSchema, { ...value, version: gatewayVersion, state: "succeeded", reason: "" })
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

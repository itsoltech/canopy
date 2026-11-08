import { create, equals, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { DEPARTURE_WINDOW_MS } from "@canopy/domain/computer-presence";

export function plannedDeparture(value: ui.GatewayDeparture | undefined, now = Date.now()) {
  return (
    !!value &&
    ["updating", "restarting"].includes(value.state) &&
    Number(value.startedAtMs) <= now &&
    now < Number(value.startedAtMs) + Math.min(value.windowMs, DEPARTURE_WINDOW_MS)
  );
}

/** One connected gateway only: peer announcements must never pin this phone's route. */
export class MobileDeparture {
  private value: ui.GatewayDeparture | undefined;
  private listeners = new Set<() => void>();
  constructor(
    saved: string | undefined,
    readonly changed: () => void,
  ) {
    try {
      const value = saved ? fromJsonString(ui.GatewayDepartureSchema, saved) : undefined;

      if (plannedDeparture(value)) this.value = value;
    } catch {
      /* A damaged optional checkpoint does not invalidate the device pairing. */
    }
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };
  serialized() {
    return this.value ? toJsonString(ui.GatewayDepartureSchema, this.value) : undefined;
  }
  reconcile(snapshot: ui.UpdatesSnapshot) {
    if (snapshot.departure) {
      this.receive(snapshot.departure);

      return;
    }

    const previous = this.value;

    if (!previous || !plannedDeparture(previous)) return;
    const succeeded = !previous.targetVersion || previous.targetVersion === snapshot.gatewayVersion;
    this.receive(
      create(ui.GatewayDepartureSchema, {
        ...previous,
        version: snapshot.gatewayVersion,
        state: succeeded ? "succeeded" : "failed",
        reason: succeeded ? "" : "The computer returned without the requested update. Open Updates to retry.",
      }),
    );
  }
  receive(value: ui.GatewayDeparture) {
    if (value.nodeId || !value.id) return;

    if (!["updating", "restarting"].includes(value.state) && this.value?.id !== value.id) return;

    if (this.value && equals(ui.GatewayDepartureSchema, this.value, value)) return;
    this.value = value;
    this.changed();

    for (const listener of this.listeners) listener();
  }
}

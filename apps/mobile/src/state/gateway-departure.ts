import { useEffect, useState, useSyncExternalStore } from "react";
import type { ui } from "@canopy/contracts";
import { DEPARTURE_WINDOW_MS } from "@canopy/domain/computer-presence";
import { plannedDeparture } from "../api/departure";
import { useSession } from "./session";

const empty = () => undefined;
const subscribeEmpty = () => () => {};

export function useGatewayDeparture() {
  const { client } = useSession();

  const value = useSyncExternalStore(
    client?.departure.subscribe ?? subscribeEmpty,
    client?.departure.snapshot ?? empty,
  );

  const [now, setNow] = useState(Date.now());
  const [received, setReceived] = useState<{ id: string; state: string; until: number }>();
  useEffect(() => {
    if (!value) return;
    setNow(Date.now());
    setReceived({ id: value.id, state: value.state, until: Date.now() + 15_000 });

    const until = plannedDeparture(value)
      ? Number(value.startedAtMs) + Math.min(value.windowMs, DEPARTURE_WINDOW_MS)
      : Date.now() + 15_000;

    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()));

    return () => clearTimeout(timer);
  }, [value]);
  const planned = plannedDeparture(value, now);

  const visible =
    planned ||
    (value &&
      received?.id === value.id &&
      received.state === value.state &&
      now < received.until &&
      ["succeeded", "failed", "rolled_back"].includes(value.state));

  return { value, planned, visible: !!visible };
}

export function departureLabel(value: ui.GatewayDeparture, disconnected = false) {
  if (value.state === "succeeded") return value.targetVersion ? `Updated to ${value.version}` : "Canopy restarted";

  if (value.state === "rolled_back") return "Canopy rolled back";

  if (value.state === "failed") return "Canopy update failed";

  if (value.state === "restarting" || disconnected) return `Restarting Canopy on ${value.name || "your computer"}…`;

  return value.targetVersion
    ? `Updating Canopy on ${value.name || "your computer"} to ${value.targetVersion}…`
    : `Updating Canopy on ${value.name || "your computer"}…`;
}

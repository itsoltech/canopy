import { useEffect, useState, useSyncExternalStore } from "react";
import type { ui } from "@canopy/contracts";
import { DEPARTURE_WINDOW_MS } from "@canopy/domain/computer-presence";
import { plannedDeparture } from "../api/departure";
import { useSession } from "./session";

const empty = () => undefined;
const subscribeEmpty = () => () => {};

export function useGatewayDeparture() {
  const { active, client } = useSession();

  const value = useSyncExternalStore(
    client?.departure.subscribe ?? subscribeEmpty,
    client?.departure.snapshot ?? empty,
  );

  const [, refresh] = useState(0);
  const now = Date.now();
  const planned = plannedDeparture(value, now);
  const resultUntil = client?.departure.resultDeadline() ?? 0;
  const visible = planned || now < resultUntil;

  const until =
    planned && value ? Number(value.startedAtMs) + Math.min(value.windowMs, DEPARTURE_WINDOW_MS) : resultUntil;

  useEffect(() => {
    if (!active || !visible) return;
    let timer: ReturnType<typeof setTimeout>;

    const expire = () => {
      const remaining = until - Date.now();

      if (remaining > 0) timer = setTimeout(expire, remaining);
      else refresh((n) => n + 1);
    };

    timer = setTimeout(expire, Math.max(0, until - Date.now()));

    return () => clearTimeout(timer);
  }, [active, until, visible]);

  return { value, planned, visible };
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

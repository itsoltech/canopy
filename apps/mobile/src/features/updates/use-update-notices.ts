import { useEffect, useRef, useState } from "react";
import { workerUpdateSignature } from "@canopy/domain/update-checks";
import { useOverviewEvents } from "../../state/overview-bus";

const UPDATE_EVENTS = new Set([
  "updatesChanged",
  "desktopUpdate",
  "gatewayDeparture",
  "computer",
  "workerRemoved",
  "feeds",
]);

/** Merge update notices; worker heartbeats only reload when update-relevant fields change. */
export function useUpdateNotices(active: boolean, online: boolean) {
  const [pushed, setPushed] = useState(false);
  const [nudge, setNudge] = useState(0);
  const workers = useRef(new Map<string, string>());

  useOverviewEvents((update) => {
    const change = update.change;

    if (change.case === "feeds") setPushed(change.value.pushed.includes("updates"));

    if (change.case === "worker") {
      const signature = workerUpdateSignature(change.value);
      const previous = workers.current.get(change.value.id);
      workers.current.set(change.value.id, signature);

      if (previous === undefined || previous === signature) return;
    } else if (
      !UPDATE_EVENTS.has(change.case ?? "") &&
      !(change.case === "linkedReadCompleted" && change.value === "GetComputerUpdates")
    )
      return;

    setNudge((n) => n + 1);
  });

  useEffect(() => {
    if (!active || !online) setPushed(false);
  }, [active, online]);

  return { pushed, nudge };
}

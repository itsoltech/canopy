import { useEffect, useEffectEvent, useMemo } from "react";
import type { ui } from "@canopy/contracts";
import { ThreadWatchLiveness } from "@canopy/domain/thread-watch-liveness";
import { useOverviewStream, useOverviewThreadHead } from "./overview-bus";
import { useSession } from "./session";
import { mobileMeasurements } from "../features/settings/client-diagnostics";
import type { Connection } from "./stream";

/** Only the mounted, foreground view may repair its watch; retained/warm snapshots never supply its cursor. */
export function useThreadLiveness(
  id: string,
  read: () => ui.ThreadSyncCursor | undefined,
  connection: Connection,
  resume: () => void,
) {
  const { active, online, client } = useSession();
  const overview = useOverviewStream();
  const guard = useMemo(() => new ThreadWatchLiveness(), [id, client]);
  const head = useOverviewThreadHead();

  const check = useEffectEvent(() => {
    if (!active || !online || overview.connection !== "live" || connection === "error") {
      guard.pause();

      return;
    }

    const repair = guard.check(read(), head(id));

    if (!repair) return;
    mobileMeasurements.record(16, 1);
    console.warn("Thread watch resumed from applied cursor", repair);
    resume();
  });

  useEffect(() => {
    if (!active || !online) {
      guard.pause();

      return;
    }

    const timer = setInterval(check, 1000);

    return () => clearInterval(timer);
  }, [guard, active, online]);
}

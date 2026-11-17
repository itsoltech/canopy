import { useEffect, useMemo } from "react";
import type { Client } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import type { MobileDrafts } from "../drafts/manager";
import { MobileThreadCreations } from "./thread-creations";

export function useThreadCreations(
  api: Client<typeof ui.GatewayService> | undefined,
  drafts: MobileDrafts | null,
  active: boolean,
  epoch: number,
) {
  const creations = useMemo(() => (api && drafts ? new MobileThreadCreations(api, drafts) : null), [api, drafts]);
  useEffect(() => () => creations?.dispose(), [creations]);
  useEffect(() => {
    if (active) creations?.reconnect();
  }, [creations, active, epoch]);

  return creations;
}

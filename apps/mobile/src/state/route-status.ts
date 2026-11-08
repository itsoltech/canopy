import { useSyncExternalStore } from "react";
import { type RouteSnapshot } from "../api/route-diagnostics";
import { useSession } from "./session";

const empty: RouteSnapshot = { routes: [], pending: false };
const snapshot = () => empty;
const subscribe = () => () => {};

export function useRouteStatus() {
  const { client } = useSession();

  return useSyncExternalStore(client?.diagnostics.subscribe ?? subscribe, client?.diagnostics.snapshot ?? snapshot);
}

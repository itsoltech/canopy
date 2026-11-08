import type { RouteSnapshot } from "./route-diagnostics";

/** A failed race suggests checking the phone's tunnel, but cannot prove the computer is healthy. */
export function hasTailscaleFailure(snapshot: RouteSnapshot) {
  const routes = snapshot.lastRace;

  if (snapshot.active || !routes?.length) return false;
  const tailscale = routes.filter((route) => route.kind === "Tailscale");

  return (
    tailscale.length > 0 &&
    routes.every(
      (route) => route.phase === "probe" && ["dns", "timeout", "pin", "refused", "failed"].includes(route.outcome),
    ) &&
    tailscale.every((route) => route.outcome === "dns" || route.outcome === "timeout")
  );
}

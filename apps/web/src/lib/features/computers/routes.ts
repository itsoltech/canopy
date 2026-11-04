import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "#lib/shared/format.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";
import type { IconName } from "#lib/shared/ui/icons.ts";

/** Where a route to a linked computer came from (docs/linked-computers.md, stage 6). */
export const ROUTE_SOURCES = new Map<string, { label: string; tone: Tone; icon?: IconName }>([
  ["manual", { label: "Added by you", tone: "neutral" }],
  ["lan", { label: "Local network", tone: "sky", icon: "signal" }],
  ["announced", { label: "Announced", tone: "neutral" }],
]);

const since = (ms: bigint, now: number) => formatRelative(timestampFromMs(Number(ms)), now);

export interface RouteStatus {
  text: string;
  failing: boolean;
}

/** "Worked 3 minutes ago · 4 ms", "Failed just now · last worked 2 days ago", "Not tried yet". */
export function routeStatus(route: ui.ComputerRoute, now = Date.now()): RouteStatus {
  const failing = route.lastFailureMs > route.lastSuccessMs;

  if (failing)
    return {
      failing,
      text: `Failed ${since(route.lastFailureMs, now)}${route.lastSuccessMs ? ` · last worked ${since(route.lastSuccessMs, now)}` : ""}`,
    };

  if (route.lastSuccessMs)
    return {
      failing,
      text: `Worked ${since(route.lastSuccessMs, now)}${route.latencyMs ? ` · ${route.latencyMs} ms` : ""}`,
    };

  return { failing, text: "Not tried yet" };
}

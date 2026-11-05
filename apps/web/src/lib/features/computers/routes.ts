import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "#lib/shared/format.ts";
import type { Tone } from "#lib/shared/ui/tone.ts";
import type { IconName } from "#lib/shared/ui/icons.ts";

/** Where a route to a linked computer came from (docs/linked-computers.md, stage 6). */
const ROUTE_SOURCES = new Map<string, { label: string; tone: Tone; icon?: IconName }>([
  ["manual", { label: "Added by you", tone: "neutral" }],
  ["lan", { label: "Local network", tone: "sky", icon: "signal" }],
  ["announced", { label: "Announced", tone: "neutral" }],
]);

const since = (ms: bigint, now: number) => formatRelative(timestampFromMs(Number(ms)), now);

export interface RouteStatus {
  text: string;
  /** Amber: only while the link is down, for a route the partner still announces. */
  warn: boolean;
}

/** The source badge: an announced address the partner no longer announces is an old address. */
export const routeSource = (route: ui.ComputerRoute) =>
  route.withdrawnAtMs
    ? { label: "Old address", tone: "neutral" as const }
    : (ROUTE_SOURCES.get(route.source) ?? { label: route.source, tone: "neutral" as const });

/**
 * "In use · 4 ms", "Worked 3 minutes ago · 4 ms", "Failed just now · last worked 2 days ago", "Not tried yet".
 * While the link is connected (in either direction), a failed route is not a problem: "Not needed while connected".
 */
export function routeStatus(route: ui.ComputerRoute, connected: boolean, now = Date.now()): RouteStatus {
  const latency = route.latencyMs ? ` · ${route.latencyMs} ms` : "";

  if (route.inUse) return { warn: false, text: `In use${latency}` };

  if (route.lastFailureMs > route.lastSuccessMs) {
    if (connected)
      return { warn: false, text: `Not needed while connected · failed ${since(route.lastFailureMs, now)}` };

    return {
      warn: !route.withdrawnAtMs,
      text: `Failed ${since(route.lastFailureMs, now)}${route.lastSuccessMs ? ` · last worked ${since(route.lastSuccessMs, now)}` : ""}`,
    };
  }

  if (route.lastSuccessMs) return { warn: false, text: `Worked ${since(route.lastSuccessMs, now)}${latency}` };

  return { warn: false, text: "Not tried yet" };
}

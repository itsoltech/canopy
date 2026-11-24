import { goto } from "$app/navigation";
import { untrack } from "svelte";
import type { GatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { queries, SharedRead } from "#lib/shared/queries.svelte.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { getMemoryHabits } from "./habits-api.ts";

export const memorySettingsPath = "/settings/memory";
export const habitsTopicHash = "#topic-habits";
export const habitsSettingsHref = memorySettingsPath + habitsTopicHash;
export const habitRead = new SharedRead(queries, "GetMemoryHabits", getMemoryHabits);

export const supportsHabits = (capabilities: GatewayCapabilities | undefined) =>
  (capabilities?.supports(memorySettingsPath) ?? true) && capabilities?.methods?.includes(habitRead.key) !== false;

export const pendingHabitCount = (overview: OverviewState, capabilities: GatewayCapabilities | undefined) =>
  overview.resyncs > 0 && supportsHabits(capabilities) ? (habitRead.data?.suggestions.length ?? 0) : 0;

/** Reopening Memory also refreshes fields that can change without a habits event, such as model options. */
export function readHabitsOnEntry(signal: AbortSignal) {
  return queries.read(habitRead.key, getMemoryHabits, 15_000, signal);
}

export function followHabitSuggestions(overview: OverviewState, enabled: () => boolean, currentPath: () => string) {
  let known: ReadonlySet<string> | undefined;
  let synced = 0;

  $effect(() =>
    overview.subscribe(({ change }) => {
      if (change.case === "memoryHabitsChanged" && change.value) queries.invalidate(habitRead.key);
    }),
  );

  $effect(() => {
    const resyncs = overview.resyncs;

    if (!resyncs || !enabled()) {
      known = undefined;

      return;
    }

    const connection = overview.connection;

    if (resyncs !== synced) {
      // A direct visit to Memory may have read before the stream opened. Later gaps invalidate in the shell.
      if (resyncs === 1) untrack(() => queries.invalidate(habitRead.key));
      known = undefined;
      synced = resyncs;
    }

    const { data, stale, loading, error } = habitRead.snapshot;

    if (connection !== "live") {
      known = undefined;

      return;
    }

    if (stale || loading || error || data === undefined) return;
    const keys = data?.suggestions.map((item) => `${item.id}:${item.suspended}`) ?? [];
    const previous = known;
    known = new Set(keys);

    if (!previous) return;
    const added = keys.filter((key) => !previous.has(key)).length;

    if (added) untrack(() => notify(added, currentPath()));
  });
}

function notify(added: number, pathname: string) {
  if (
    pathname === memorySettingsPath ||
    pathname.startsWith(`${memorySettingsPath}/`) ||
    document.hidden ||
    !document.hasFocus() ||
    devicePreferences.values.inAppNotifications !== "on"
  )
    return;

  toast(added === 1 ? "New habit suggestion" : "New habit suggestions", {
    tone: "info",
    action: { label: "Review habits", run: () => void goto(habitsSettingsHref) },
  });
}

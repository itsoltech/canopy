<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { ROUTE_SOURCES, routeStatus } from "./routes.ts";

  /** One way to reach a linked computer: its address, where it came from and how it last went. */
  let {
    route,
    now,
    busy = false,
    onremove,
    class: className,
  }: { route: ui.ComputerRoute; now: number; busy?: boolean; onremove: () => void; class?: ClassValue } = $props();

  const source = $derived(ROUTE_SOURCES.get(route.source) ?? { label: route.source, tone: "neutral" as const });
  const status = $derived(routeStatus(route, now));
</script>

<li class={["flex items-start gap-3 px-4 py-3", className]}>
  <div class="grid min-w-0 flex-1 gap-1">
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <p class="min-w-0 font-mono text-base/6 break-all text-zinc-950 sm:text-sm/6 dark:text-white">{route.address}</p>
      <Badge tone={source.tone} icon={source.icon} compact>{source.label}</Badge>
    </div>
    <p
      class={[
        "text-base/6 tabular-nums sm:text-sm/6",
        status.failing ? "text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400",
      ]}
    >
      {status.text}
    </p>
  </div>
  <IconButton icon="trash" label={`Remove route ${route.address}`} size="sm" disabled={busy} onclick={onremove} />
</li>

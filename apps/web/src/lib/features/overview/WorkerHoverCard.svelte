<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { instanceLabel } from "#lib/features/threads/providers.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatRelative } from "#lib/shared/format.ts";
  import HoverCard from "#lib/shared/ui/HoverCard.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { osLabel, providerSummary } from "./workers.ts";
  import { workerLabel } from "./worker-label.ts";
  import HintIcon from "#lib/shared/ui/HintIcon.svelte";

  /**
   * A worker's name that previews it on hover, focus or tap: online state, host and system, agent CLIs
   * and providers. The same facts are in Settings → Workers.
   */
  let {
    worker,
    note,
    class: className,
  }: { worker: ui.Worker | undefined; note?: string | undefined; class?: ClassValue } = $props();
</script>

<div class={["flex min-w-0 items-center", className]}>
  {#if worker}
    <HoverCard label="Worker {worker.name}">
      {#snippet trigger(props)}
        <button
          type="button"
          title={worker.name}
          {...props}
          class={[
            "flex max-w-full min-w-0 items-center gap-1.5 rounded-md focus-ring hover:text-zinc-950 dark:hover:text-white",
          ]}
        >
          <Icon name="computer-desktop" class="size-3.5" />
          <span class="truncate">{workerLabel(worker.name)}</span>
          {#if !worker.online}<StatusDot tone="neutral" />{/if}
        </button>
      {/snippet}
      <div class="grid gap-2 text-sm/5 [overflow-wrap:anywhere] text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
        <p class="flex items-center gap-2 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
          <StatusDot tone={worker.online ? "emerald" : "neutral"} />{worker.name}
        </p>
        <p>
          {worker.online
            ? "Online"
            : `Offline${worker.lastSeenAt ? `, seen ${formatRelative(worker.lastSeenAt, clock.now)}` : ""}`} · {osLabel(
            worker.os,
          )}{worker.hostname ? ` · ${worker.hostname}` : ""}
        </p>
        <ul role="list" class="grid gap-0.5">
          {#each worker.providers as provider (provider.provider)}<li>{providerSummary(provider)}</li>{/each}
        </ul>
        {#if worker.providerInstances.some((i) => i.enabled && i.available)}
          <p>
            Providers: {worker.providerInstances
              .filter((i) => i.enabled && i.available)
              .map(instanceLabel)
              .join(", ")}
          </p>
        {/if}
      </div>
    </HoverCard>
  {:else}
    <span class="flex min-w-0 items-center gap-1.5"
      ><Icon name="computer-desktop" class="size-3.5" /><span class="truncate">Unknown worker</span></span
    >
  {/if}
  {#if note}<HintIcon label="Thread availability" text={note} warning />{/if}
</div>

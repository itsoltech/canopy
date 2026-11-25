<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Select from "#lib/shared/ui/Select.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { workerRecords } from "#lib/features/workers/worker-records.svelte.ts";

  /**
   * Where the Providers page applies changes: all workers (the global definition, and
   * which workers run an instance) or one worker (on/off there, its overrides, its status). Workers show name and
   * host, else a short id.
   */
  let {
    workers,
    scope = $bindable(),
    class: className,
  }: { workers: readonly ui.Worker[]; scope: string | undefined; class?: ClassValue } = $props();

  const selected = $derived(workers.find((w) => w.id === scope));
  const records = workerRecords(useOverview());
  const capabilities = useGatewayCapabilities();
</script>

<div
  class={["flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-950/5 pb-3 dark:border-white/8", className]}
>
  <label for="provider-scope" class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400"
    >Applying settings on</label
  >
  <Select
    id="provider-scope"
    name="provider-scope"
    bind:value={() => scope ?? "", (next: string) => (scope = next || undefined)}
    class="min-w-0 flex-1 basis-40 sm:max-w-56"
    options={[{ value: "", label: "All workers" }, ...records.options(workers)]}
  />
  {#if selected}
    <span class="flex items-center gap-1.5 text-sm/5 text-zinc-500 dark:text-zinc-400">
      <StatusDot tone={selected.online ? "emerald" : "neutral"} />{selected.online ? "Online" : "Offline"}
    </span>
  {/if}
  {#if (!scope || selected) && (capabilities?.supports("/settings/workers") ?? true)}
    <ButtonLink
      size="sm"
      variant="text"
      href={selected
        ? `/settings/workers/${encodeURIComponent(selected.id)}#topic-agent-clis`
        : "/settings/workers#topic-agent-clis"}>Manage agent CLIs</ButtonLink
    >
  {/if}
</div>

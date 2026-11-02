<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import InstanceMark from "./InstanceMark.svelte";
  import { instanceName, statusAcross, statusOn, versionsOf } from "./instances.ts";

  /**
   * One instance in the list: mark, label, version and status line; on one worker a switch turns it on or off there,
   * in "All workers" a count says where it runs. The row selects the instance (the detail opens beside or, on
   * phones, instead of the list).
   */
  let {
    instance,
    worker,
    selected,
    busy = false,
    onselect,
    ontoggle,
  }: {
    instance: ui.ProviderInstance;
    /** The scope's worker; undefined = all workers. */
    worker: ui.Worker | undefined;
    selected: boolean;
    busy?: boolean;
    onselect: () => void;
    ontoggle: (enabled: boolean) => void;
  } = $props();

  const on = $derived(worker ? instance.workers.find((w) => w.workerId === worker.id) : undefined);
  const status = $derived(worker ? statusOn(on, worker.online) : statusAcross(instance));
  const version = $derived(versionsOf(instance, worker?.id));
  const running = $derived(instance.workers.filter((w) => w.enabled).length);
</script>

<div class="relative flex items-center gap-3 px-3 py-2.5 has-[button[aria-current]]:bg-zinc-950/4 dark:has-[button[aria-current]]:bg-white/6">
  <InstanceMark {instance} />
  <div class="min-w-0 flex-1">
    <button type="button" class="flex w-full min-w-0 items-baseline gap-2 text-left focus-ring after:absolute after:inset-0" aria-current={selected || undefined} onclick={onselect}>
      <span class="truncate text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{instanceName(instance)}</span>
      {#if version}<span class="shrink-0 font-mono text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{version}</span>{/if}
    </button>
    <p class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 dark:text-zinc-400">
      <StatusDot tone={status.tone} /><span class="truncate">{status.label}</span>
    </p>
  </div>
  <div class="relative shrink-0">
    {#if worker}
      <Switch
        name="instance-{instance.id}-on"
        label="{instanceName(instance)} on {worker.name}"
        checked={on?.enabled ?? false}
        disabled={busy}
        onchange={ontoggle}
      />
    {:else}
      <Badge>{instance.allWorkers ? "All" : `${running}/${instance.workers.length}`}</Badge>
    {/if}
  </div>
</div>

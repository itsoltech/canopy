<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import InstanceMark from "./InstanceMark.svelte";
  import { instanceName, statusAcross, statusOn, versionsOf } from "./instances.ts";
  import StatusLine from "./StatusLine.svelte";

  /**
   * One instance in the list: mark, label, version and status line; on one worker a switch turns it on or off there,
   * in "All workers" the switch controls its worker assignment. The row selects the instance (the detail opens beside or, on
   * phones, instead of the list).
   */
  let {
    instance,
    worker,
    selected,
    busy = false,
    onselect,
    ontoggle,
    class: className,
  }: {
    instance: ui.ProviderInstance;
    /** The scope's worker; undefined = all workers. */
    worker: ui.Worker | undefined;
    selected: boolean;
    busy?: boolean;
    onselect: () => void;
    ontoggle: (enabled: boolean) => void;
    class?: ClassValue;
  } = $props();

  const on = $derived(worker ? instance.workers.find((w) => w.workerId === worker.id) : undefined);
  const status = $derived(worker ? statusOn(on, worker.online) : statusAcross(instance));
  const version = $derived(versionsOf(instance, worker?.id));

  const enabled = $derived(
    worker ? (on?.enabled ?? false) : instance.allWorkers || instance.workers.some((w) => w.enabled),
  );
</script>

<div
  class={[
    "relative flex min-h-14 items-center gap-2 px-2.5 py-2 has-[button[aria-current]]:bg-zinc-950/4 dark:has-[button[aria-current]]:bg-white/6",
    className,
  ]}
>
  <InstanceMark {instance} />
  <div class="min-w-0 flex-1">
    <div class="flex min-w-0 items-baseline gap-2">
      <button
        type="button"
        class="block w-full min-w-0 truncate text-left text-base/6 font-medium text-zinc-950 focus-ring after:absolute after:inset-0 sm:text-sm/6 dark:text-white"
        aria-current={selected || undefined}
        onclick={onselect}
      >
        {instanceName(instance)}
      </button>
      {#if version}<span
          class="max-w-20 shrink-0 truncate font-mono text-xs/5 text-zinc-500 dark:text-zinc-400"
          title={version}
        >
          {version}
        </span>{/if}
    </div>
    <div class="flex min-w-0 items-center gap-2">
      <StatusLine {status} class="min-w-0 flex-1 text-sm/5 text-zinc-500 dark:text-zinc-400" />
    </div>
  </div>
  <div class="relative shrink-0">
    <Switch
      name="instance-{instance.id}-on"
      label="{instanceName(instance)} on {worker?.name ?? 'all workers'}"
      checked={enabled}
      disabled={busy}
      onchange={ontoggle}
    />
  </div>
</div>

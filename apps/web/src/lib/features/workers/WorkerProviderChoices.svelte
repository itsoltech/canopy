<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { ui } from "@canopy/contracts";
  import { onMount } from "svelte";
  import { decode } from "#lib/shared/wire.ts";
  import { requestJson } from "#lib/shared/http.ts";
  import { harnessName, instanceName, providerCall, statusOn } from "#lib/features/providers/instances.ts";
  import InstanceMark from "#lib/features/providers/InstanceMark.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";

  let {
    workerId,
    busy = $bindable(false),
    class: className,
  }: { workerId: string; busy?: boolean; class?: ClassValue } = $props();

  let instances = $state.raw<ui.ProviderInstance[]>([]);
  let error = $state("");
  let loaded = $state(false);

  onMount(() => {
    void load();
  });

  async function load() {
    try {
      instances = decode(ui.ListProviderInstancesResponseSchema, await requestJson("GET", "/api/providers")).instances;
      loaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load provider instances";
    }
  }

  async function toggle(instance: ui.ProviderInstance, enabled: boolean) {
    busy = true;
    error = "";

    try {
      await providerCall("worker", { harness: instance.harness, id: instance.id, workerId, enabled });
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not save provider choice";
      await load();
    } finally {
      busy = false;
    }
  }
</script>

<div class={["grid gap-3", className]}>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    Turn on the instances this machine should use. Device logins stay on the machine. You can change these later in
    Providers.
  </p>
  <div class="divide-y divide-zinc-950/5 dark:divide-white/10">
    {#each instances as instance (`${instance.harness}:${instance.id}`)}
      {@const on = instance.workers.find((w) => w.workerId === workerId)}
      <div class="flex items-center gap-3 py-3">
        <InstanceMark {instance} />
        <div class="min-w-0 flex-1 text-base/6 sm:text-sm/6">
          <p class="font-medium">{harnessName(instance.harness)} · {instanceName(instance)}</p>
          <p class="text-zinc-500 dark:text-zinc-400">{statusOn(on, true).label}</p>
        </div>
        <div class="shrink-0">
          <Switch
            name={`instance-${instance.harness}-${instance.id}`}
            label={`Enable ${harnessName(instance.harness)} ${instanceName(instance)}`}
            checked={on?.enabled ?? false}
            disabled={busy}
            onchange={(checked) => void toggle(instance, checked)}
          />
        </div>
      </div>
    {:else}<p class="py-3 text-base/6 text-zinc-500 sm:text-sm/6">
        {loaded ? "No provider instances yet. Add them in Settings → Providers." : "Loading provider instances…"}
      </p>{/each}
  </div>
</div>

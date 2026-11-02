<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Select from "#lib/shared/ui/Select.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";

  /**
   * Where the Providers page applies changes (T3 "Applying settings on"): all workers (the global definition, and
   * which workers run an instance) or one worker (on/off there, its overrides, its status). Workers show name and
   * host, else a short id.
   */
  let { workers, scope = $bindable(), class: className }: { workers: readonly ui.Worker[]; scope: string | undefined; class?: ClassValue } = $props();
  const selected = $derived(workers.find((w) => w.id === scope));
  const where = (w: ui.Worker) => w.hostname || w.id.slice(-8);
</script>

<div class={["flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-zinc-950/2.5 px-3 py-2 dark:bg-white/2.5", className]}>
  <label for="provider-scope" class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-400">Applying settings on</label>
  <Select id="provider-scope" name="provider-scope" bind:value={() => scope ?? "", (next: string) => (scope = next || undefined)} class="min-w-0 flex-1 basis-40 sm:max-w-xs"
    options={[{ value: "", label: "All workers" }, ...workers.map((worker) => ({ value: worker.id, label: worker.name, description: `${where(worker)}${worker.online ? "" : " · Offline"}` }))]} />
  {#if selected}
    <span class="flex items-center gap-1.5 text-sm/5 text-zinc-500 dark:text-zinc-400">
      <StatusDot tone={selected.online ? "emerald" : "neutral"} />{selected.online ? "Online" : "Offline"}
    </span>
  {/if}
</div>

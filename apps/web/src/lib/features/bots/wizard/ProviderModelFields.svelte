<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { untrack } from "svelte";
  import ModelPicker from "#lib/features/models/ModelPicker.svelte";
  import EffortPicker from "#lib/features/models/EffortPicker.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import type { ModelOption } from "#lib/features/models/catalog.ts";
  import ChoiceGrid from "./ChoiceGrid.svelte";
  import type { BotProviderInstance } from "./draft.ts";

  let { instances, instanceId = $bindable(""), option = $bindable<ModelOption | undefined>(undefined), effort = $bindable<string | undefined>(undefined), disabled = false, class: className }: {
    instances: readonly BotProviderInstance[]; instanceId?: string; option?: ModelOption | undefined; effort?: string | undefined; disabled?: boolean; class?: ClassValue;
  } = $props();
  let modelOpen = $state(false);
  let effortOpen = $state(false);
  const choices = $derived(instances.map((i) => ({ value: i.id, label: i.name, provider: i.provider })));
  const instance = $derived(instances.find((i) => i.id === instanceId));

  // Availability can change while the dialog is open. Keep the selection inside the supplied catalog.
  $effect(() => {
    const available = instances;
    const id = instanceId;
    untrack(() => {
      if (!available.some((i) => i.id === id)) instanceId = available.find((i) => i.models.length > 0)?.id ?? available[0]?.id ?? "";
    });
  });
  $effect(() => {
    const models = instance?.models ?? [];
    const selected = option;
    if (!selected || !models.some((m) => m.key === selected.key)) {
      option = models.find((m) => m.isDefault) ?? models[0];
      effort = undefined;
    } else if (models.find((m) => m.key === selected.key) !== selected) {
      option = models.find((m) => m.key === selected.key);
    }
  });
  $effect(() => {
    const supported = option?.efforts ?? [];
    if (effort && !supported.some((e) => e.id === effort)) effort = undefined;
  });
</script>

<div class={["grid gap-3 border-t border-zinc-950/10 pt-5 dark:border-white/10", className]}>
  <h3 class="text-base font-medium sm:text-sm">Provider instance</h3>
  {#if choices.length > 0}
    <ChoiceGrid label="Provider instance" options={choices} value={instanceId} {disabled} class="grid-cols-2" onchange={(v) => { instanceId = v; option = undefined; effort = undefined; modelOpen = false; effortOpen = false; }}>
      {#snippet children(choice, selected)}
        <div class={["flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-base/6 sm:text-sm/6", selected && "ring-1 ring-zinc-950/30 dark:ring-white/40"]}>
          <ProviderIcon provider={choice.provider} /><span class="truncate">{choice.label}</span>
        </div>
      {/snippet}
    </ChoiceGrid>
    {#if instance && option}
      <div class="grid gap-1.5">
        <p class="text-base/6 font-medium sm:text-sm/6">Model & reasoning</p>
        <!-- The pickers own their positioning/padding; the wrapper controls layout. -->
        <div class="flex min-h-11 min-w-0 flex-wrap items-center gap-1" inert={disabled || undefined}>
          <ModelPicker bind:open={modelOpen} options={instance.models} value={option.key} allowCustom={false} onselect={(next) => { option = next; effort = undefined; }} />
          {#if option.efforts.length > 0}
            <EffortPicker bind:open={effortOpen} bind:value={effort} {option} onmodel={() => (modelOpen = true)} />
          {/if}
        </div>
      </div>
    {:else}
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">No models are available for this instance.</p>
    {/if}
  {:else}
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">No provider instances are available. Connect a provider to create a bot.</p>
  {/if}
</div>

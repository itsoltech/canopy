<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ModelOption } from "./catalog.ts";
  import EffortPicker from "./EffortPicker.svelte";
  import { useModelCatalog } from "./model-catalog.svelte.ts";
  import ModelPicker from "./ModelPicker.svelte";
  import SpeedPicker from "./SpeedPicker.svelte";
  import { supportedServiceTier } from "./service-tier.ts";

  /**
   * The composer's model and effort pills, wired together: the effort pill names the effort in force, the
   * effort popover's model line opens the model picker. A model without efforts has no effort pill. A
   * chosen effort the new model does not support falls back to that model's default. The chosen option
   * stays listed even when `options` lacks it (a custom model id). The picker refreshes the worker's
   * model list (`workerId`). Shared by the new-thread and the thread composer and the thread's defaults.
   */
  let {
    options,
    option = $bindable(),
    effort = $bindable(),
    serviceTier = $bindable(),
    inheritedServiceTier,
    showSpeed = false,
    inherited,
    automaticEffort = false,
    workerId,
    allowCustom = true,
    preferFavorites = false,
    adaptive = false,
    class: className,
  }: {
    options: readonly ModelOption[];
    option?: ModelOption | undefined;
    /** Chosen effort id; undefined = the default. */
    effort?: string | undefined;
    serviceTier?: string | undefined;
    inheritedServiceTier?: string | undefined;
    /** Enable only when the caller persists and sends the speed choice. */
    showSpeed?: boolean;
    /** Effort that applies when none is chosen (a thread's default). */
    inherited?: string | undefined;
    /** Unset effort picks a low supported level for habit checks. */
    automaticEffort?: boolean;
    /** Worker whose catalog the options come from. */
    workerId?: string | undefined;
    allowCustom?: boolean;
    /** Open on favorites when choosing the agent of a new thread. */
    preferFavorites?: boolean;
    /** Composer controls collapse their labels as their available width shrinks. */
    adaptive?: boolean;
    class?: ClassValue;
  } = $props();

  const models = useModelCatalog();
  let modelOpen = $state(false);
  let effortOpen = $state(false);

  const listed = $derived.by(() => {
    const current = option;

    return current && !options.some((o) => o.key === current.key) ? [...options, current] : options;
  });

  function select(next: ModelOption) {
    const nextServiceTier = supportedServiceTier(next, serviceTier);

    option = next;

    if (effort && !next.efforts.some((e) => e.id === effort)) effort = undefined;

    if (showSpeed) serviceTier = nextServiceTier;
  }
</script>

<span class={["flex items-center gap-1", adaptive ? "@container/model-controls min-w-21" : "min-w-0", className]}>
  <span class="flex max-w-48 min-w-0 shrink items-center">
    <ModelPicker
      bind:open={modelOpen}
      options={listed}
      value={option?.key}
      catalog={workerId ? models.of(workerId) : undefined}
      {allowCustom}
      {preferFavorites}
      {adaptive}
      notice={workerId ? models.errors.get(workerId) : undefined}
      refreshing={workerId ? models.refreshing.has(workerId) : false}
      onrefresh={workerId ? () => void models.refresh(workerId) : undefined}
      onselect={select}
      class="max-w-full"
    />
  </span>
  {#if option && option.efforts.length > 0}
    <span class="flex shrink-0 items-center">
      <EffortPicker
        bind:open={effortOpen}
        bind:value={effort}
        {option}
        {inherited}
        automatic={automaticEffort}
        {adaptive}
        onmodel={() => (modelOpen = true)}
      />
    </span>
  {/if}
  {#if showSpeed && option && (option.serviceTiers.length > 0 || serviceTier || inheritedServiceTier)}
    <span class="flex shrink-0 items-center">
      <SpeedPicker bind:value={serviceTier} {option} inherited={inheritedServiceTier} {adaptive} />
    </span>
  {/if}
</span>

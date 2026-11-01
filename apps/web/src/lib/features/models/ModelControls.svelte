<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { effortLevel, type ModelOption } from "./catalog.ts";
  import EffortPicker from "./EffortPicker.svelte";
  import { useModelCatalog } from "./model-catalog.svelte.ts";
  import ModelPicker from "./ModelPicker.svelte";

  /**
   * The composer's model and effort pills, wired together: the model pill shows the chosen effort, the
   * effort popover's model line opens the model picker. A model without efforts has no effort pill. A
   * chosen effort the new model does not support falls back to that model's default. The chosen option
   * stays listed even when `options` lacks it (a custom model id). The picker refreshes the worker's
   * model list (`workerId`). Shared by the new-thread and the thread composer and the thread's defaults.
   */
  let {
    options,
    option = $bindable(),
    effort = $bindable(),
    inherited,
    workerId,
    allowCustom = true,
    class: className,
  }: {
    options: readonly ModelOption[];
    option?: ModelOption | undefined;
    /** Chosen effort id; undefined = the default. */
    effort?: string | undefined;
    /** Effort that applies when none is chosen (a thread's default). */
    inherited?: string | undefined;
    /** Worker whose catalog the options come from. */
    workerId?: string | undefined;
    allowCustom?: boolean;
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
    option = next;
    if (effort && !next.efforts.some((e) => e.id === effort)) effort = undefined;
  }
</script>

<span class={["flex min-w-0 items-center gap-1", className]}>
  <ModelPicker
    bind:open={modelOpen}
    options={listed}
    value={option?.key}
    effort={effort ? effortLevel(effort).label : undefined}
    catalog={workerId ? models.of(workerId) : undefined}
    {allowCustom}
    notice={workerId ? models.errors.get(workerId) : undefined}
    refreshing={workerId ? models.refreshing.has(workerId) : false}
    onrefresh={workerId ? () => void models.refresh(workerId) : undefined}
    onselect={select}
    class="shrink"
  />
  {#if option && option.efforts.length > 0}
    <EffortPicker bind:open={effortOpen} bind:value={effort} {option} {inherited} onmodel={() => (modelOpen = true)} class="shrink-0" />
  {/if}
</span>

<script lang="ts">
  import { effortLevel, type ModelOption } from "./catalog.ts";
  import EffortPicker from "./EffortPicker.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  /**
   * The composer's model and effort pills, wired together: the model pill shows the chosen effort, the
   * effort popover's model line opens the model picker. A chosen effort the new model does not support
   * falls back to that model's default. The chosen option stays listed even when `options` lacks it
   * (a custom model id). Shared by the new-thread and the thread composer.
   */
  let {
    options,
    option = $bindable(),
    effort = $bindable(),
    allowCustom = true,
    notice,
  }: {
    options: readonly ModelOption[];
    option?: ModelOption | undefined;
    /** Chosen effort id; undefined = the model's default. */
    effort?: string | undefined;
    allowCustom?: boolean;
    notice?: string | undefined;
  } = $props();

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

<ModelPicker
  bind:open={modelOpen}
  options={listed}
  value={option?.key}
  effort={effort ? effortLevel(effort).label : undefined}
  {allowCustom}
  {notice}
  onselect={select}
  class="shrink"
/>
{#if option && option.efforts.length > 0}
  <EffortPicker bind:open={effortOpen} bind:value={effort} {option} onmodel={() => (modelOpen = true)} class="shrink-0" />
{/if}

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import Slider from "#lib/shared/ui/Slider.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { effortLevel, type ModelOption } from "./catalog.ts";
  import ProviderIcon from "./ProviderIcon.svelte";

  /**
   * Reasoning effort (ChatGPT-style): a pill ("Select effort" until you choose; then just its icon, the
   * model pill shows the effort) opens a compact popover — the effort's name, the model under it (opens
   * the model picker), a reset to the model's default, and a slider over the model's supported efforts.
   * `value` undefined = the model's default.
   */
  let {
    option,
    value = $bindable(),
    open = $bindable(false),
    onmodel,
    class: className,
  }: {
    option: ModelOption;
    value?: string | undefined;
    open?: boolean;
    /** Open the model picker (the model line in the popover). */
    onmodel: () => void;
    class?: ClassValue;
  } = $props();

  const steps = $derived(option.efforts.map((e) => ({ value: e.id, label: e.short })));
  const effective = $derived(value ?? option.defaultEffort ?? option.efforts[0]?.id);
  const level = $derived(effective ? effortLevel(effective) : undefined);
  const fallback = $derived(option.defaultEffort ? effortLevel(option.defaultEffort).label : undefined);
</script>

<Popover bind:open label="Reasoning effort" placement="top-start" class="w-[min(20rem,calc(100vw-1rem))]">
  {#snippet trigger(props)}
    {#if value}
      <PillButton {...props} class={["pl-1.5", className]} aria-label="Reasoning effort: {level?.label}" {@attach tooltip(`Effort: ${level?.label}`)}>
        <Icon name="light-bulb" class="size-3.5 fill-zinc-500 dark:fill-zinc-400" />
      </PillButton>
    {:else}
      <PillButton {...props} class={className}>Select effort</PillButton>
    {/if}
  {/snippet}

  <div class="grid gap-4 p-4">
    <div class="flex items-start gap-3">
      <div class="grid min-w-0 flex-1 gap-0.5">
        <p class="text-lg/7 font-medium text-zinc-950 dark:text-white" aria-live="polite">{level?.label ?? "Default"}</p>
        <button
          type="button"
          class="-ml-1 flex min-w-0 items-center gap-1.5 justify-self-start rounded-md px-1 text-left text-base/6 text-zinc-500 focus-ring hover:text-zinc-950 sm:text-sm/5 dark:text-zinc-400 dark:hover:text-white"
          onclick={() => {
            open = false;
            onmodel();
          }}
        >
          <ProviderIcon provider={option.provider} class="size-3.5" />
          <span class="truncate">{option.name}</span>
          <Icon name="chevron-right" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
        </button>
      </div>
      <IconButton
        icon="arrow-uturn-left"
        size="sm"
        label={fallback ? `Reset to the model's default (${fallback})` : "Reset to the model's default"}
        disabled={!value}
        onclick={(event) => {
          value = undefined;
          // The button disables itself: keep focus in the popover, on the slider.
          event.currentTarget.closest("[popover]")?.querySelector<HTMLElement>("[role=slider]")?.focus();
        }}
      />
    </div>
    <Slider {steps} label="Reasoning effort" value={effective} onchange={(next) => (value = next)} autofocus />
  </div>
</Popover>
